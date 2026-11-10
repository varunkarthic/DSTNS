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


def search(graph, start, goal, position=None):
    """The roads from start to goal by length, and how many junctions were settled finding them. Dijkstra; with
    junction positions, A*, guided by the straight line to the goal, which never overestimates a road's length."""
    def guess(node):
        if position is None:
            return 0
        a, b = position[node], position[goal]
        return math.hypot(a["x_m"] - b["x_m"], a["y_m"] - b["y_m"])
    best = {start: 0}
    previous = {}
    queue = [(guess(start), start)]
    settled = set()
    while queue:
        _, node = heapq.heappop(queue)
        if node in settled:
            continue
        settled.add(node)
        if node == goal:
            path = []
            while node != start:
                node, edge = previous[node]
                path.append(edge)
            return path[::-1], len(settled)
        for neighbour, length, edge in graph.get(node, ()):
            next_cost = best[node] + length
            if next_cost < best.get(neighbour, math.inf):
                best[neighbour] = next_cost
                previous[neighbour] = (node, edge)
                heapq.heappush(queue, (next_cost + guess(neighbour), neighbour))
    return None, len(settled)


def shortest_path(graph, start, goal):
    """The roads from start to goal, by length."""
    return search(graph, start, goal)[0]


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
        nodes = [route[0]["node"]]
        depot = None
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
            depot = depot if depot is not None else path[0]["id"]
            nodes.extend(edge["to"] for edge in path)
        if len(nodes) >= 2:
            lines.append({"number": number, "stops": route, "nodes": nodes, "depot": depot, "demand": sum(s["multiplier"] for s in route)})
    return lines


def buses(lines, settings, moving):
    """A path per bus: WebFabric animates them along the roads, so nothing is sent per second."""
    return {"id": "buses", "slot": "overlay", "features": [
        {"id": f"bus-{line['number']}-{i}", "type": "path", "nodes": line["nodes"], "series": line["number"], "shape": "bus",
         "label": f"R{line['number']}" if i == 0 else None, "speed_mps": settings["speed"], "spring": "lively", "bounce": True, "loop": True,
         "dwell_s": 1.2, "delay_s": i * 5, "reveal": False, "trail": False, "paused": not moving}
        for line in lines for i in range(int(settings["buses"]))]}


