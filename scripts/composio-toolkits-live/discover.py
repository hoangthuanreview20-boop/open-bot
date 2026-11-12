#!/usr/bin/env python3
"""Live discovery of real Composio tool slugs per toolkit (Team A, v0.72a).

Uses the registered custom.composio credential through the same
surrogate mechanism as the connector helper (the key never appears
in this file, in arguments, or in output).

Findings (2026-11-10, verified live against backend.composio.dev):
- The Tool Router session tool list (`/tool_router/session/{id}/tools`)
  returns ONLY the 6 COMPOSIO_* meta-tools — per-toolkit tools are
  discovered at runtime via COMPOSIO_SEARCH_TOOLS, not listed here.
- The catalog endpoint `GET /api/v3.1/tools` DOES filter by toolkit,
  but only with the param name `toolkit_slug` — `toolkit` is silently
  ignored (the helper's `--toolkit` flag hits this trap; the base
  call still proves the key with HTTP 200).

Usage:
  python3 discover.py [output.json]

Output JSON: per toolkit, the full live slug list + count +
descriptions (truncated). Re-run to refresh; the catalog in
packages/core/src/composio/toolkits.ts lists the 10 most-used
verified slugs per toolkit (M7 cap = 10/app/turn), the rest is
covered at runtime by COMPOSIO_SEARCH_TOOLS.
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

HOST = "backend.composio.dev"
BASE = "https://" + HOST + "/api/v3.1"
CREDENTIAL = "custom.composio"

TOOLKITS = [
    "gmail",
    "github",
    "slack",
    "notion",
    "googlesheets",
    "googledrive",
    "googlecalendar",
    "jira",
    "linear",
    "discord",
    "telegram",
    "trello",
    "asana",
    "hubspot",
]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")


def _get(params):
    url = BASE + "/tools?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method="GET")
    add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=[HOST])
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=90) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        print("HTTP %s %s" % (err.code, err.reason), file=sys.stderr)
        print(err.read().decode("utf-8", "replace")[:1000], file=sys.stderr)
        sys.exit(1)


def fetch_toolkit(slug):
    items = []
    cursor = None
    while True:
        params = {"limit": 500, "toolkit_slug": slug}
        if cursor:
            params["cursor"] = cursor
        status, page = _get(params)
        batch = page.get("items", [])
        items.extend(batch)
        cursor = page.get("next_cursor")
        if not cursor or not batch:
            break
    return items


def main():
    # Usage: discover.py [output.json] [toolkit ...] — extra args after
    # the output path override the default TOOLKITS list (v0.82).
    args = sys.argv[1:]
    out_path = "toolkits-live.json"
    slugs = TOOLKITS
    if args:
        out_path = args[0]
        if len(args) > 1:
            slugs = args[1:]
    result = {"toolkits": {}}
    for slug in slugs:
        items = fetch_toolkit(slug)
        tools = []
        for it in items:
            tools.append({
                "slug": it.get("slug"),
                "description": (it.get("description") or "")[:220],
            })
        tools.sort(key=lambda t: t["slug"] or "")
        result["toolkits"][slug] = {"count": len(tools), "tools": tools}
        print("%-16s %d tools" % (slug, len(tools)))
    with open(out_path, "w") as f:
        json.dump(result, f, indent=1)
    print("wrote %s" % out_path)


if __name__ == "__main__":
    main()
