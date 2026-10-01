# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The DSTNS launcher: builds, verifies, starts and supervises the simulator.

All operations live in :mod:`dstns_launcher.core`. The terminal interfaces in
:mod:`dstns_launcher.tui` (Textual) and :mod:`dstns_launcher.fallback` (Rich or
plain text) only present them, so every operation remains available when the
richer interface cannot start.
"""
