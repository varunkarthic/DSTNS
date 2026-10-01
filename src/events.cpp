// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

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
    baseline_.assign(s.features.size(),1.0);
    scheduled_baseline_ = baseline_;
    factors_.assign(s.features.size(),{});
    kinds_.clear();kinds_.reserve(s.features.size());
    for(const auto& f:s.features)kinds_.push_back(classify_place(f));
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
        // Individual variation around the kind's profile: no two schools are
        // the same size, and the one on the arterial draws more than the one
        // on a cul-de-sac. Derived from the feature's identity, so it is part
        // of the scenario rather than of this run.
        const double character=0.8+0.45*rng.uniform01({RngDomain::Buildings,identity,0,0});
        const double peak=1.4+0.5*rng.uniform01({RngDomain::Buildings,identity,0,0})+(s.config.day==1?.15:0);
        // Real institutions do not all open on the same minute. Shift each
        // one's window by up to +/-20 minutes and vary its length, derived from
        // the feature's own identity so the stagger is deterministic.
        const double shift=(rng.uniform01({RngDomain::Buildings,identity,1,0})-0.5)*2400;
        const double stretch=0.8+0.4*rng.uniform01({RngDomain::Buildings,identity,2,0});
        const auto& display=f.name.empty()?f.id:f.name;
        for(auto [start,end]:windows) {
            const double centre=(start+end)/2.0+shift;
            const double half=((end-start)/2.0)*stretch;
            const double from=std::max(0.0,centre-half), to=std::min(86399.0,centre+half);
            if(to-from<60) continue;
            // Raised cosine from 1 up to peak and back, sampled in steps, so
            // demand rises and falls gradually instead of snapping between
            // three levels. The UI colours the multiplier directly, which makes
            // the visible progression white -> orange -> red -> orange -> white.
            constexpr int kSteps=8;
            for(int step=0;step<=kSteps;++step) {
                const double u=double(step)/kSteps;
                const auto at=static_cast<std::uint32_t>(from+(to-from)*u);
                // Sample the kind's own diurnal profile rather than imposing a
                // generic hump, so a pharmacy's evening rise and a school's
                // sharp run look as different as they are. The raised cosine
                // still shapes the window's shoulders, and character scales the
                // result to this particular building.
                const double shape=std::sin(3.141592653589793*u);
                const double profile=diurnal_demand(kinds_[i],double(at),s.config.day);
                const double blended=1.0+((profile-1.0)*character+(peak-1.0)*shape*shape)*0.5;
                const double value=std::clamp(blended,1.0,kDemandCeiling);
                const bool crest=step==kSteps/2;
                const bool done=step==kSteps;
                push({at,static_cast<std::uint32_t>(i),0,0,"demand",
                      done?("Demand returns to normal · "+display)
                          :(label+(crest?" peak · ":" · ")+display),
                      done?1.0:value});
            }
        }
    }
    // Precompute only spatial neighbours once; no geometric scans in the physics loop.
    std::map<std::pair<int,int>,std::vector<std::uint32_t>> cells;
    for(std::size_t i=0;i<s.features.size();++i) if(is_modelled(kinds_[i])) {
        const auto& p=s.features[i].center;cells[{int(std::floor(p.x_m/400)),int(std::floor(p.y_m/400))}].push_back(static_cast<std::uint32_t>(i));
    }
    auto edge_features_holder = std::make_shared<EdgeFeatures>(s.edges.size());
    edge_demand_.assign(s.edges.size(), 0);
    for(const auto& e:s.edges) {
        if(!is_source_direction_allowed(e))continue;
        const auto& a=s.nodes[e.from.value].position;const auto& b=s.nodes[e.to.value].position;
        Point mid{(a.x_m+b.x_m)/2,(a.y_m+b.y_m)/2,0,0};int x=int(std::floor(mid.x_m/400)),y=int(std::floor(mid.y_m/400));
        for(int dx=-1;dx<=1;++dx)for(int dy=-1;dy<=1;++dy) {
            auto it=cells.find({x+dx,y+dy});if(it==cells.end())continue;
            for(auto f:it->second){const double weight=wendland_c2(point_distance(mid,s.features[f].center),400);if(weight>0)(*edge_features_holder)[e.id.value].push_back({f,weight});}
        }
    }
    // Which places actually respond to conditions. Most of what a city maps is
    // an untagged building the model says nothing about; evaluating couplings
    // for those costs a tick's budget and returns 1.0 every time.
    responders_.clear();
    for(std::size_t i=0;i<s.features.size();++i)
        if(is_modelled(kinds_[i])||s.features[i].demand_type)responders_.push_back(static_cast<std::uint32_t>(i));

    // The inverse index: which edges each place draws from. Couplings read the
    // network around a place, so they need this direction. Built only for the
    // responders, and capped at the strongest kCouplingFanout edges each - the
    // kernel has already decided the rest contribute almost nothing.
    auto per_feature=std::make_shared<FeatureEdges>(s.features.size());
    {
        std::vector<bool> responds(s.features.size(),false);
        for(const auto f:responders_)responds[f]=true;
        for(std::size_t e=0;e<edge_features_holder->size();++e)
            for(auto [f,w]:(*edge_features_holder)[e])
                if(responds[f])(*per_feature)[f].push_back({static_cast<std::uint32_t>(e),w});
        for(auto& near:*per_feature){
            if(near.size()<=kCouplingFanout)continue;
            std::partial_sort(near.begin(),near.begin()+kCouplingFanout,near.end(),
                              [](const auto& a,const auto& b){
                                  if(a.second!=b.second)return a.second>b.second;
                                  return a.first<b.first; // deterministic tie-break
                              });
            near.resize(kCouplingFanout);
        }
    }

    // And which places are close enough to influence one another. A car park
    // follows the shops it serves; a stop follows what it serves.
    auto peers=std::make_shared<std::vector<std::vector<std::uint32_t>>>(s.features.size());
    for(std::size_t i=0;i<s.features.size();++i) {
        if(!is_modelled(kinds_[i]))continue;
        const auto& p=s.features[i].center;
        const int x=int(std::floor(p.x_m/400)),y=int(std::floor(p.y_m/400));
        for(int dx=-1;dx<=1;++dx)for(int dy=-1;dy<=1;++dy){
            auto it=cells.find({x+dx,y+dy});if(it==cells.end())continue;
            for(auto f:it->second){
                if(f==i)continue;
                if(point_distance(p,s.features[f].center)<=kCouplingRadiusM)
                    (*peers)[i].push_back(f);
            }
        }
        // Nearest first, capped: a place is influenced by its neighbours, not
        // by every shop in the district.
        auto& mine=(*peers)[i];
        if(mine.size()>kCouplingFanout){
            std::partial_sort(mine.begin(),mine.begin()+kCouplingFanout,mine.end(),
                              [&](std::uint32_t a,std::uint32_t b){
                                  const double da=point_distance(p,s.features[a].center);
                                  const double db=point_distance(p,s.features[b].center);
                                  if(da!=db)return da<db;
                                  return a<b; // deterministic tie-break
                              });
            mine.resize(kCouplingFanout);
        }
    }

    edge_features_ = edge_features_holder;
    feature_edges_ = std::move(per_feature);
    feature_peers_ = std::move(peers);
    edge_available_.resize(s.edges.size());
    for(const auto& e:s.edges) {
        edge_available_[e.id.value]=is_source_direction_allowed(e);
        edge_endpoints_.push_back({e.from,e.to});
    }
    feature_origins_.assign(s.features.size(),NodeId{});
    for(const auto i:responders_) {
        const auto& near=(*feature_edges_)[i];
        if(near.empty())continue;
        const auto best=std::max_element(near.begin(),near.end(),[](const auto& a,const auto& b){return a.second<b.second;});
        feature_origins_[i]=s.edges[best->first].from;
    }
    rebuild_delivery();
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
        } else if(e.category=="demand") {scheduled_baseline_[e.entity]=e.value;baseline_[e.entity]=e.value;demand[e.entity]=e.value;demand_changed=true;important.push_back(e);}
        history_.push_back(e);if(history_.size()>2000)history_.pop_front();
    }
    if (demand_changed) rebuild_edge_demand();
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
void EventRuntime::rebuild_delivery() {
    delivery_.assign(demand.size(),{});
    if(!feature_edges_)return;
    for(const auto i:responders_) {
        const auto& near=(*feature_edges_)[i];
        // The induced local graph has at most 24 edges. Traverse only open,
        // allowed directions, so a disconnected parallel road cannot receive
        // the displaced pressure merely because it is geographically close.
        std::vector<NodeId> reached{feature_origins_[i]};
        for(std::size_t round=0;round<near.size();++round) {
            bool added=false;
            for(auto [edge,weight]:near) {
                (void)weight;
                const auto [from,to]=edge_endpoints_[edge];
                if(edge_available_[edge] && std::find(reached.begin(),reached.end(),from)!=reached.end()
                    && std::find(reached.begin(),reached.end(),to)==reached.end()) {
                    reached.push_back(to);added=true;
                }
            }
            if(!added)break;
        }
        double total=0,open=0;
        for(auto [edge,w]:near) {
            total+=w;
            if(edge_available_[edge] && std::find(reached.begin(),reached.end(),edge_endpoints_[edge].first)!=reached.end())open+=w;
        }
        if(open<=0)continue;
        const double redistribution=std::min(3.0,total/open);
        for(auto [edge,w]:near)
            if(edge_available_[edge] && std::find(reached.begin(),reached.end(),edge_endpoints_[edge].first)!=reached.end())
                delivery_[i].push_back({edge,w*redistribution});
    }
}

