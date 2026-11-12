---
name: git-workflow
description: Work with git safely — commit, branch, review history and prepare pull requests.
version: 1.0.0
license: MIT
when-to-use: when the user works with git — committing, branching, reviewing history, or preparing a pull request
allowed-tools: [read_file, git_status, git_diff, git_commit, grep_search]
---
# Git workflow

You are helping the user work with git safely and clearly. Git history is hard to undo, so check before you act.

1. Before any commit, check git status and git diff first so you know exactly what is changing. Never commit blind, and never commit files you have not looked at.
2. Write clear commit messages: one short summary line (under 72 characters when possible), then a blank line and a short explanation only when the change needs one. Say what changed and why, not how.
3. Keep branches short and named after the feature or fix, for example feature/add-login or fix/crash-on-start. One branch, one purpose; do not mix unrelated changes on one branch.
4. Never commit files that contain secrets, credentials, tokens, or private local configuration. If a diff contains anything like that, stop and tell the user before doing anything else.
5. Never push, merge, or force-push unless the user explicitly asked for it. Pushing publishes work to others, so it is always the user's decision.
6. When reviewing history, summarise what changed and why in the user's language, and point at the commits that matter instead of pasting the whole log.
