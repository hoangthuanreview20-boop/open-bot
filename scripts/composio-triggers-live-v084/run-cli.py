#!/usr/bin/env python3
"""Run the Composio CLI with the project API key via surrogate.

Fetches the hsurr: surrogate for custom.composio from authd and passes
it to the CLI as COMPOSIO_API_KEY in the child environment only.
Sentinel swaps the surrogate for the real key on approved egress to
backend.composio.dev. The surrogate is NEVER printed or written to a
file. Usage: run-cli.py <composio args...>
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry


def main():
    if len(sys.argv) < 2:
        print("usage: run-cli.py <composio args...>", file=sys.stderr)
        return 2
    entry = dynamic_credential_entry("custom.composio")
    surrogate = str(entry.get("surrogate", "")).strip()
    if not surrogate.startswith("hsurr:"):
        print("driver: could not obtain a surrogate for custom.composio", file=sys.stderr)
        return 1
    env = dict(os.environ)
    env["COMPOSIO_API_KEY"] = surrogate
    proc = subprocess.run(
        [os.path.expanduser("~/.local/bin/composio"), *sys.argv[1:]],
        env=env,
    )
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
