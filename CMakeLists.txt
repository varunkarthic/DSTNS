# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

cmake_minimum_required(VERSION 3.22)
project(dstns VERSION 2.2.0 LANGUAGES CXX)

option(DSTNS_BUILD_TESTS "Build DSTNS tests" ON)
option(DSTNS_ENABLE_SANITIZERS "Enable address/undefined sanitizers" OFF)
option(DSTNS_ENABLE_VULKAN "Build the Vulkan compute backend" ON)
option(DSTNS_VULKAN_REQUIRED "Fail configuration if the Vulkan backend cannot be built" OFF)
option(DSTNS_BUILD_SHADERS "Compile the compute shaders from GLSL when a shader compiler is installed" ON)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include(FetchContent)
set(FETCHCONTENT_QUIET OFF)
FetchContent_Declare(json URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  URL_HASH SHA256=42f6e95cad6ec532fd372391373363b62a14af6d771056dbfc86160e6dfff7aa)
FetchContent_Declare(httplib URL https://github.com/yhirose/cpp-httplib/archive/refs/tags/v0.28.0.tar.gz)
set(HTTPLIB_USE_BROTLI_IF_AVAILABLE OFF CACHE BOOL "Use gzip for bounded dynamic response latency" FORCE)
set(HTTPLIB_REQUIRE_ZLIB ON CACHE BOOL "Compress large topology and state responses" FORCE)
# The server speaks plain HTTP (TLS belongs to the gateway) and compresses with
# gzip only. Left to themselves, httplib links OpenSSL and zstd whenever it finds
# them, which ties the build to whichever versions happen to be installed: a
# Homebrew OpenSSL upgrade breaks a configured tree, and Debian's libzstd-dev
# fails to configure with CMake 3.25.
set(HTTPLIB_USE_OPENSSL_IF_AVAILABLE OFF CACHE BOOL "No TLS in the engine" FORCE)
set(HTTPLIB_USE_ZSTD_IF_AVAILABLE OFF CACHE BOOL "gzip only" FORCE)
set(HTTPLIB_USE_CERTS_FROM_MACOSX_KEYCHAIN OFF CACHE BOOL "No TLS in the engine" FORCE)
FetchContent_MakeAvailable(json httplib)
find_package(SQLite3 REQUIRED)
find_package(Threads REQUIRED)
find_package(ZLIB REQUIRED)
if(TARGET SQLite3::SQLite3)
  set(DSTNS_SQLITE_TARGET SQLite3::SQLite3)
else()
  set(DSTNS_SQLITE_TARGET SQLite::SQLite3)
endif()

add_library(dstns_core
  src/rng.cpp src/calendar.cpp src/utf8.cpp src/graph.cpp src/asb.cpp src/demand.cpp src/geo.cpp src/osm.cpp src/osm_fetch.cpp src/scenario.cpp src/engine.cpp src/events.cpp src/logging.cpp src/api.cpp src/sumo_bridge.cpp
  src/compute/state.cpp src/compute/options.cpp src/compute/cpu_backend.cpp src/compute/dispatcher.cpp
  src/compute/synthetic.cpp src/compute/field.cpp
  src/environment/png.cpp src/environment/terrain.cpp src/environment/solar.cpp src/environment/runtime.cpp)
target_include_directories(dstns_core PUBLIC include shaders/include)

# --- Vulkan compute backend ------------------------------------------------------
# Vulkan is loaded at run time (volk), so the binary has no link-time dependency
# on a Vulkan library and runs, on the CPU backend, where none is installed.
# The headers and volk are pinned and fetched like the other dependencies; the
# shaders are compiled to SPIR-V here when glslang or glslc is available, and
# otherwise taken from shaders/spirv/, which is committed for that purpose.
set(DSTNS_SHADER_NAMES edge_step field_diffusion node_step scatter self_test) # name order
set(DSTNS_VULKAN_BUILT OFF)
if(DSTNS_ENABLE_VULKAN)
  find_program(DSTNS_GLSLANG NAMES glslangValidator glslang)
  find_program(DSTNS_GLSLC NAMES glslc)
  set(dstns_compile_shaders OFF)
  if(DSTNS_BUILD_SHADERS AND (DSTNS_GLSLANG OR DSTNS_GLSLC))
    set(dstns_compile_shaders ON)
  endif()
  # Without a compiler, the committed SPIR-V must have been built from the
  # current sources; stale SPIR-V would compute a different step than the CPU.
  set(dstns_spirv_problem "")
  if(NOT dstns_compile_shaders)
    file(READ "${CMAKE_SOURCE_DIR}/shaders/include/dstns_physics.h" dstns_physics_text)
    file(READ "${CMAKE_SOURCE_DIR}/shaders/include/dstns_glsl.h" dstns_prelude_text)
    file(READ "${CMAKE_SOURCE_DIR}/shaders/include/dstns_fields.h" dstns_fields_text)
    if(EXISTS "${CMAKE_SOURCE_DIR}/shaders/spirv/manifest.txt")
      file(STRINGS "${CMAKE_SOURCE_DIR}/shaders/spirv/manifest.txt" dstns_manifest REGEX "^[a-z_]+ [0-9a-f]+$")
    else()
      set(dstns_manifest "")
    endif()
    foreach(shader IN LISTS DSTNS_SHADER_NAMES)
      file(READ "${CMAKE_SOURCE_DIR}/shaders/${shader}.comp" dstns_source_text)
      string(SHA256 dstns_hash "${dstns_source_text}${dstns_prelude_text}${dstns_physics_text}${dstns_fields_text}")
      if(NOT EXISTS "${CMAKE_SOURCE_DIR}/shaders/spirv/${shader}.spv" OR NOT "${shader} ${dstns_hash}" IN_LIST dstns_manifest)
        set(dstns_spirv_problem "shaders/spirv/${shader}.spv is missing or older than its source, and no shader compiler (glslangValidator or glslc) was found")
      endif()
    endforeach()
  endif()
  if(dstns_spirv_problem)
    if(DSTNS_VULKAN_REQUIRED)
      message(FATAL_ERROR "Vulkan backend: ${dstns_spirv_problem}")
    endif()
    message(WARNING "Vulkan backend disabled: ${dstns_spirv_problem}. DSTNS builds with the CPU backend only.")
  else()
    enable_language(C)
    FetchContent_Declare(vulkan_headers
      URL https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/vulkan-sdk-1.4.357.0.tar.gz
      URL_HASH SHA256=e87dce08116151f6b6d7de6b6faf41498e87e6cf848ff16fa3bd5402190ad4a3)
    # volk is compiled directly (one C file); its own CMake project would look
    # for an installed Vulkan SDK, which is exactly what DSTNS avoids needing.
    FetchContent_Declare(volk
      URL https://github.com/zeux/volk/archive/refs/tags/vulkan-sdk-1.4.357.0.tar.gz
      URL_HASH SHA256=6400c7b23e24d17e4f04bac49b55b06c4e87677d33398e90344743ec73560ca6
      SOURCE_SUBDIR dstns-no-cmake)
    FetchContent_MakeAvailable(vulkan_headers volk)

    set(dstns_spirv_files "")
    foreach(shader IN LISTS DSTNS_SHADER_NAMES)
      set(source "${CMAKE_SOURCE_DIR}/shaders/${shader}.comp")
      if(dstns_compile_shaders)
        set(output "${CMAKE_BINARY_DIR}/shaders/${shader}.spv")
        if(DSTNS_GLSLANG)
          set(compile ${DSTNS_GLSLANG} -V --target-env vulkan1.2 "$<$<CONFIG:Debug>:-g>" -I${CMAKE_SOURCE_DIR}/shaders/include -o ${output} ${source})
        else()
          set(compile ${DSTNS_GLSLC} --target-env=vulkan1.2 "$<IF:$<CONFIG:Debug>,-g,-O>" -I${CMAKE_SOURCE_DIR}/shaders/include -o ${output} ${source})
        endif()
        add_custom_command(OUTPUT ${output}
          COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_BINARY_DIR}/shaders
          COMMAND ${compile}
          DEPENDS ${source} ${CMAKE_SOURCE_DIR}/shaders/include/dstns_physics.h ${CMAKE_SOURCE_DIR}/shaders/include/dstns_glsl.h
                  ${CMAKE_SOURCE_DIR}/shaders/include/dstns_fields.h
          COMMENT "Compiling compute shader ${shader}"
          COMMAND_EXPAND_LISTS VERBATIM)
      else()
        set(output "${CMAKE_SOURCE_DIR}/shaders/spirv/${shader}.spv")
      endif()
      list(APPEND dstns_spirv_files ${output})
    endforeach()
    if(dstns_compile_shaders)
      if(DSTNS_GLSLANG)
        set(dstns_compiler ${DSTNS_GLSLANG})
      else()
        set(dstns_compiler ${DSTNS_GLSLC})
      endif()
      execute_process(COMMAND ${dstns_compiler} --version OUTPUT_VARIABLE dstns_compiler_version ERROR_QUIET)
      string(REGEX MATCH "[^\n]*" dstns_compiler_version "${dstns_compiler_version}")
      string(REGEX REPLACE "[\\\"]" "" dstns_compiler_version "${dstns_compiler_version}")
      if(NOT dstns_compiler_version)
        set(dstns_compiler_version "glslang")
      endif()
    else()
      set(dstns_compiler_version "precompiled")
    endif()
    string(REPLACE ";" "|" dstns_names_arg "${DSTNS_SHADER_NAMES}")
    string(REPLACE ";" "|" dstns_spirv_arg "${dstns_spirv_files}")
    set(dstns_embedded "${CMAKE_BINARY_DIR}/generated/dstns_spirv.cpp")
    add_custom_command(OUTPUT ${dstns_embedded}
      COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_BINARY_DIR}/generated
      COMMAND ${CMAKE_COMMAND} "-DNAMES=${dstns_names_arg}" "-DSPIRV=${dstns_spirv_arg}" "-DSOURCE_DIR=${CMAKE_SOURCE_DIR}"
              "-DCOMPILER=${dstns_compiler_version}" "-DOUTPUT=${dstns_embedded}" -P ${CMAKE_SOURCE_DIR}/cmake/EmbedSpirv.cmake
      DEPENDS ${dstns_spirv_files} ${CMAKE_SOURCE_DIR}/cmake/EmbedSpirv.cmake
              ${CMAKE_SOURCE_DIR}/shaders/include/dstns_physics.h ${CMAKE_SOURCE_DIR}/shaders/include/dstns_glsl.h
              ${CMAKE_SOURCE_DIR}/shaders/include/dstns_fields.h
      COMMENT "Embedding the compute shaders"
      VERBATIM)
    add_custom_target(dstns_shaders DEPENDS ${dstns_embedded})
    if(dstns_compile_shaders)
      add_custom_target(dstns_refresh_spirv
        COMMAND ${CMAKE_COMMAND} "-DNAMES=${dstns_names_arg}" "-DSOURCE_DIR=${CMAKE_SOURCE_DIR}" "-DBINARY_DIR=${CMAKE_BINARY_DIR}"
                "-DCOMPILER=${dstns_compiler_version}" -P ${CMAKE_SOURCE_DIR}/cmake/RefreshSpirv.cmake
        DEPENDS ${dstns_spirv_files}
        COMMENT "Refreshing the committed SPIR-V in shaders/spirv/"
        VERBATIM)
    endif()

    set(dstns_volk_source "${volk_SOURCE_DIR}/volk.c")
    set_source_files_properties(${dstns_volk_source} PROPERTIES COMPILE_OPTIONS "-w")
    set(dstns_vulkan_sources
      src/vulkan/loader.cpp src/vulkan/context.cpp src/vulkan/memory.cpp src/vulkan/pipeline.cpp
      src/vulkan/executor.cpp src/vulkan/gpu.cpp src/vulkan/backend.cpp src/vulkan/field.cpp src/vulkan/diagnostics.cpp)
    # Vulkan structures are initialised as {sType} with the remaining members
    # value-initialised: the idiom the API is designed for.
    set_source_files_properties(${dstns_vulkan_sources} PROPERTIES COMPILE_OPTIONS "-Wno-missing-field-initializers")
    target_sources(dstns_core PRIVATE ${dstns_vulkan_sources} ${dstns_embedded} ${dstns_volk_source})
    add_dependencies(dstns_core dstns_shaders)
    target_include_directories(dstns_core PRIVATE src/vulkan ${volk_SOURCE_DIR})
    target_compile_definitions(dstns_core PRIVATE VK_NO_PROTOTYPES)
    target_link_libraries(dstns_core PRIVATE Vulkan::Headers ${CMAKE_DL_LIBS})
    set(DSTNS_VULKAN_BUILT ON)
    message(STATUS "Vulkan backend: enabled (shaders ${dstns_compiler_version})")
  endif()