def sidebar(state):
    """The planner template: one tab per algorithm, each opening with what it did in figures, then what it made, then
    a way to watch or try it. Every widget here is one the observer already draws."""
    lines, covered, moving = state["lines"], state["covered"], state["moving"]
    total = sum(line["demand"] for line in lines) or 1
    share = covered / max(1, state["stops"])
    shown = state["built"]
    building = shown is not None
    journey = state["journey"]
    ends = state["ends"]
    trying = [
        {"type": "button", "id": "pick-from", "label": f"From junction {ends['from']}" if ends.get("from") is not None else "Choose where from", "pick": True,
         "area": {"column": 1, "width": 3}},
        {"type": "button", "id": "pick-to", "label": f"To junction {ends['to']}" if ends.get("to") is not None else "Choose where to", "pick": True,
         "area": {"column": 4, "width": 3}},
        {"type": "button", "id": "plan", "label": "Plan the journey", "tone": "accent"},
    ]
    if journey:
        trying += [
            {"type": "heading", "text": "A* against Dijkstra, same question"},
            {"type": "stats", "items": [
                {"label": "A* settled", "value": journey["astar"], "tone": "accent"},
                {"label": "Dijkstra settled", "value": journey["dijkstra"], "tone": "warn"},
            ]},
            {"type": "note", "text": f"Both find the same {journey['metres']:.0f} m. A* looked at {100 * journey['astar'] / max(1, journey['dijkstra']):.0f}% as many junctions, because the straight line to the goal tells it which way to look first."},
        ]
    return {
        "id": "planner", "slot": "sidebar", "title": "Bus planner", "label": "Built on Fabric", "motion": "slide",
        "widgets": [
            {"type": "tabs", "id": "view", "tabs": [
                {"id": "network", "caption": "Algorithm 1", "label": "The network", "widgets": [
                    {"type": "text", "text": "Each line starts at the busiest stop not yet served, then joins the nearest unserved stop along real roads."},
                    {"type": "stats", "items": [
                        {"label": "Demand covered", "value": f"{100 * share:.0f}%", "tone": "accent"},
                        {"label": "Lines", "value": f"{len(lines)}/{LINES}"},
                        {"label": "Stops", "value": covered},
                    ]},
                    {"type": "progress", "label": "Stops served", "value": share},
                    {"type": "heading", "text": "Lines"},
                    {"type": "list", "id": "lines", "rows": [
                        {"id": f"line-{line['number']}", "badge": f"R{line['number']}", "title": f"{len(line['stops'])} stops", "subtitle": f"Junction {line['stops'][0]['node']} onward",
                         "share": line["demand"] / total, "value": f"{100 * line['demand'] / total:.0f}%", "series": line["number"]}
                        for line in lines]},
                    {"type": "heading", "text": "Watch it being built"},
                    {"type": "button", "id": "replay", "label": ("Pause" if state["playing"] else "Play") if building else "Replay the construction", "area": {"column": 1, "width": 2}},
                    *([{"type": "slider", "id": "seek", "label": "Line", "min": 0, "max": len(lines), "step": 1, "value": shown, "area": {"column": 3, "width": 4}},
                       {"type": "note", "text": f"Line R{lines[shown - 1]['number']}: from junction {lines[shown - 1]['stops'][0]['node']} through {len(lines[shown - 1]['stops'])} stops." if shown else "No lines yet: the busiest stop comes first."}]
                      if building else []),
                ]},
                {"id": "journey", "caption": "Algorithm 2", "label": "A journey", "widgets": [
                    {"type": "text", "text": "Choose two places on the map, and the shortest way between them is found twice: by Dijkstra, and by A*."},
                    *trying,
                ]},
            ]},
            {"type": "legend", "legend": [
                {"label": "Bus line", "series": 0, "mark": "line"}, {"label": "Your journey", "tone": "accent", "mark": "line"},
                {"label": "Stop", "tone": "warn", "mark": "dot"}, {"id": "moving", "label": "Moving buses", "value": moving}]},
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default="http://127.0.0.1:8090")
    parser.add_argument("--ticks", type=int, default=0, help="stop after this many updates; 0 runs until interrupted")
    parser.add_argument("--web", help="the address of this planner's own web page, offered as a code to scan with a phone")
    args = parser.parse_args()
    fabric = Fabric(args.url)

    network = wait_for_network(fabric)
    registered = fabric.call("POST", "/api/v1/fabric/apps", {
        "id": APP, "name": "Bus planner", "version": "1.0.0", "description": "Plans bus lines along real roads, using the core's demand at each stop.",
        "capabilities": ["ui.sidebar", "ui.deck", "ui.overlays", "ui.notifications", "settings", "sim.read"],
        "lease_s": 30,
        **({"web": {"url": args.web, "label": "Ticketing"}} if args.web else {}),
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

    routes = {"id": "routes", "slot": "overlay", "features": [{"type": "route", "series": line["number"], "width": 3, "nodes": line["nodes"]} for line in lines]}
    stop_marks = {"id": "stops", "slot": "overlay", "features": [
        {"type": "marker", "node": stop["node"], "shape": "stop", "size": 4, "series": line["number"]} for line in lines for stop in line["stops"]]}
    depots = {"id": "depots", "slot": "overlay", "features": [
        {"type": "entity", "edge": line["depot"], "at": 0.5, "shape": "vehicle", "size": 4, "tone": "neutral"} for line in lines if line["depot"] is not None]}
    covered = sum(len(line["stops"]) for line in lines)
    state = {"lines": lines, "covered": covered, "stops": len(stops), "moving": True, "built": None, "playing": False, "journey": None, "ends": {}}
    graph = road_graph(network)
    position = {node["id"]: node["position"] for node in network["nodes"]}
    settings = fabric.app("GET", "/settings")["values"]
    fabric.app("PUT", "/ui", [routes, stop_marks, depots, buses(lines, settings, state["moving"]), sidebar(state)])

    def nearest_junction(place):
        return min(position, key=lambda n: math.hypot(position[n]["x_m"] - place["x_m"], position[n]["y_m"] - place["y_m"]))

    def show_built():
        """The construction replay: the routes overlay shows the first lines only."""
        upto = lines if state["built"] is None else lines[:state["built"]]
        fabric.app("PUT", "/ui/routes", {**routes, "features": [{"type": "route", "series": line["number"], "width": 3, "nodes": line["nodes"]} for line in upto]})
    history = []
    fabric.app("POST", "/notifications", {"title": f"{len(lines)} lines planned", "body": f"{covered} stops are served along real roads."})

    cursor = 0
    tick = 0
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
                    fabric.app("PUT", "/ui/buses", buses(lines, settings, state["moving"]))
                elif event["type"] == "ui.action" and data["element"] == "moving":
                    state["moving"] = bool(data["value"])
                    fabric.app("PUT", "/ui/buses", buses(lines, settings, state["moving"]))
                elif event["type"] == "ui.action" and data.get("action") == "pick":
                    state["ends"]["from" if data["element"] == "pick-from" else "to"] = nearest_junction(data["value"])
                    state["journey"] = None
                elif event["type"] == "ui.action" and data["element"] == "plan" and len(state["ends"]) == 2:
                    a, b = state["ends"]["from"], state["ends"]["to"]
                    path, dijkstra = search(graph, a, b)
                    _, astar = search(graph, a, b, position)
                    if path:
                        state["journey"] = {"astar": astar, "dijkstra": dijkstra, "metres": sum(edge.get("length_m", 0) for edge in path)}
                        fabric.app("PUT", "/ui/journey", {"slot": "overlay", "features": [
                            {"id": "journey", "type": "path", "nodes": [a] + [edge["to"] for edge in path], "style": "flow", "tone": "accent", "width": 4, "glow": True}]})
                    else:
                        fabric.app("POST", "/notifications", {"title": "No way through", "body": f"No road leads from junction {a} to junction {b}."})
                elif event["type"] == "ui.action" and data["element"] == "replay":
                    if state["built"] is None or state["built"] >= len(lines):
                        state["built"], state["playing"] = 0, True
                    else:
                        state["playing"] = not state["playing"]
                    show_built()
                elif event["type"] == "ui.action" and data["element"] == "seek":
                    state["built"], state["playing"] = int(data["value"]), False
                    show_built()
                if event["type"] == "ui.action" or event["type"] == "settings.changed":
                    fabric.app("PUT", "/ui/planner", sidebar(state))
            # A replay adds a line a second, then rests on the finished network.
            if state["playing"]:
                state["built"] += 1
                state["playing"] = state["built"] < len(lines)
                show_built()
                fabric.app("PUT", "/ui/planner", sidebar(state))

            # The core's demand now, for the section on the right.
            everywhere = fabric.app("GET", "/stops")["items"]
            live = sorted(everywhere, key=lambda s: -s["multiplier"])[:6]
            history = (history + [sum(s["multiplier"] for s in everywhere) / (len(everywhere) or 1)])[-60:]
            fabric.app("PUT", "/ui/demand", {
                "slot": "deck", "title": "Busiest stops now", "motion": "rise",
                "widgets": [{"type": "sparkline", "label": "Mean demand multiplier", "value": f"{history[-1]:.2f}×", "values": history, "series": 0},
                            {"type": "route", "label": f"Line R{lines[0]['number']}", "series": lines[0]["number"], "stops": [
                                {"label": f"Junction {stop['node']}", "caption": f"{stop['multiplier']:.2f}×", "state": "current" if i == 0 else "next"}
                                for i, stop in enumerate(lines[0]["stops"][:6])]},
                            {"type": "list", "rows": [
                    {"badge": f"J{stop['node']}"[:6], "subtitle": f"{stop['generators']} trip generators nearby", "share": min(1, stop["multiplier"] / 2), "value": f"{stop['multiplier']:.2f}×", "series": 1}
                    for stop in live]}],
            })

            if not args.ticks or tick < args.ticks:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        fabric.app("DELETE", "")
    print(f"ok: {len(lines)} lines, {covered} stops, {tick} updates")


if __name__ == "__main__":
    main()
