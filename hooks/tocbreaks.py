# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Let a long API route in a page's table of contents wrap between its segments.

"POST /api/v1/fabric/engine/pause" is one word to the browser, so in the narrow table of contents it either runs out
of the column or, told to break anywhere, splits inside a word ("pau / se"). A word-break opportunity after each slash
lets it wrap at the slashes instead, and changes nothing that is read or copied.
"""

import re

_TOC = re.compile(r'(<nav class="md-nav md-nav--secondary".*?</nav>)', re.S)
_ROUTE = re.compile(r'(<span class="md-ellipsis">)([^<]*/[^<]*)(</span>)')


def _breakable(match: re.Match) -> str:
    return match.group(1) + match.group(2).replace("/", "/<wbr>") + match.group(3)


def on_post_page(output: str, **_) -> str:
    return _TOC.sub(lambda nav: _ROUTE.sub(_breakable, nav.group(1)), output)
