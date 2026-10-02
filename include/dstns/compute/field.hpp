// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// Structured-grid fields: the second kind of compute workload, beside the
// road network. Water on a terrain model, rain fields, and later the wind and
// pressure of an atmospheric model are fields on a uniform grid, advanced by
// stencil kernels many steps at a time. The kernels are defined once in
// shaders/include/dstns_fields.h for every backend, like the physics step,
// and a GPU solver keeps the field on the device across iterations.
//
// The first kernel is diffusion. It is the pattern later solvers follow: a
// reference on the CPU, the same arithmetic in a shader, a solver that batches
// iterations into one submission, and an equivalence test between them.

#include "dstns/compute/backend.hpp"
#include "dstns/compute/options.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace dstns::compute {

/// A scalar field on a uniform grid: width x height cells, row major.
struct Field2D {
    std::uint32_t width{}, height{};
    std::vector<std::uint32_t> cells;
};

/// The reference: `iterations` diffusion steps on the CPU (rate in Q16).
void diffuse(Field2D& field, std::uint32_t rate_q16, std::uint32_t iterations);

class FieldSolver {
public:
    virtual ~FieldSolver() = default;
    /// Put a field on the device. Its buffers are kept for later calls.
    virtual void load(const Field2D& field) = 0;
    /// `iterations` diffusion steps in one submission, ping-ponging on the device.
    virtual void diffuse(std::uint32_t rate_q16, std::uint32_t iterations) = 0;
    [[nodiscard]] virtual Field2D read() = 0;
    [[nodiscard]] virtual std::string device() const = 0;
};

/// A field solver on the Vulkan device the options select; nullptr with
/// `reason` set when there is none.
[[nodiscard]] std::unique_ptr<FieldSolver> create_vulkan_field_solver(const ComputeOptions& options, const LogSink& log, std::string& reason);

} // namespace dstns::compute
