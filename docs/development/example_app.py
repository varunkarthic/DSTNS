#!/usr/bin/env python3
"""A complete WebFabric application, using only the standard library."""
import json
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8090/api/v1/fabric/apps"
APP = "org.example.hello"
token = None


def call(method, route="", data=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None if data is None else json.dumps(data).encode()
    request = urllib.request.Request(BASE + route, body, headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)["data"]
    except urllib.error.HTTPError as error:
        raise SystemExit(json.load(error)["error"]["message"])


manifest = {
    "id": APP,
    "name": "Hello",
    "version": "1.0.0",
    "capabilities": ["ui.status", "ui.panels", "ui.map-controls", "settings"],
    "settings": {"version": 1, "groups": [{"id": "general", "label": "General", "fields": [
        {"id": "greeting", "label": "Greeting", "type": "text", "default": "Hello"},
    ]}]},
    "ui": [
        {"id": "state", "slot": "status", "label": "Hello", "value": "starting", "tone": "accent"},
        {"id": "open", "slot": "map_control", "label": "Hello", "icon": "info", "opens": "main"},
        {"id": "main", "slot": "panel", "title": "Hello", "widgets": [
            {"type": "text", "text": "Declared by an independent program."},
            {"type": "button", "id": "wave", "label": "Wave"},
        ]},
    ],
}

token = call("POST", "", manifest)["token"]  # Keep this to return as the same application.
greeting = call("GET", f"/{APP}/settings")["values"]["greeting"]
cursor = waves = 0
try:
    while True:
        call("POST", f"/{APP}/heartbeat", {})
        page = call("GET", f"/{APP}/events?since={cursor}")
        cursor = page["sequence"]
        for event in page["items"]:
            if event["type"] == "ui.action" and event["data"]["element"] == "wave":
                waves += 1
            elif event["type"] == "settings.changed":
                greeting = event["data"]["values"]["greeting"]
                print("greeting is now", greeting)
        call("PUT", f"/{APP}/ui/state", {"slot": "status", "label": greeting, "value": waves, "tone": "ok"})
        time.sleep(1)
except KeyboardInterrupt:
    call("DELETE", f"/{APP}")
