#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic
"""A bus network planner, built only on the Fabric API.

A test product and a worked example: it reads the road network and bus stops, plans
lines along real roads, draws them on the map, runs buses along them, and explains
itself in a sidebar and a telemetry section. Nothing here is special to DSTNS's
own code; any program could do the same.

    python3 Fabric/examples/bus_planner.py --url http://127.0.0.1:8090
    python3 Fabric/examples/bus_planner.py --ticks 5     stop after five updates
"""
import argparse
import heapq
import json
import math
import time
import urllib.error
import urllib.request

APP = "org.dstns.bus-planner"
LINES = 6


class Fabric:
    def __init__(self, url):
        self.url = url.rstrip("/")
        self.token = None

    def call(self, method, route, data=None):
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        body = None if data is None else json.dumps(data).encode()
        request = urllib.request.Request(self.url + route, body, headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise SystemExit(f"{method} {route}: {json.load(error).get('error', {}).get('message', error)}")

    def app(self, method, tail, data=None):
        return self.call(method, f"/api/v1/fabric/apps/{APP}{tail}", data)["data"]


def wait_for_network(fabric):
    while True:
        body = fabric.call("GET", "/api/v1/view/topology")
        network = body.get("data", body)
        if network.get("edges"):
            return network
        time.sleep(0.5)


def road_graph(network):
    """Node to its outgoing roads, as (node, length, edge)."""
    graph = {}
    for edge in network["edges"]:
        graph.setdefault(edge["from"], []).append((edge["to"], edge.get("length_m", 1), edge))
    return graph


def shortest_path(graph, start, goal):
    """The roads from start to goal, by length. Dijkstra, stopping at the goal."""
    best = {start: 0}
    previous = {}
    queue = [(0, start)]
    while queue:
        cost, node = heapq.heappop(queue)
        if node == goal:
            path = []
            while node != start:
                node, edge = previous[node]
                path.append(edge)
            return path[::-1]
        if cost > best.get(node, math.inf):
            continue
        for neighbour, length, edge in graph.get(node, ()):
            next_cost = cost + length
            if next_cost < best.get(neighbour, math.inf):
                best[neighbour] = next_cost
                previous[neighbour] = (node, edge)
                heapq.heappush(queue, (next_cost, neighbour))
    return None


def plan_lines(network, stops):
    """Greedy: each line joins unserved stops in turn, nearest next, along real roads."""
    graph = road_graph(network)
    position = {node["id"]: node["position"] for node in network["nodes"]}
    unserved = sorted(stops, key=lambda s: -s["multiplier"])
    lines = []
    for number in range(LINES):
        if len(unserved) < 2:
            break
        route = [unserved.pop(0)]
        points = []
        while unserved and len(route) < max(3, len(stops) // LINES + 1):
            here = position[route[-1]["node"]]
            unserved.sort(key=lambda s: math.hypot(s["x_m"] - here["x_m"], s["y_m"] - here["y_m"]))
            found = None
            for candidate in unserved[:8]:
                path = shortest_path(graph, route[-1]["node"], candidate["node"])
                if path:
                    found = (candidate, path)
                    break
            if not found:
                break
            candidate, path = found
            unserved.remove(candidate)
            route.append(candidate)
            for edge in path:
                points.extend([p["x_m"], p["y_m"]] for p in edge["geometry"])
        if len(points) >= 2:
            lines.append({"number": number, "stops": route, "points": points, "demand": sum(s["multiplier"] for s in route)})
    return lines


def along(points, distance):
    """A point this far along a polyline, there and back."""
    lengths = [math.dist(points[i], points[i + 1]) for i in range(len(points) - 1)]
    total = sum(lengths) or 1
    distance = distance % (2 * total)
    if distance > total:
        distance = 2 * total - distance
    for i, length in enumerate(lengths):
        if distance <= length and length:
            t = distance / length
            return points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t
        distance -= length
    return points[-1]


def sidebar(lines, covered, moving):
    total = sum(line["demand"] for line in lines) or 1
    return {
        "id": "planner", "slot": "sidebar", "title": "Bus planner", "label": "Built on Fabric", "motion": "slide",
        "widgets": [
            {"type": "tabs", "id": "view", "tabs": [
                {"id": "network", "caption": "Step 1", "label": "The network", "widgets": [
                    {"type": "text", "text": "Each line starts at the busiest stop not yet served, then joins the nearest unserved stop along real roads."},
                    {"type": "stats", "items": [{"label": "Lines", "value": len(lines)}, {"label": "Stops", "value": covered}]},
                    {"type": "heading", "text": "Lines"},
                    {"type": "list", "id": "lines", "rows": [
                        {"id": f"line-{line['number']}", "badge": f"R{line['number']}", "subtitle": f"{len(line['stops'])} stops", "share": line["demand"] / total, "value": f"{100 * line['demand'] / total:.0f}%", "series": line["number"]}
                        for line in lines]},
                ]},
                {"id": "journey", "caption": "Step 2", "label": "A journey", "widgets": [
                    {"type": "note", "text": "Choose a place, and the nearest stop to it is reported."},
                    {"type": "button", "id": "from", "label": "Choose a place on the map", "pick": True},
                ]},
            ]},
            {"type": "legend", "legend": [{"label": "Bus line", "series": 0, "mark": "line"}, {"label": "Stop", "tone": "warn", "mark": "dot"}, {"id": "moving", "label": "Moving buses", "value": moving}]},
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default="http://127.0.0.1:8090")
    parser.add_argument("--ticks", type=int, default=0, help="stop after this many updates; 0 runs until interrupted")
    args = parser.parse_args()
    fabric = Fabric(args.url)

    network = wait_for_network(fabric)
    registered = fabric.call("POST", "/api/v1/fabric/apps", {
        "id": APP, "name": "Bus planner", "version": "1.0.0", "description": "Plans bus lines along real roads, using the core's demand at each stop.",
        "capabilities": ["ui.sidebar", "ui.deck", "ui.overlays", "ui.notifications", "settings", "sim.read"],
        "lease_s": 30,
        "settings": {"version": 1, "groups": [{"id": "service", "label": "Service", "fields": [
            {"id": "buses", "label": "Buses per line", "type": "slider", "min": 1, "max": 4, "default": 2},
            {"id": "speed", "label": "Bus speed", "hint": "Metres of map per second of real time.", "type": "slider", "min": 20, "max": 200, "step": 10, "default": 80},
        ]}]},
    })["data"]
    fabric.token = registered["token"]

    # DSTNS's own stops, as places, where the district has enough of them. Otherwise the
    # application names well-connected junctions. Either way the core reports the demand
    # a stop there sees, by the model its real stops use.
    own = fabric.call("GET", "/api/v1/view/stops?limit=2000")["data"]["items"]
    anchors = list(dict.fromkeys(stop["anchor_node"] for stop in own))
    nodes = anchors if len(anchors) >= 12 else [n["id"] for n in sorted(network["nodes"], key=lambda n: -n.get("degree", 0))[:48]]
    stops = fabric.app("PUT", "/stops", {"nodes": nodes[:96]})["items"]
    lines = plan_lines(network, stops)
    if not lines:
        raise SystemExit("No lines could be planned on this network.")

    routes = {"id": "routes", "slot": "overlay", "features": [{"type": "line", "series": line["number"], "width": 3, "points": line["points"]} for line in lines]}
    stop_marks = {"id": "stops", "slot": "overlay", "features": [
        {"type": "point", "x_m": stop["x_m"], "y_m": stop["y_m"], "size": 3.5, "tone": "warn", "hollow": True} for line in lines for stop in line["stops"]]}
    covered = sum(len(line["stops"]) for line in lines)
    moving = True
    settings = fabric.app("GET", "/settings")["values"]
    fabric.app("PUT", "/ui", [routes, stop_marks, sidebar(lines, covered, moving)])
    fabric.app("POST", "/notifications", {"title": f"{len(lines)} lines planned", "body": f"{covered} stops are served along real roads."})

    cursor = 0
    tick = 0
    started = time.monotonic()
    try:
        while not args.ticks or tick < args.ticks:
            tick += 1
            fabric.app("POST", "/heartbeat", {})
            page = fabric.app("GET", f"/events?since={cursor}")
            cursor = page["sequence"]
            for event in page["items"]:
                data = event["data"]
                if event["type"] == "settings.changed":
                    settings = data["values"]
                elif event["type"] == "ui.action" and data["element"] == "moving":
                    moving = bool(data["value"])
                    fabric.app("PUT", "/ui/planner", sidebar(lines, covered, moving))
                elif event["type"] == "ui.action" and data.get("action") == "pick":
                    place = data["value"]
                    nearest = min((s for line in lines for s in line["stops"]), key=lambda s: math.hypot(s["x_m"] - place["x_m"], s["y_m"] - place["y_m"]))
                    metres = math.hypot(nearest["x_m"] - place["x_m"], nearest["y_m"] - place["y_m"])
                    fabric.app("POST", "/notifications", {"title": "Nearest stop", "body": f"{metres:.0f} m away, at junction {nearest['node']}."})

            # The core's demand now, for the section on the right.
            live = sorted(fabric.app("GET", "/stops")["items"], key=lambda s: -s["multiplier"])[:6]
            fabric.app("PUT", "/ui/demand", {
                "slot": "deck", "title": "Busiest stops now", "motion": "rise",
                "widgets": [{"type": "list", "rows": [
                    {"badge": f"J{stop['node']}"[:6], "subtitle": f"{stop['generators']} trip generators nearby", "share": min(1, stop["multiplier"] / 2), "value": f"{stop['multiplier']:.2f}×", "series": 1}
                    for stop in live]}],
            })

            # Only the buses change each second; the network is not sent again.
            if moving:
                elapsed = time.monotonic() - started
                fabric.app("PUT", "/ui/buses", {"slot": "overlay", "motion": {"stiffness": 60, "damping": 15}, "features": [
                    {"id": f"bus-{line['number']}-{i}", "type": "point", "size": 5, "series": line["number"],
                     **dict(zip(("x_m", "y_m"), along(line["points"], elapsed * settings["speed"] + i * 700)))}
                    for line in lines for i in range(int(settings["buses"]))]})
            else:
                fabric.app("PUT", "/ui/buses", {"slot": "overlay", "features": []})
            if not args.ticks or tick < args.ticks:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        fabric.app("DELETE", "")
    print(f"ok: {len(lines)} lines, {covered} stops, {tick} updates")


if __name__ == "__main__":
    main()
