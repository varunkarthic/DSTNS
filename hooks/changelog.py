# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The changelog's nested lists, nested on the documentation site too.

CHANGELOG.md indents a list's sub-items, and the lines that continue an item, by two spaces, as GitHub reads them.
Python-Markdown nests only at four, so on this site every sub-item became a sibling of the item it belongs to. This
doubles the indentation of the changelog page's indented lines as the page is built; a fenced block moves with the
line that opens it, keeping its own content as written. The file itself is unchanged.
"""

import re
from pathlib import Path

from mkdocs.config.defaults import MkDocsConfig
from mkdocs.structure.files import Files
from mkdocs.structure.pages import Page

_FENCE = re.compile(r"^(\s*)(```|~~~)")
_ITEM = re.compile(r"^\s*(?:[-*+]|\d+\.)\s")


def deepen(markdown: str) -> str:
    out, fence, shift, in_paragraph = [], None, 0, False
    for line in markdown.split("\n"):
        if fence is not None:
            out.append(" " * shift + line if line.strip() else line)
            if line.strip().startswith(fence):
                fence = None
            continue
        lead = len(line) - len(line.lstrip(" "))
        opened = _FENCE.match(line)
        if lead and line.strip():
            line = " " * lead + line
        if opened:
            fence, shift = opened.group(2), lead
        # A list item straight after an indented paragraph (one that follows a blank line inside an item) would be read
        # as more of that paragraph: a blank line between them keeps it an item.
        if _ITEM.match(line) and out and out[-1].strip() and not _ITEM.match(out[-1]) and out[-1].startswith(" ") and in_paragraph:
            out.append("")
        if not line.strip():
            in_paragraph = False
        elif out and not out[-1].strip() and lead and not _ITEM.match(line):
            in_paragraph = True
        elif _ITEM.match(line):
            in_paragraph = False
        out.append(line)
    return "\n".join(out)


def on_page_markdown(markdown: str, page: Page, config: MkDocsConfig, files: Files, **_) -> str:
    if page.file.src_uri != "changelog.md":
        return markdown
    # The page includes CHANGELOG.md through a snippet, which is expanded after this hook runs: the file is read and
    # put in its place here, so that its lists can be deepened.
    root = Path(config.config_file_path).parent
    include = re.compile(r'^--8<--\s+"CHANGELOG\.md"\s*$', re.M)
    if include.search(markdown):
        changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
        markdown = include.sub(lambda _: changelog, markdown)
    return deepen(markdown)


if __name__ == "__main__":
    sample = "- item\n  - sub\n    - subsub\n  continued\n\n  ```bash\n  ./launcher\n  ```\n- next"
    got = deepen(sample).split("\n")
    assert got[1] == "    - sub" and got[2] == "        - subsub" and got[3] == "    continued", got
    assert got[5] == "    ```bash" and got[6] == "    ./launcher" and got[7] == "    ```", got
    para = deepen("- one\n  - sub\n\n  After the list.\n- two\n  more of two\n- three").split("\n")
    assert para[4] == "" and para[5] == "- two" and para[7] == "- three", para
    print("ok")
