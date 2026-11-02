# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""What the launcher asks of the Fabric API, as the operator."""
from __future__ import annotations

from typing import Any

from . import api
from .paths import PATHS, Paths

BASE = "/api/v1/fabric"


def _data(response: api.Response) -> Any:
    return (response.body or {}).get("data") if response.ok and isinstance(response.body, dict) else None


def apps(port: int, paths: Paths = PATHS) -> list[dict[str, Any]]:
    return (_data(api.call(port, f"{BASE}/apps", timeout=5, paths=paths)) or {}).get("items", [])


def health(port: int, app_id: str, paths: Paths = PATHS) -> dict[str, Any] | None:
    return _data(api.call(port, f"{BASE}/apps/{app_id}/health", timeout=5, paths=paths))


def describe(port: int, app_id: str, paths: Paths = PATHS) -> dict[str, Any] | None:
    return _data(api.call(port, f"{BASE}/apps/{app_id}", timeout=5, paths=paths))


def grant(port: int, app_id: str, capabilities: list[str], paths: Paths = PATHS) -> api.Response:
    return api.call(port, f"{BASE}/apps/{app_id}/grants", "PUT", {"capabilities": capabilities}, timeout=5, paths=paths)


def settings(port: int, app_id: str, paths: Paths = PATHS) -> dict[str, Any] | None:
    return _data(api.call(port, f"{BASE}/apps/{app_id}/settings", timeout=5, paths=paths))


def update_settings(port: int, app_id: str, values: dict[str, Any], paths: Paths = PATHS) -> api.Response:
    return api.call(port, f"{BASE}/apps/{app_id}/settings", "PUT", values, timeout=5, paths=paths)


def proposals(port: int, paths: Paths = PATHS) -> list[dict[str, Any]]:
    return (_data(api.call(port, f"{BASE}/launch", timeout=5, paths=paths)) or {}).get("items", [])


def withdraw(port: int, app_id: str, paths: Paths = PATHS) -> api.Response:
    return api.call(port, f"{BASE}/launch/{app_id}", "DELETE", timeout=5, paths=paths)


def set_plan(port: int, plan: dict[str, Any] | None, paths: Paths = PATHS) -> None:
    if plan is None:
        api.call(port, f"{BASE}/launch/plan", "DELETE", timeout=3, paths=paths)
    else:
        api.call(port, f"{BASE}/launch/plan", "PUT", plan, timeout=3, paths=paths)


def security(port: int, paths: Paths = PATHS) -> dict[str, Any] | None:
    return _data(api.call(port, f"{BASE}/security", timeout=5, paths=paths))


def audit(port: int, limit: int = 50, paths: Paths = PATHS) -> list[dict[str, Any]]:
    return (_data(api.call(port, f"{BASE}/audit?limit={limit}", timeout=5, paths=paths)) or {}).get("items", [])


def capabilities(port: int, paths: Paths = PATHS) -> dict[str, Any] | None:
    return _data(api.call(port, f"{BASE}/capabilities", timeout=5, paths=paths))
