# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

cmake_minimum_required(VERSION 3.22)
project(dstns VERSION 3.10.0 LANGUAGES CXX)

set(DSTNS_REVISION "unknown" CACHE STRING "Source commit SHA")
set(DSTNS_BUILD_DATE "unknown" CACHE STRING "UTC image build timestamp")
set(DSTNS_CHANNEL "local" CACHE STRING "Release channel")
configure_file(Core/core-legacy/include/dstns/build_info.hpp.in generated/dstns/build_info.hpp @ONLY)

option(DSTNS_BUILD_TESTS "Build DSTNS tests" ON)
option(DSTNS_ENABLE_SANITIZERS "Enable address/undefined sanitizers" OFF)
option(DSTNS_TUNE_FOR_HOST "Tune code generation for this machine's CPU (-mcpu=native); the binary may not run on older CPUs" OFF)

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
# By default the server speaks plain HTTP (TLS belongs to the gateway, or to a build with
# DSTNS_TLS) and compresses with gzip only. Left to themselves, httplib links OpenSSL and zstd
# whenever it finds them, which ties the build to whichever versions happen to be installed: a
# Homebrew OpenSSL upgrade breaks a configured tree, and Debian's libzstd-dev fails to configure
# with CMake 3.25. So TLS is something to ask for.
option(DSTNS_TLS "Serve HTTPS with --tls-cert and --tls-key; needs OpenSSL to build" OFF)
if(DSTNS_TLS)
  set(HTTPLIB_REQUIRE_OPENSSL ON CACHE BOOL "TLS was asked for" FORCE)
else()
  set(HTTPLIB_USE_OPENSSL_IF_AVAILABLE OFF CACHE BOOL "No TLS in the engine" FORCE)
