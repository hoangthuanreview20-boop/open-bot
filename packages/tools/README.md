# @open-bot/tools

Sandboxed tools for the open-bot agent. Every file/shell operation is
confined to the agent's workspace directory (`ctx.workspaceDir`).

## Tools (`createDefaultTools()`)

| Tool | needsApproval | What it does |
| --- | --- | --- |
| `read_file` | no | Read a file in the workspace: plain text (max 100 KB); PDF, DOCX, XLSX return extracted text (max 5 MB, no OCR for scanned PDFs) |
| `write_file` | **yes** | Write a file in the workspace (creates parent dirs) |
| `list_files` | no | List a workspace directory (max 200 entries) |
| `shell_exec` | **yes** | Run a shell command in the workspace (60 s timeout, denylist) |
| `web_search` | no | DuckDuckGo HTML search, no API key (max 8 results) |
| `web_fetch` | no | GET a page, return text with HTML stripped (max 20 000 chars) |
| `git_status` | no | `git status --porcelain` |
| `git_diff` | no | `git diff` (max 10 000 chars) |
| `git_commit` | **yes** | `git add -A` + `git commit -m` |
| `http_get` | no | GET JSON/text from any API URL |

## Sandbox (`src/sandbox.ts`)

- `resolveWithin(workspaceDir, targetPath)` — throws on path traversal,
  including escapes via symlinks (resolves the longest existing ancestor).
- `runShell(command, cwd, opts)` — platform shell (`/bin/sh -c` /
  PowerShell), cwd must lie inside the workspace, 60 s default timeout,
  output capped at 200 KB, env allowlist only (`PATH`/`HOME`/`TEMP`/…,
  never `*KEY*`/`*TOKEN*`/`*SECRET*`/…).
- `DENYLIST_COMMANDS` / `assertCommandAllowed()` — blocks `rm -rf /|~`,
  `mkfs`, `dd if=`, `shutdown`/`reboot`, `chmod 777 /`, piping to a shell
  (`curl … | sh`), `sudo`, `passwd`, fork bombs, …

## Notes / open issues

- `web_search` scrapes DuckDuckGo's HTML endpoint; DuckDuckGo may block
  automated requests or change its markup — the tool returns a clear error
  in that case instead of silently returning nothing.
- The denylist is a safety net, not a full shell parser: a determined
  agent could still spell a dangerous command in an unusual way
  (e.g. via variables or encoded strings). Approval (`needsApproval`)
  on `shell_exec` / `write_file` / `git_commit` is the real control.
- Tool results are truncated to 20 000 chars; `runShell` output to 200 KB.
