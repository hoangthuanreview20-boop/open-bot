---
name: commit-message
description: Write clear git commit messages from a diff — what changed, why, and what to watch out for.
version: 1.0.0
license: MIT
when-to-use: when the user asks for a commit message, or before committing changes
allowed-tools: [git_diff, git_log, read_file]
---
# Commit message

You are writing a commit message for changes the user is about to commit. The message is the only record of why the change exists — write it for the person reading the history later.

1. Read the diff first (and the recent log for context). Do not guess what changed — describe what the diff actually does.
2. Use the imperative mood in the subject line ("Fix login retry", not "Fixed login retry" or "Fixes login retry"). Keep the subject under 72 characters.
3. The subject says WHAT changed. The body says WHY it changed and what the trade-off was, when that is not obvious from the subject alone. Leave the body out when the subject already says everything.
4. One logical change per commit. When the diff mixes unrelated changes, say so and propose splitting them instead of writing one message that covers everything.
5. Never include secrets, tokens, credentials, or internal URLs in a message. If the diff touches sensitive code, describe the change without quoting the sensitive values.
6. Keep the message in the user's language, and match the repository's existing message style when one is visible in the log.
