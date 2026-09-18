#include "dstns/events.hpp"
#include "dstns/graph.hpp"
#include <algorithm>
#include <cmath>

namespace dstns {
namespace {
nlohmann::json event_json(const ScheduledEvent& e,bool future) {
    return {{"id",e.sequence},{"virtual_s",e.time},{"entity",e.entity},{"category",e.category},{"description",e.description},{"status",future?"scheduled":"executed"},{"phase",e.phase},{"value",e.value}};
}
constexpr const char* phases[]{"A green","A amber","All red","B green","B amber","All red"};
}
void EventRuntime::observe(ScheduledEvent e){e.sequence=next_sequence_++;++executed_count;history_.push_back(std::move(e));if(history_.size()>2000)history_.pop_front();}
void EventRuntime::push(ScheduledEvent e) { e.sequence=next_sequence_++; queue_.push(std::move(e)); }
void EventRuntime::initialize(const Scenario& s) {
    *this=EventRuntime{};
    signal_by_node_.assign(s.nodes.size(),-1);
    for(std::size_t i=0;i<s.signals.size();++i) {
        const auto& p=s.signals[i]; auto remainder=std::uint32_t(p.offset_s); std::uint32_t phase=0;
        while(remainder>=p.phases_s[phase]){remainder-=p.phases_s[phase];++phase;}
        signals.push_back({phase,p.phases_s[phase]-remainder,-static_cast<std::int64_t>(remainder)});
        signal_by_node_[p.node.value]=static_cast<int>(i);
        push({signals.back().next_transition,static_cast<std::uint32_t>(i),(phase+1)%6,0,"signals","Signal "+std::to_string(p.node.value)+" → "+phases[(phase+1)%6],0});
    }
    demand.assign(s.features.size(),1.0);
    DeterministicRng rng(s.seed.derive("demand"));
    for(std::size_t i=0;i<s.features.size();++i) {
        const auto& f=s.features[i];if(!s.config.buildings||!f.demand_type)continue;
        std::vector<std::pair<std::uint32_t,std::uint32_t>> windows;
        std::string label;
        if(f.category=="hospital") { demand[i]=1.15; windows={{0,86400}};label="Hospital baseline demand"; }
        else if(*f.demand_type==BuildingType::School) {if(s.config.day==0)windows={{27900,33300},{52200,57600}};label="School arrival / departure";}
        else if(*f.demand_type==BuildingType::Office) {if(s.config.day==0)windows={{29700,36000},{61200,70200}};label="Office commute";}
        else if(*f.demand_type==BuildingType::Mall) {windows={{43200,50400},{64800,77400}};label="Retail peak";}
        else {windows={{39600,72000}};label="Commercial demand";}
        const auto identity=Seed128::parse("0x"+sha256(f.id).substr(0,16)).low;
        const double peak=1.4+0.5*rng.uniform01({RngDomain::Buildings,identity,0,0})+(s.config.day==1?.15:0);
        for(auto [start,end]:windows) {
            push({start,static_cast<std::uint32_t>(i),0,0,"demand",label+" · "+(f.name.empty()?f.id:f.name),1+(peak-1)*.5});
            push({start+(end-start)/3,static_cast<std::uint32_t>(i),0,0,"demand",label+" peak · "+(f.name.empty()?f.id:f.name),peak});
            push({end,static_cast<std::uint32_t>(i),0,0,"demand","Demand returns to normal · "+(f.name.empty()?f.id:f.name),1.0});
        }
    }
    // Precompute only spatial neighbours once; no geometric scans in the physics loop.
    std::map<std::pair<int,int>,std::vector<std::uint32_t>> cells;
    for(std::size_t i=0;i<s.features.size();++i) if(s.features[i].demand_type) {
        const auto& p=s.features[i].center;cells[{int(std::floor(p.x_m/400)),int(std::floor(p.y_m/400))}].push_back(static_cast<std::uint32_t>(i));
    }
    auto neighbours = std::make_shared<EdgeFeatures>(s.edges.size());
    edge_demand_.assign(s.edges.size(), 0);
    for(const auto& e:s.edges) {
        const auto& a=s.nodes[e.from.value].position;const auto& b=s.nodes[e.to.value].position;
        Point mid{(a.x_m+b.x_m)/2,(a.y_m+b.y_m)/2,0,0};int x=int(std::floor(mid.x_m/400)),y=int(std::floor(mid.y_m/400));
        for(int dx=-1;dx<=1;++dx)for(int dy=-1;dy<=1;++dy) {
            auto it=cells.find({x+dx,y+dy});if(it==cells.end())continue;
            for(auto f:it->second){const double weight=wendland_c2(point_distance(mid,s.features[f].center),400);if(weight>0)(*neighbours)[e.id.value].push_back({f,weight});}
        }
    }
    edge_features_ = std::move(neighbours);
    for(std::size_t i=0;i<s.incidents.size();++i){const auto& e=s.incidents[i];push({e.start_virtual_s,static_cast<std::uint32_t>(i),0,0,"incidents",e.description,1});push({e.end_virtual_s,static_cast<std::uint32_t>(i),0,0,"incidents","Incident resolved",0});}
    for(std::size_t i=0;i<s.dws_events.size();++i){const auto& e=s.dws_events[i];push({std::uint32_t(std::uint64_t(e.start_ppm)*86400/1000000),static_cast<std::uint32_t>(i),0,0,"weather","Rain region begins",e.intensity});push({std::uint32_t(std::uint64_t(e.end_ppm)*86400/1000000),static_cast<std::uint32_t>(i),0,0,"weather","Rain region ends",0});}
    (void)advance(s,0);
}
std::vector<ScheduledEvent> EventRuntime::advance(const Scenario& s,std::uint32_t time) {
    std::vector<ScheduledEvent> important;
    bool demand_changed = false;
    while(!queue_.empty() && queue_.top().time<=time) {
        auto e=queue_.top();queue_.pop();++executed_count;
        if(e.category=="signals") {
            auto& state=signals[e.entity];const auto& plan=s.signals[e.entity];state.phase=e.phase;state.phase_started=e.time;state.next_transition=e.time+plan.phases_s[e.phase];
            if(state.next_transition<=86400)push({state.next_transition,e.entity,(e.phase+1)%6,0,"signals","Signal "+std::to_string(plan.node.value)+" → "+phases[(e.phase+1)%6],0});
        } else if(e.category=="demand") {demand[e.entity]=e.value;demand_changed=true;important.push_back(e);}
        history_.push_back(e);if(history_.size()>2000)history_.pop_front();
    }
    if (demand_changed) {
        for (std::size_t i=0;i<edge_demand_.size();++i) {
            double effect=0;
            for (auto [id,weight] : (*edge_features_)[i]) effect += weight*(demand[id]-1);
            edge_demand_[i]=std::min(2.0,effect);
        }
    }
    return important;
}
nlohmann::json EventRuntime::inspect(bool future,const std::string& category,std::size_t offset,std::size_t limit) const {
    nlohmann::json items=nlohmann::json::array();std::size_t total=0;
    auto consume=[&](const auto& e){if(category!="all"&&e.category!=category)return;if(total>=offset&&items.size()<limit)items.push_back(event_json(e,future));++total;};
    if(future){auto copy=queue_;while(!copy.empty()){consume(copy.top());copy.pop();}}else for(auto it=history_.rbegin();it!=history_.rend();++it)consume(*it);
    return {{"items",items},{"total",total},{"offset",offset},{"limit",limit},{"history_retention",2000},{"executed_count",executed_count},{"pending_count",queue_.size()}};
}
nlohmann::json EventRuntime::signal_json(const Scenario& s,std::uint32_t time) const {
    auto items=nlohmann::json::array();
    for(std::size_t i=0;i<signals.size();++i){const auto& state=signals[i];const auto& p=s.signals[i];
        const char* a=state.phase==0?"green":state.phase==1?"amber":"red";
        const char* b=state.phase==3?"green":state.phase==4?"amber":"red";
        items.push_back({{"signal_id",p.node.value},{"junction_id",p.node.value},{"phase",state.phase},{"phase_name",phases[state.phase]},{"group_a",a},{"group_b",b},{"phase_started_at",state.phase_started},{"time_in_phase",static_cast<std::int64_t>(time)-state.phase_started},{"next_transition_at",state.next_transition},{"cycle_length",p.cycle_s},{"phases_s",p.phases_s},{"enabled",s.config.signals}});
    }return items;
}
nlohmann::json EventRuntime::demand_json(const Scenario& s) const {
    auto items=nlohmann::json::array();for(std::size_t i=0;i<demand.size();++i)if(s.features[i].demand_type)items.push_back({{"feature_id",s.features[i].id},{"multiplier",s.config.buildings?demand[i]:1.0},{"radius_m",400},{"active",s.config.buildings&&demand[i]>1}});return items;
}
double EventRuntime::signal_multiplier(const Scenario& s,const EdgeStatic& e) const {
    const int idx=signal_by_node_[e.to.value];if(idx<0||!s.config.signals)return 1;
    const auto& a=s.nodes[e.from.value].position;const auto& b=s.nodes[e.to.value].position;
    const bool group_a=std::abs(b.y_m-a.y_m)>=std::abs(b.x_m-a.x_m);const auto phase=signals[idx].phase;
    if((group_a&&phase==0)||(!group_a&&phase==3))return 1;
    if((group_a&&phase==1)||(!group_a&&phase==4))return .4;
    return .08;
}
double EventRuntime::demand_effect(EdgeId edge) const {return edge_demand_[edge.value];}
std::vector<std::string> EventRuntime::demand_causes(const Scenario& s,EdgeId edge) const {std::vector<std::string> ids;for(auto [id,w]:(*edge_features_)[edge.value])if(w*(demand[id]-1)>.01)ids.push_back(s.features[id].id);return ids;}
void CongestionTracker::update(const Scenario& s,const std::vector<EdgeDynamic>& edges,std::uint32_t time,std::uint32_t dt){
    double sum=0,weights=0;for(const auto& e:s.edges)if(is_source_direction_allowed(e)){const double w=e.length_m*e.lanes;sum+=w*edges[e.id.value].congestion;weights+=w;}
    current=weights>0?std::clamp(100*sum/weights,0.0,100.0):0;
    const double alpha=1-std::exp(-double(dt)/900.0);average=samples.empty()?current:alpha*current+(1-alpha)*average;
    if(samples.empty()||time%60==0)samples.push_back({time,current,average});
}
nlohmann::json CongestionTracker::json()const{auto history=nlohmann::json::array();for(auto& s:samples)history.push_back({{"virtual_s",s.time},{"current",s.current},{"average",s.average}});return {{"current",current},{"average",average},{"delta",current-average},{"ema_tau_virtual_s",900},{"history",history},{"source","DSTNS aggregate traffic model"},{"weighting","edge length × lanes; traversable directions only"}};}
}
