// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng's checkpoints (engine 3.8.0, core-ng 0.8.0): its own capture and rewind, generated from core-legacy's
// (Core/core-legacy/src/physics.cpp) with every expression unchanged, sharing only the interface (dstns/physics.hpp).
// dstns_timeline_ng seeks forward, back across checkpoints and forward again on both engines and requires the same
// state at every stop.
#include "dstns/core-ng/physics.hpp"

#include <zlib.h>

#include <algorithm>
#include <cstring>
#include <iterator>
#include <stdexcept>
#include <type_traits>

namespace dstns::core_ng {
using physics::Checkpoint;

namespace {
static_assert(std::is_trivially_copyable_v<NodeDynamic> && std::is_trivially_copyable_v<EdgeDynamic>, "packed as bytes");

// Release 8 (engine 3.9.0): a day keeps 96 checkpoints, each a copy of every node's and edge's state (184 bytes an
// edge), which for a large city came to gigabytes. core-ng keeps them deflated instead: the uncompressed length, then
// the deflated counts and bytes of the nodes and the edges. Lossless, so a restored checkpoint is the same to the last
// bit (dstns_timeline_ng).
void pack(Checkpoint& checkpoint) {
    const std::uint64_t counts[2] = {checkpoint.nodes.size(), checkpoint.edges.size()};
    std::string raw(sizeof counts + counts[0] * sizeof(NodeDynamic) + counts[1] * sizeof(EdgeDynamic), '\0');
    std::memcpy(raw.data(), counts, sizeof counts);
    std::memcpy(raw.data() + sizeof counts, checkpoint.nodes.data(), counts[0] * sizeof(NodeDynamic));
    std::memcpy(raw.data() + sizeof counts + counts[0] * sizeof(NodeDynamic), checkpoint.edges.data(), counts[1] * sizeof(EdgeDynamic));
    uLongf size = compressBound(static_cast<uLong>(raw.size()));
    std::string deflated(size, '\0');
    if (compress2(reinterpret_cast<Bytef*>(deflated.data()), &size, reinterpret_cast<const Bytef*>(raw.data()), static_cast<uLong>(raw.size()), Z_BEST_SPEED) != Z_OK)
        return;  // Kept as it is: correct, only larger.
    deflated.resize(size);
    const std::uint64_t length = raw.size();
    checkpoint.packed.assign(reinterpret_cast<const char*>(&length), sizeof length);
    checkpoint.packed += deflated;
    checkpoint.packed.shrink_to_fit();
    std::vector<NodeDynamic>().swap(checkpoint.nodes);
    std::vector<EdgeDynamic>().swap(checkpoint.edges);
}

std::pair<std::vector<NodeDynamic>, std::vector<EdgeDynamic>> unpack(const Checkpoint& checkpoint) {
    if (checkpoint.packed.empty()) return {checkpoint.nodes, checkpoint.edges};
    std::uint64_t length = 0;
    std::memcpy(&length, checkpoint.packed.data(), sizeof length);
    std::string raw(length, '\0');
    uLongf size = static_cast<uLongf>(length);
    if (uncompress(reinterpret_cast<Bytef*>(raw.data()), &size, reinterpret_cast<const Bytef*>(checkpoint.packed.data() + sizeof length), static_cast<uLong>(checkpoint.packed.size() - sizeof length)) != Z_OK || size != length)
        throw std::runtime_error("a checkpoint could not be unpacked");
    std::uint64_t counts[2];
    std::memcpy(counts, raw.data(), sizeof counts);
    std::vector<NodeDynamic> nodes(counts[0]);
    std::vector<EdgeDynamic> edges(counts[1]);
    std::memcpy(nodes.data(), raw.data() + sizeof counts, counts[0] * sizeof(NodeDynamic));
    std::memcpy(edges.data(), raw.data() + sizeof counts + counts[0] * sizeof(NodeDynamic), counts[1] * sizeof(EdgeDynamic));
    return {std::move(nodes), std::move(edges)};
}
} // namespace

void capture_checkpoint(physics::TimelineContext& ctx) {
    Checkpoint checkpoint{ctx.virtual_s, ctx.graph.node_states(), ctx.graph.edge_states(), ctx.news_size(), ctx.next_news_id, ctx.events, ctx.congestion, {}};
    pack(checkpoint);
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
        const auto [nodes, edges] = unpack(*it);
        for (std::size_t i = 0; i < nodes.size(); ++i) ctx.graph.node_state(NodeId{static_cast<std::uint32_t>(i)}) = nodes[i];
        for (std::size_t i = 0; i < edges.size(); ++i) ctx.graph.edge_state(EdgeId{static_cast<std::uint32_t>(i)}) = edges[i];
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
