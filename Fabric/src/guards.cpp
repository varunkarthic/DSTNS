// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/fabric/registry.hpp"
#include "dstns/osm_fetch.hpp"
#include "support.hpp"

namespace dstns {
using namespace fabric;

// What every request passes through, whichever module answers it.
void ApiServer::install_guards() {
    const std::string operator_token=std::getenv("DSTNS_OPERATOR_TOKEN")?std::getenv("DSTNS_OPERATOR_TOKEN"):"";
    const auto loopback_only=loopback_only_;
    server_->set_pre_routing_handler([operator_token,loopback_only](const auto& req,auto& r){
        // DNS rebinding: see host_allowed. Applies to reads as well as writes,
        // since a rebound page could otherwise read the whole run.
        if (loopback_only->load() && !host_allowed(req.get_header_value("Host"))) {
            send(r,{{"error",{{"code","HOST_NOT_ALLOWED"},{"message","This server is bound to loopback and answers only to localhost or an IP address. Set DSTNS_ALLOWED_HOSTS to admit another name."}}}},421);
            return httplib::Server::HandlerResponse::Handled;
        }
        // A browser names the page that sent a request in Origin. A state-
        // changing request from a page served by some other host is a cross-
        // site request forgery, not the observer, and is refused. Clients that
        // are not browsers (the CLI, scripts) send no Origin and are unaffected.
        if (req.method != "GET" && req.method != "HEAD" && req.method != "OPTIONS" && req.has_header("Origin")
            && !same_origin(req.get_header_value("Origin"), req.get_header_value("Host"), req.get_header_value("X-Forwarded-Host"))) {
            send(r,{{"error",{{"code","CROSS_ORIGIN_FORBIDDEN"},{"message","State-changing requests must come from the observer's own origin."}}}},403);
            return httplib::Server::HandlerResponse::Handled;
        }
        if((req.path=="/api/v1/playback/start"||req.path=="/api/v1/playback/prepare") && req.method=="POST" && (operator_token.empty()||req.get_header_value("X-DSTNS-Operator")!=operator_token)) {
            send(r,{{"error",{{"code","CLI_START_REQUIRED"},{"message","Start simulations through the operator CLI."}}}},403);return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });

    // CORS is granted per request, below, not to everyone: "*" would let any
    // web page the operator visits read the run from a local server.
    server_->set_default_headers({
        {"Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, Authorization"},
        {"Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"},
        {"Cache-Control", "no-store"}
    });

    // Only the server's own origin, and origins listed in DSTNS_ALLOWED_ORIGINS,
    // may read responses from a browser. The observer is served by this server,
    // so it is same-origin and needs no cross-origin grant at all.
    server_->set_post_routing_handler([](const auto& req, auto& res) {
        const auto origin = req.get_header_value("Origin");
        if (!origin.empty() && same_origin(origin, req.get_header_value("Host"), req.get_header_value("X-Forwarded-Host"))) {
            res.set_header("Access-Control-Allow-Origin", origin);
        }
        res.set_header("Vary", "Origin");
    });

    server_->Options(R"(.*)", [](const auto&, auto& r) {
        r.status = 204;
    });

    server_->set_exception_handler([this](const auto& req, auto& res, std::exception_ptr ep) {
        std::string message = "internal server error", code = "INTERNAL_ERROR";
        int status = 500;
        try {
            if (ep) std::rethrow_exception(ep);
        } catch (const Refusal& e) {
            // A deliberate refusal, not a fault, so it is not logged as an error.
            send(res, {{"ok", false}, {"api_version", kApiVersion}, {"error", {{"code", e.code}, {"message", e.what()}}}}, e.status);
            return;
        } catch (const MapFetchError& e) {
            // The seed names a real place that could not be downloaded. This is
            // upstream/environmental, and retryable, so it must not look like a
            // bad request or a crash.
            message = e.what();
            code = "MAP_FETCH_FAILED";
            status = 503;
        } catch (const nlohmann::json::parse_error& e) {
            message = std::string("Malformed JSON: ") + e.what();
            code = "INVALID_JSON";
            status = 400;
        } catch (const nlohmann::json::out_of_range& e) {
            message = e.what();
            code = "MISSING_FIELD";
            status = 400;
        } catch (const nlohmann::json::type_error& e) {
            message = e.what();
            code = "INVALID_FIELD_TYPE";
            status = 400;
        } catch (const std::invalid_argument& e) {
            message = e.what();
            code = "INVALID_REQUEST";
            status = 400;
        } catch (const std::out_of_range& e) {
            message = e.what();
            code = "NOT_FOUND";
            status = 404;
        } catch (const std::logic_error& e) {
            message = e.what();
            code = "LIFECYCLE_CONFLICT";
            status = 409;
        } catch (const std::exception& e) {
            message = e.what();
        }
        send(res, {{"ok", false}, {"api_version", kApiVersion}, {"error", {{"code", code}, {"message", message}}}}, status);
        logger_.system("ERROR", "api", req.method + " " + req.path + ": " + message);
    });

    server_->set_logger([this](const auto& req, const auto& res) {
        logger_.api(req.method, req.path, res.status, 0);
    });
}
} // namespace dstns
