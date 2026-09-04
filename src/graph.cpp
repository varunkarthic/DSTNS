#include "dstns/graph.hpp"

#include <algorithm>
#include <cmath>
#include <queue>
#include <stdexcept>

namespace dstns {

const char* to_string(RoadClass v) { switch(v){case RoadClass::Motorway:return "motorway";case RoadClass::Primary:return "primary";case RoadClass::Secondary:return "secondary";case RoadClass::Tertiary:return "tertiary";case RoadClass::Residential:return "residential";case RoadClass::Service:return "service";} return "residential"; }
const char* to_string(BuildingType v) { switch(v){case BuildingType::School:return "school";case BuildingType::Office:return "office";case BuildingType::Mall:return "mall";case BuildingType::Store:return "store";} return "store"; }

double point_distance(const Point& a,const Point& b){ return std::hypot(a.x_m-b.x_m,a.y_m-b.y_m); }
double wendland_c2(double d,double r){ if(r<=0||d>=r)return 0; const auto q=std::max(0.0,d/r); const auto t=1-q; return t*t*t*t*(1+4*q); }
double temporal_beta(std::uint32_t p,const TimeWindow& w){ if(p<w.start_ppm||p>w.end_ppm||w.end_ppm<=w.start_ppm)return 0; const auto z=double(p-w.start_ppm)/double(w.end_ppm-w.start_ppm); if(z<=0||z>=1)return 0; const double a=w.rise_power,b=w.fall_power,zp=a/(a+b); return std::pow(z,a)*std::pow(1-z,b)/(std::pow(zp,a)*std::pow(1-zp,b)); }

GraphStore::GraphStore(Scenario scenario):scenario_(std::move(scenario)),node_dynamic_(scenario_.nodes.size()),edge_dynamic_(scenario_.edges.size()),outgoing_(scenario_.nodes.size()){
    for(const auto&e:scenario_.edges){ if(e.id.value>=edge_dynamic_.size()||e.from.value>=outgoing_.size())throw std::invalid_argument("non-contiguous canonical IDs"); outgoing_[e.from.value].push_back(e.id); auto&s=edge_dynamic_[e.id.value];s.effective_capacity_vph=e.base_capacity_vph;s.effective_speed_mps=e.free_speed_mps;s.mean_speed_mps=e.free_speed_mps; }
    for(auto& a:outgoing_)std::sort(a.begin(),a.end(),[](auto x,auto y){return x.value<y.value;});
}
const NodeStatic& GraphStore::node(NodeId id)const{if(id.value>=scenario_.nodes.size())throw std::out_of_range("unknown node");return scenario_.nodes[id.value];}
const EdgeStatic& GraphStore::edge(EdgeId id)const{if(id.value>=scenario_.edges.size())throw std::out_of_range("unknown edge");return scenario_.edges[id.value];}
NodeDynamic& GraphStore::node_state(NodeId id){if(id.value>=node_dynamic_.size())throw std::out_of_range("unknown node");return node_dynamic_[id.value];}
EdgeDynamic& GraphStore::edge_state(EdgeId id){if(id.value>=edge_dynamic_.size())throw std::out_of_range("unknown edge");return edge_dynamic_[id.value];}
std::span<const EdgeId> GraphStore::outgoing(NodeId id)const{if(id.value>=outgoing_.size())throw std::out_of_range("unknown node");return outgoing_[id.value];}
void GraphStore::commit(){++state_revision_;for(auto&n:node_dynamic_)n.state_revision=state_revision_;for(auto&e:edge_dynamic_)e.state_revision=state_revision_;}
void GraphStore::reset_dynamic(){node_dynamic_.assign(node_dynamic_.size(),{});edge_dynamic_.assign(edge_dynamic_.size(),{});for(const auto&e:scenario_.edges){auto&s=edge_dynamic_[e.id.value];s.effective_capacity_vph=e.base_capacity_vph;s.effective_speed_mps=e.free_speed_mps;s.mean_speed_mps=e.free_speed_mps;}state_revision_=0;}

RouteResult RoutePlanner::route(NodeId source,NodeId destination)const{
    if(source.value>=graph_.nodes().size()||destination.value>=graph_.nodes().size())return{};
    if(source==destination)return{true,0,{}};
    constexpr auto inf=std::numeric_limits<std::uint64_t>::max(); const auto n=graph_.nodes().size();
    std::vector<std::uint64_t> cost(n,inf);std::vector<EdgeId> parent(n,EdgeId{std::numeric_limits<std::uint32_t>::max()});
    struct Q{std::uint64_t f,g;NodeId n;};struct C{bool operator()(const Q&a,const Q&b)const{return a.f!=b.f?a.f>b.f:(a.g!=b.g?a.g>b.g:a.n.value>b.n.value);}};std::priority_queue<Q,std::vector<Q>,C>q;
    const auto heuristic=[&](NodeId x){const auto d=point_distance(graph_.node(x).position,graph_.node(destination).position);return static_cast<std::uint64_t>(std::llround(d/33.33*1000));};
    cost[source.value]=0;q.push({heuristic(source),0,source});
    while(!q.empty()){auto cur=q.top();q.pop();if(cur.g!=cost[cur.n.value])continue;if(cur.n==destination)break;for(auto eid:graph_.outgoing(cur.n)){const auto&e=graph_.edge(eid);const auto&s=graph_.edge_states()[eid.value];if(s.closed)continue;const auto speed=std::max(0.1,s.effective_speed_mps);const auto w=static_cast<std::uint64_t>(std::llround(e.length_m/speed*1000));const auto ng=cur.g+w;if(ng<cost[e.to.value]||(ng==cost[e.to.value]&&eid.value<parent[e.to.value].value)){cost[e.to.value]=ng;parent[e.to.value]=eid;q.push({ng+heuristic(e.to),ng,e.to});}}}
    if(cost[destination.value]==inf)return{};std::vector<EdgeId> edges;for(auto at=destination;at!=source;){const auto e=parent[at.value];if(e.value==std::numeric_limits<std::uint32_t>::max())return{};edges.push_back(e);at=graph_.edge(e).from;}std::reverse(edges.begin(),edges.end());return{true,cost[destination.value],std::move(edges)};
}
} // namespace dstns