endif()
set(HTTPLIB_USE_ZSTD_IF_AVAILABLE OFF CACHE BOOL "gzip only" FORCE)
set(HTTPLIB_USE_CERTS_FROM_MACOSX_KEYCHAIN OFF CACHE BOOL "No TLS in the engine" FORCE)
FetchContent_MakeAvailable(json httplib)
find_package(SQLite3 REQUIRED)
# Maps come from Overpass over HTTPS, which the engine's own HTTP library does without TLS by design. On macOS, the
# system's libcurl, not whichever a package manager installed: it ties the build to no one's versions, and the
# downloader, which starts once per city, doesn't load a dozen libraries it never uses.
if(APPLE)
  execute_process(COMMAND xcrun --show-sdk-path OUTPUT_VARIABLE DSTNS_SDK OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
  find_library(DSTNS_SYSTEM_CURL curl PATHS "${CMAKE_OSX_SYSROOT}/usr/lib" "${DSTNS_SDK}/usr/lib" NO_DEFAULT_PATH REQUIRED)
  add_library(CURL::libcurl INTERFACE IMPORTED)
  set_target_properties(CURL::libcurl PROPERTIES INTERFACE_LINK_LIBRARIES "${DSTNS_SYSTEM_CURL}")
else()
  find_package(CURL REQUIRED)
endif()
find_package(Threads REQUIRED)
if(TARGET SQLite3::SQLite3)
  set(DSTNS_SQLITE_TARGET SQLite3::SQLite3)
else()
  set(DSTNS_SQLITE_TARGET SQLite::SQLite3)
endif()

add_library(dstns_core
  Core/core-legacy/src/rng.cpp Core/core-legacy/src/utf8.cpp Core/core-legacy/src/graph.cpp Core/core-legacy/src/asb.cpp Core/core-legacy/src/demand.cpp Core/core-legacy/src/geo.cpp Core/core-legacy/src/osm.cpp Core/core-legacy/src/osm_fetch.cpp Core/core-legacy/src/osm_download.cpp Core/core-legacy/src/scenario.cpp Core/core-legacy/src/engine.cpp Core/core-legacy/src/physics.cpp Core/core-legacy/src/events.cpp Core/core-legacy/src/logging.cpp Core/core-legacy/src/sumo_bridge.cpp
  Core/core-legacy/src/narrator.cpp Core/core-legacy/src/platform.cpp Core/core-legacy/src/next_world.cpp)
target_include_directories(dstns_core PUBLIC Core/core-legacy/include "${CMAKE_CURRENT_BINARY_DIR}/generated")
target_link_libraries(dstns_core PUBLIC nlohmann_json::nlohmann_json ${DSTNS_SQLITE_TARGET} Threads::Threads httplib::httplib CURL::libcurl)
if(APPLE)
  target_link_libraries(dstns_core PUBLIC "-framework CoreFoundation" "-framework CFNetwork")
endif()
# The HTTP library listens with a backlog of 5 by default: an observer, its applications and a burst of polls connect at
# once, and connections past the fifth would be dropped before a thread could take them.
target_compile_definitions(dstns_core PUBLIC DSTNS_VERSION="${PROJECT_VERSION}" CPPHTTPLIB_LISTEN_BACKLOG=128)
target_compile_options(dstns_core PRIVATE -Wall -Wextra -Wpedantic -Wshadow)

# Apple clang already targets apple-m1 (the baseline of every Apple silicon
# Mac) by default. Host tuning is opt-in: it only changes instruction selection
# and scheduling, never floating-point semantics, but the binary is then tied to
# CPUs at least as new as the build machine's.
if(DSTNS_TUNE_FOR_HOST AND CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(dstns_core PRIVATE -mcpu=native)
endif()

if(DSTNS_ENABLE_SANITIZERS AND CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(dstns_core PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_link_options(dstns_core PUBLIC -fsanitize=address,undefined)
endif()

# The daemons: watchers on threads of their own, and their queues. The message templates and the alerts are built in.
file(READ "${CMAKE_SOURCE_DIR}/Daemon/messages.json" DSTNS_DAEMON_MESSAGES)
file(READ "${CMAKE_SOURCE_DIR}/config/daemon-alerts.json" DSTNS_DAEMON_ALERTS)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/Daemon/messages.json" "${CMAKE_SOURCE_DIR}/config/daemon-alerts.json")
configure_file(Daemon/daemon_catalogue.hpp.in "${CMAKE_CURRENT_BINARY_DIR}/generated/dstns/daemon_catalogue.hpp" @ONLY)
add_library(dstns_daemon Daemon/src/gateway.cpp Daemon/src/handler.cpp Daemon/src/watchers.cpp Daemon/src/probe.cpp)
target_include_directories(dstns_daemon PUBLIC Daemon/include "${CMAKE_CURRENT_BINARY_DIR}/generated")
target_link_libraries(dstns_daemon PUBLIC nlohmann_json::nlohmann_json Threads::Threads)
target_compile_options(dstns_daemon PRIVATE -Wall -Wextra -Wpedantic -Wshadow)

# Fabric: the HTTP API over the core. Depends on the core; the core never on it.
add_library(dstns_fabric
  Fabric/src/api.cpp Fabric/src/support.cpp Fabric/src/guards.cpp Fabric/src/routes_static.cpp Fabric/src/routes_system.cpp
  Fabric/src/routes_playback.cpp Fabric/src/routes_world.cpp Fabric/src/routes_control.cpp Fabric/src/routes_view.cpp
  Fabric/src/routes_observation.cpp Fabric/src/operations.cpp Fabric/src/routes_daemon.cpp Fabric/src/routes_engine.cpp Fabric/src/gate.cpp
  Fabric/src/webfabric/routes.cpp Fabric/src/webfabric/registry.cpp)
target_include_directories(dstns_fabric PUBLIC Fabric/include PRIVATE Fabric/src)
target_link_libraries(dstns_fabric PUBLIC dstns_core dstns_daemon)
target_compile_options(dstns_fabric PRIVATE -Wall -Wextra -Wpedantic -Wshadow)

# core-ng: the next-generation engine, built beside core-legacy one module at a time.
add_library(dstns_core_ng Core/core-ng/src/selection.cpp Core/core-ng/src/lifecycle.cpp Core/core-ng/src/world.cpp
  Core/core-ng/src/compile.cpp Core/core-ng/src/network.cpp Core/core-ng/src/plans.cpp Core/core-ng/src/physics.cpp Core/core-ng/src/timeline.cpp)
target_include_directories(dstns_core_ng PUBLIC Core/core-ng/include)
target_link_libraries(dstns_core_ng PUBLIC dstns_core)
target_compile_options(dstns_core_ng PRIVATE -Wall -Wextra -Wpedantic -Wshadow -Werror)
# GCC 12 (the container's compiler) warns -Wrestrict on plain std::string concatenation in core-ng's news text, a known
# false positive (GCC bug 105329). Only that warning is turned off, and only for GCC.
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
  target_compile_options(dstns_core_ng PRIVATE -Wno-restrict)
endif()

add_executable(dstns_server Core/server/main.cpp Core/server/container.cpp)
target_compile_definitions(dstns_server PRIVATE DSTNS_VERSION="${PROJECT_VERSION}")
target_link_libraries(dstns_server PRIVATE dstns_fabric dstns_core_ng)
add_executable(dstns_scenario_export tools/scenario-inspect/main.cpp)
target_link_libraries(dstns_scenario_export PRIVATE dstns_core)
add_executable(dstns_road_index tools/road-index/main.cpp)
target_link_libraries(dstns_road_index PRIVATE dstns_core)
add_executable(dstns_replay_verify tools/replay-verify/main.cpp)
target_link_libraries(dstns_replay_verify PRIVATE dstns_core)
# Release engineering: image metadata, publishing, the image smoke test and licence headers. It needs no engine.
add_executable(dstns_release tools/release/main.cpp)
target_link_libraries(dstns_release PRIVATE nlohmann_json::nlohmann_json httplib::httplib)
target_compile_definitions(dstns_release PRIVATE DSTNS_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
if(APPLE)
  target_link_libraries(dstns_release PRIVATE "-framework CoreFoundation" "-framework CFNetwork")
endif()
add_executable(dstns_benchmark tools/benchmark/main.cpp)
target_link_libraries(dstns_benchmark PRIVATE dstns_core)

if(DSTNS_BUILD_TESTS)
  enable_testing()
  # The HTTP tests: each a program of its own, against a real server it starts on a port of its own.
  set(DSTNS_HTTP_TESTS api docs_coverage another_city termination loading fastboot hardening robustness fabric_contract narration observer_hold
    fabric_apps fabric_direction fabric_platform fabric_launch launcher_apps fetch_osm release dynamic_fastboot daemon long_jump engine_switch sumo_switch engine_gate)
  foreach(name ${DSTNS_HTTP_TESTS})
    add_executable(dstns_http_${name} tests/http/${name}.cpp)
    target_link_libraries(dstns_http_${name} PRIVATE dstns_fabric)
    target_include_directories(dstns_http_${name} PRIVATE Fabric/src)
    target_compile_definitions(dstns_http_${name} PRIVATE DSTNS_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
    target_compile_options(dstns_http_${name} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    set_target_properties(dstns_http_${name} PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/http-tests" OUTPUT_NAME ${name})
    add_dependencies(dstns_http_${name} dstns_server)
    add_test(NAME dstns_http_${name} COMMAND ${CMAKE_COMMAND} -E env "DSTNS_SERVER=$<TARGET_FILE:dstns_server>" $<TARGET_FILE:dstns_http_${name}>)
    set_tests_properties(dstns_http_${name} PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" TIMEOUT 120)
  endforeach()
  add_dependencies(dstns_http_release dstns_release)
  # The launcher may have to be compiled first.
  set_tests_properties(dstns_http_launcher_apps PROPERTIES TIMEOUT 600)
  add_executable(dstns_tests tests/unit/test_main.cpp)
  target_link_libraries(dstns_tests PRIVATE dstns_core)
  target_compile_options(dstns_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_unit_tests COMMAND dstns_tests)
  set_tests_properties(dstns_unit_tests PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

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

  add_executable(dstns_selection_ng_tests tests/unit/selection_ng_tests.cpp)
  target_link_libraries(dstns_selection_ng_tests PRIVATE dstns_core_ng)
  target_compile_options(dstns_selection_ng_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_selection_ng COMMAND dstns_selection_ng_tests)

  add_executable(dstns_lifecycle_ng_tests tests/unit/lifecycle_ng_tests.cpp)
  target_link_libraries(dstns_lifecycle_ng_tests PRIVATE dstns_core_ng)
  target_compile_options(dstns_lifecycle_ng_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_lifecycle_ng COMMAND dstns_lifecycle_ng_tests)
  set_tests_properties(dstns_lifecycle_ng PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" TIMEOUT 600)

  add_executable(dstns_next_world_ng_tests tests/unit/next_world_ng_tests.cpp)
  target_link_libraries(dstns_next_world_ng_tests PRIVATE dstns_core_ng)
  target_compile_options(dstns_next_world_ng_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_next_world_ng COMMAND dstns_next_world_ng_tests)
  set_tests_properties(dstns_next_world_ng PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

  add_executable(dstns_compile_ng_tests tests/unit/compile_ng_tests.cpp)
  target_link_libraries(dstns_compile_ng_tests PRIVATE dstns_core_ng)
  target_compile_options(dstns_compile_ng_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_compile_ng COMMAND dstns_compile_ng_tests)

  add_executable(dstns_timeline_ng_tests tests/unit/timeline_ng_tests.cpp)
  target_link_libraries(dstns_timeline_ng_tests PRIVATE dstns_core dstns_core_ng)
  target_compile_options(dstns_timeline_ng_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_timeline_ng COMMAND dstns_timeline_ng_tests)

  add_executable(dstns_golden_tests tests/unit/golden_tests.cpp)
  target_link_libraries(dstns_golden_tests PRIVATE dstns_core dstns_core_ng)
  target_compile_options(dstns_golden_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_golden COMMAND dstns_golden_tests)
  set_tests_properties(dstns_golden PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

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

  add_executable(dstns_daemon_tests tests/unit/daemon_tests.cpp)
  target_link_libraries(dstns_daemon_tests PRIVATE dstns_daemon)
  target_compile_options(dstns_daemon_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_daemon_rules COMMAND dstns_daemon_tests)
  set_tests_properties(dstns_daemon_rules PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")

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

  add_executable(dstns_narrator_tests tests/unit/narrator_tests.cpp)
  target_link_libraries(dstns_narrator_tests PRIVATE dstns_core)
  target_compile_options(dstns_narrator_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_narration COMMAND dstns_narrator_tests)
  set_tests_properties(dstns_narration PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" TIMEOUT 60)

  add_executable(dstns_perf_tests tests/performance/perf_tests.cpp)
  target_link_libraries(dstns_perf_tests PRIVATE dstns_core)
  target_compile_options(dstns_perf_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME dstns_performance_smoke COMMAND dstns_perf_tests)
  set_tests_properties(dstns_performance_smoke PROPERTIES WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
endif()

install(TARGETS dstns_server dstns_scenario_export dstns_road_index dstns_replay_verify dstns_benchmark RUNTIME DESTINATION bin)
