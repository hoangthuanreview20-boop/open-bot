#!/usr/bin/env python3
"""Fetch Composio trigger-type catalog (read-only) and filter to v0.96 toolkits.

Reuses the custom.composio connector credential flow (dynamic_credentials
surrogate) exactly like bin/composio.py — the key never appears here.
GET /api/v3.1/triggers_types paged whole (toolkit_slug param is ignored
by the API, verified v0.83), filtered client-side by toolkit.slug.
Saves a REDUCED snapshot (only the 18 new v0.96 toolkits) to
scripts/composio-triggers-live-v096/trigger-types-v096.json.
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
NEW_TOOLKITS = [
    "stripe", "shopify", "box", "confluence", "gitlab", "calendly",
    "mailchimp", "twilio", "googledocs", "youtube", "linkedin", "reddit",
    "whatsapp", "pagerduty", "typeform", "sendgrid", "bitbucket", "freshdesk",
]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def _get(path, params=None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method="GET")
    add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=[HOST])
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        print("HTTP %s %s" % (err.code, err.reason), file=sys.stderr)
        print(err.read().decode("utf-8", "replace")[:2000], file=sys.stderr)
        sys.exit(1)


def main():
    items = []
    cursor = None
    pages = 0
    while True:
        params = {"limit": 100}
        if cursor:
            params["cursor"] = cursor
        status, body = _get("/triggers_types", params)
        data = json.loads(body.decode("utf-8"))
        batch = data.get("items", [])
        items.extend(batch)
        pages += 1
        cursor = data.get("next_cursor")
        print("page %d: %d items (total so far %d) HTTP %s" % (pages, len(batch), len(items), status))
        if not cursor or not batch:
            break
    print("catalog total: %d trigger types in %d pages" % (len(items), pages))
    reduced = []
    counts = {}
    for t in items:
        toolkit = (t.get("toolkit") or {}).get("slug")
        if toolkit in NEW_TOOLKITS:
            reduced.append({
                "slug": t.get("slug"),
                "name": t.get("name"),
                "type": t.get("type"),
                "toolkit": toolkit,
                "requires_webhook_endpoint_setup": t.get("requires_webhook_endpoint_setup"),
            })
            counts[toolkit] = counts.get(toolkit, 0) + 1
    for tk in NEW_TOOLKITS:
        print("%s: %d" % (tk, counts.get(tk, 0)))
    print("reduced total: %d" % len(reduced))
    out = {
        "date": "2026-11-13",
        "source": "Composio REST v3.1 GET /triggers_types, paged whole, filtered client-side",
        "toolkits": NEW_TOOLKITS,
        "counts": counts,
        "total": len(reduced),
        "items": reduced,
    }
    with open("scripts/composio-triggers-live-v096/trigger-types-v096.json", "w") as f:
        json.dump(out, f, indent=2)
    print("saved scripts/composio-triggers-live-v096/trigger-types-v096.json")


if __name__ == "__main__":
    main()
