#!/usr/bin/env python3
"""Driver for the Composio live test (v0.72).

Fetches the `hsurr:` surrogate for the registered custom.composio
credential from authd and spawns the Node live script with it in an
environment variable. The surrogate is NEVER printed, logged or written
to a file: it only travels in the child process environment, and the
Node script scrubs it out of every string it prints or writes.

Sentinel swaps the surrogate for the real project API key on approved
egress to backend.composio.dev — the real key value never appears in
this repo, in any log, or in any process output. This mirrors how
bin/composio.py uses the same credential.
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    entry = dynamic_credential_entry("custom.composio")
    surrogate = str(entry.get("surrogate", "")).strip()
    if not surrogate.startswith("hsurr:"):
        print("driver: could not obtain a surrogate for custom.composio", file=sys.stderr)
        return 1
    env = dict(os.environ)
    env["COMPOSIO_KEY_SURROGATE"] = surrogate
    # Optional first arg: node script to run (default live.mjs).
    script = sys.argv[1] if len(sys.argv) > 1 else "live.mjs"
    rest = sys.argv[2:] if len(sys.argv) > 1 else []
    # The live script prints only scrubbed output (no surrogate, no key).
    proc = subprocess.run(
        ["node", os.path.join(HERE, script), *rest],
        env=env,
    )
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