void EventRuntime::rebuild_edge_demand() {
    std::fill(edge_demand_.begin(),edge_demand_.end(),0.0);
    for(const auto i:responders_)
        for(auto [edge,w]:delivery_[i])
            edge_demand_[edge]=std::min(2.0,edge_demand_[edge]+w*(demand[i]-1));
}

std::vector<DemandFactor> EventRuntime::demand_factors(std::size_t feature) const {
    return feature<factors_.size()?factors_[feature]:std::vector<DemandFactor>{};
}

void EventRuntime::recouple(const Scenario& s,const std::vector<EdgeDynamic>& edges,std::uint32_t time) {
    if(!s.config.buildings||!feature_edges_||demand.empty())return;
    bool network_changed=false;
    for(const auto& e:s.edges) {
        const bool available=is_source_direction_allowed(e)&&!edges[e.id.value].closed&&!edges[e.id.value].incident_closed;
        if(edge_available_[e.id.value]!=available)network_changed=true;
        edge_available_[e.id.value]=available;
    }

    // Pass one: read the network around each place. Everything a coupling needs
    // is already in the edge dynamics the operator is shown, so the model and
    // the display can never disagree about conditions.
    const std::size_t count=demand.size();
    std::vector<DemandContext> context(count);
    for(const auto i:responders_){
        const auto& near=(*feature_edges_)[i];
        if(near.empty())continue;
        double weight=0,rain=0,blocked=0,distress=0;
        for(auto [e,w]:near){
            const auto& d=edges[e];
            weight+=w;
            rain+=w*d.rainfall;
            if(d.closed||d.incident_closed)blocked+=w;
            distress=std::max(distress,std::max(d.flood,d.incident_closed?1.0:0.0));
        }
        if(weight<=0)continue;
        auto& c=context[i];
        c.rain=std::clamp(rain/weight,0.0,1.0);
        c.blocked_share=std::clamp(blocked/weight,0.0,1.0);
        c.distress=std::clamp(distress,0.0,1.0);
    }

    // Pass two: places pulling on other places. Read from the previous tick's
    // effective demand so the pull is a response, not a simultaneous equation -
    // a car park fills because the shops were busy, not at the same instant.
    if(feature_peers_){
        for(const auto i:responders_){
            const auto kind=kinds_[i];
            const bool wants_commercial=kind==PlaceKind::Parking;
            const bool wants_generators=kind==PlaceKind::BusStop;
            if(!wants_commercial&&!wants_generators)continue;
            double total=0;std::size_t n=0;
            for(const auto peer:(*feature_peers_)[i]){
                const auto peer_kind=kinds_[peer];
                if(wants_commercial&&!is_commercial(peer_kind))continue;
                if(wants_generators&&!is_generator(peer_kind))continue;
                total+=std::max(0.0,demand[peer]-1.0);++n;
            }
            if(!n)continue;
            if(wants_commercial)context[i].commercial_pull=total/double(n);
            else context[i].generator_pull=total/double(n);
        }
    }

    // Pass three: combine, and note why.
    bool changed=false;
    for(const auto i:responders_){
        factors_[i].clear();
        baseline_[i]=std::max(scheduled_baseline_[i],diurnal_demand(kinds_[i],time,s.config.day));
        const double next=couple_demand(kinds_[i],baseline_[i],context[i],&factors_[i]);
        if(std::fabs(next-demand[i])>1e-6)changed=true;
        demand[i]=next;
    }
    (void)count;
    if(network_changed)rebuild_delivery();
    if(changed||network_changed)rebuild_edge_demand();
}

nlohmann::json EventRuntime::demand_json(const Scenario& s) const {
    auto items=nlohmann::json::array();
    for(std::size_t i=0;i<demand.size();++i){
        const auto kind=i<kinds_.size()?kinds_[i]:PlaceKind::Other;
        if(!s.features[i].demand_type&&!is_modelled(kind))continue;
        auto reasons=nlohmann::json::array();
        if(i<factors_.size())for(const auto& f:factors_[i])reasons.push_back({{"cause",f.name},{"multiplier",f.multiplier}});
        items.push_back({{"feature_id",s.features[i].id},
                         {"kind",to_string(kind)},
                         {"multiplier",s.config.buildings?demand[i]:1.0},
                         {"baseline",s.config.buildings?baseline_[i]:1.0},
                         {"radius_m",400},
                         {"factors",reasons},
                         {"active",s.config.buildings&&demand[i]>1.01}});
    }
    return items;
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
