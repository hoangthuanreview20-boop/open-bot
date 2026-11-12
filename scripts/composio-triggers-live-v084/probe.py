#!/usr/bin/env python3
"""Driver for the v0.84 Composio probe (read-only).

Same pattern as scripts/composio-live-v072/run-live.py: fetch the
hsurr: surrogate for custom.composio from authd, pass it to the Node
probe via env only. Never prints the surrogate.
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry


def main():
    entry = dynamic_credential_entry("custom.composio")
    surrogate = str(entry.get("surrogate", "")).strip()
    if not surrogate.startswith("hsurr:"):
        print("driver: could not obtain a surrogate for custom.composio", file=sys.stderr)
        return 1
    env = dict(os.environ)
    env["COMPOSIO_KEY_SURROGATE"] = surrogate
    proc = subprocess.run(
        ["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe.mjs")],
        env=env,
    )
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
