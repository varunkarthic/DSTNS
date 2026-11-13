// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng's checkpoints (engine 3.8.0, core-ng 0.8.0): its own capture and rewind, generated from core-legacy's
// (Core/core-legacy/src/physics.cpp) with every expression unchanged, sharing only the interface (dstns/physics.hpp).
// dstns_timeline_ng seeks forward, back across checkpoints and forward again on both engines and requires the same
// state at every stop.
#include "dstns/core-ng/physics.hpp"

#include <algorithm>
#include <iterator>

namespace dstns::core_ng {
using physics::Checkpoint;

void capture_checkpoint(physics::TimelineContext& ctx) {
    Checkpoint checkpoint{ctx.virtual_s, ctx.graph.node_states(), ctx.graph.edge_states(), ctx.news_size(), ctx.next_news_id, ctx.events, ctx.congestion};
    const auto position = std::lower_bound(ctx.checkpoints.begin(), ctx.checkpoints.end(), ctx.virtual_s, [](const Checkpoint& value, auto time) {
        return value.virtual_s < time;
    });
    if (position != ctx.checkpoints.end() && position->virtual_s == ctx.virtual_s) {
        *position = std::move(checkpoint);
    } else {
        ctx.checkpoints.insert(position, std::move(checkpoint));
    }
}

void rewind_to_checkpoint(physics::TimelineContext& ctx, std::uint32_t target) {
    auto it = std::upper_bound(ctx.checkpoints.begin(), ctx.checkpoints.end(), target, [](auto t, const Checkpoint& c) {
        return t < c.virtual_s;
    });
    if (it != ctx.checkpoints.begin()) --it;
    // Operator edge overrides stand until they are undone, as signal overrides
    // and surges do; a checkpoint taken before one was made must not erase it.
    struct ManualEdge { double speed, capacity; bool closed; };
    std::vector<ManualEdge> manual;
    manual.reserve(ctx.graph.edge_states().size());
    for (const auto& es : ctx.graph.edge_states())
        manual.push_back({es.manual_speed_multiplier, es.manual_capacity_multiplier, es.manual_closed});
    ctx.graph.reset_dynamic();
    ctx.virtual_s = 0;
    if (it != ctx.checkpoints.end()) {
        ctx.virtual_s = it->virtual_s;
        for (std::size_t i = 0; i < it->nodes.size(); ++i) ctx.graph.node_state(NodeId{static_cast<std::uint32_t>(i)}) = it->nodes[i];
        for (std::size_t i = 0; i < it->edges.size(); ++i) ctx.graph.edge_state(EdgeId{static_cast<std::uint32_t>(i)}) = it->edges[i];
        if (ctx.news_size() > it->news_size) ctx.truncate_news(it->news_size);
        ctx.next_news_id = it->next_news_id;
        ctx.events = it->events; ctx.congestion = it->congestion;
        ctx.checkpoints.erase(std::next(it), ctx.checkpoints.end());
    }
    for (std::size_t i = 0; i < manual.size() && i < ctx.graph.edge_states().size(); ++i) {
        auto& es = ctx.graph.edge_state(EdgeId{static_cast<std::uint32_t>(i)});
        es.manual_speed_multiplier = manual[i].speed;
        es.manual_capacity_multiplier = manual[i].capacity;
        es.manual_closed = manual[i].closed;
    }
}

} // namespace dstns::core_ng