endif()
if(NOT DSTNS_VULKAN_BUILT)
  if(DSTNS_ENABLE_VULKAN AND DSTNS_VULKAN_REQUIRED)
    message(FATAL_ERROR "The Vulkan backend was required but cannot be built")
  endif()
  target_sources(dstns_core PRIVATE src/vulkan/unavailable.cpp)
  message(STATUS "Vulkan backend: not built; DSTNS uses the CPU backend")
endif()
target_compile_definitions(dstns_core PUBLIC DSTNS_VULKAN_BUILT=$<BOOL:${DSTNS_VULKAN_BUILT}>)
target_link_libraries(dstns_core PUBLIC nlohmann_json::nlohmann_json ${DSTNS_SQLITE_TARGET} Threads::Threads httplib::httplib ZLIB::ZLIB)
if(APPLE)
  target_link_libraries(dstns_core PUBLIC "-framework CoreFoundation" "-framework CFNetwork")
endif()
target_compile_definitions(dstns_core PUBLIC DSTNS_VERSION="${PROJECT_VERSION}")
target_compile_options(dstns_core PRIVATE -Wall -Wextra -Wpedantic -Wshadow)

if(DSTNS_ENABLE_SANITIZERS AND CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(dstns_core PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_link_options(dstns_core PUBLIC -fsanitize=address,undefined)
endif()

add_executable(dstns_server apps/dstns_server/main.cpp)
target_compile_definitions(dstns_server PRIVATE DSTNS_VERSION="${PROJECT_VERSION}")
target_link_libraries(dstns_server PRIVATE dstns_core)
add_executable(dstns_scenario_export tools/scenario-inspect/main.cpp)
target_link_libraries(dstns_scenario_export PRIVATE dstns_core)
add_executable(dstns_road_index tools/road-index/main.cpp)
target_link_libraries(dstns_road_index PRIVATE dstns_core)
add_executable(dstns_replay_verify tools/replay-verify/main.cpp)
target_link_libraries(dstns_replay_verify PRIVATE dstns_core)
add_executable(dstns_benchmark tools/benchmark/main.cpp tools/benchmark/compute.cpp)
target_link_libraries(dstns_benchmark PRIVATE dstns_core)

if(DSTNS_BUILD_TESTS)
  enable_testing()
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  foreach(smoke loading termination hardening)
    add_test(NAME dstns_http_${smoke}
      COMMAND ${CMAKE_COMMAND} -E env "DSTNS_SERVER=$<TARGET_FILE:dstns_server>"
        ${Python3_EXECUTABLE} "${CMAKE_SOURCE_DIR}/tests/api/${smoke}_smoke.py")
    set_tests_properties(dstns_http_${smoke} PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" TIMEOUT 45)
  endforeach()
  add_executable(dstns_tests tests/unit/test_main.cpp)
  target_link_libraries(dstns_tests PRIVATE dstns_core)
  target_compile_options(dstns_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_unit_tests COMMAND dstns_tests)
  set_tests_properties(dstns_unit_tests PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_calendar_tests tests/unit/calendar_tests.cpp)
  target_link_libraries(dstns_calendar_tests PRIVATE dstns_core)
  target_compile_options(dstns_calendar_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_calendar COMMAND dstns_calendar_tests)
  set_tests_properties(dstns_calendar PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_modern_tests tests/unit/modernization_tests.cpp)
  target_link_libraries(dstns_modern_tests PRIVATE dstns_core)
  target_compile_options(dstns_modern_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_modernization COMMAND dstns_modern_tests)
  set_tests_properties(dstns_modernization PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_demand_tests tests/unit/demand_tests.cpp)
  target_link_libraries(dstns_demand_tests PRIVATE dstns_core)
  target_compile_options(dstns_demand_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_demand COMMAND dstns_demand_tests)
  set_tests_properties(dstns_demand PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_asb_tests tests/unit/asb_tests.cpp)
  target_link_libraries(dstns_asb_tests PRIVATE dstns_core)
  target_compile_options(dstns_asb_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_asb COMMAND dstns_asb_tests)
  set_tests_properties(dstns_asb PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_utf8_tests tests/unit/utf8_tests.cpp)
  target_link_libraries(dstns_utf8_tests PRIVATE dstns_core)
  target_compile_options(dstns_utf8_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_text_boundaries COMMAND dstns_utf8_tests)
  set_tests_properties(dstns_text_boundaries PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_map_tests tests/unit/map_sourcing_tests.cpp)
  target_link_libraries(dstns_map_tests PRIVATE dstns_core)
  target_compile_options(dstns_map_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_map_sourcing COMMAND dstns_map_tests)
  set_tests_properties(dstns_map_sourcing PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_loading_tests tests/unit/loading_tests.cpp)
  target_link_libraries(dstns_loading_tests PRIVATE dstns_core)
  target_compile_options(dstns_loading_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_loading_concurrency COMMAND dstns_loading_tests)
  set_tests_properties(dstns_loading_concurrency PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" TIMEOUT 20)

  add_executable(dstns_world_tests tests/unit/world_tests.cpp)
  target_link_libraries(dstns_world_tests PRIVATE dstns_core)
  target_compile_options(dstns_world_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_world_and_stepping COMMAND dstns_world_tests)
  set_tests_properties(dstns_world_and_stepping PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_prop_tests tests/property/property_tests.cpp)
  target_link_libraries(dstns_prop_tests PRIVATE dstns_core)
  target_compile_options(dstns_prop_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_property_invariants COMMAND dstns_prop_tests)
  set_tests_properties(dstns_property_invariants PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_rep_tests tests/replay/replay_tests.cpp)
  target_link_libraries(dstns_rep_tests PRIVATE dstns_core)
  target_compile_options(dstns_rep_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_replay_reproducibility COMMAND dstns_rep_tests)
  set_tests_properties(dstns_replay_reproducibility PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_compute_equivalence_tests tests/compute/backend_equivalence_tests.cpp)
  target_link_libraries(dstns_compute_equivalence_tests PRIVATE dstns_core)
  target_compile_options(dstns_compute_equivalence_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_compute_equivalence COMMAND dstns_compute_equivalence_tests)
  # 77: no usable Vulkan device on this machine; the CPU backend is still tested elsewhere.
  set_tests_properties(dstns_compute_equivalence PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" SKIP_RETURN_CODE 77 TIMEOUT 900)

  add_executable(dstns_engine_compute_tests tests/compute/engine_compute_tests.cpp)
  target_link_libraries(dstns_engine_compute_tests PRIVATE dstns_core)
  target_compile_options(dstns_engine_compute_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_engine_compute COMMAND dstns_engine_compute_tests)
  set_tests_properties(dstns_engine_compute PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" SKIP_RETURN_CODE 77 TIMEOUT 900)

  add_executable(dstns_field_tests tests/compute/field_tests.cpp)
  target_link_libraries(dstns_field_tests PRIVATE dstns_core)
  target_compile_options(dstns_field_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_compute_fields COMMAND dstns_field_tests)
  set_tests_properties(dstns_compute_fields PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" SKIP_RETURN_CODE 77 TIMEOUT 600)

  add_executable(dstns_terrain_tests tests/environment/terrain_tests.cpp)
  target_link_libraries(dstns_terrain_tests PRIVATE dstns_core)
  target_compile_options(dstns_terrain_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_terrain COMMAND dstns_terrain_tests)
  set_tests_properties(dstns_terrain PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_solar_tests tests/environment/solar_tests.cpp)
  target_link_libraries(dstns_solar_tests PRIVATE dstns_core)
  target_compile_options(dstns_solar_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_solar COMMAND dstns_solar_tests)
  set_tests_properties(dstns_solar PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_perf_tests tests/performance/perf_tests.cpp)
  target_link_libraries(dstns_perf_tests PRIVATE dstns_core)
  target_compile_options(dstns_perf_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_performance_smoke COMMAND dstns_perf_tests)
  set_tests_properties(dstns_performance_smoke PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  # Suites never reach the network for terrain: "auto" means flat for them.
  # A test that wants terrain names a source (a synthetic surface, or tiles it
  # plants in a private cache), which this does not override.
  get_property(dstns_all_tests DIRECTORY PROPERTY TESTS)
  set_property(TEST ${dstns_all_tests} APPEND PROPERTY ENVIRONMENT "DSTNS_DEM_SOURCE=flat")
endif()

install(TARGETS dstns_server dstns_scenario_export dstns_road_index dstns_replay_verify dstns_benchmark RUNTIME DESTINATION bin)

