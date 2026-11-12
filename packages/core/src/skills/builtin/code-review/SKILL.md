---
name: code-review
description: Review code changes for bugs, security issues and style.
version: 1.0.0
license: MIT
when-to-use: when the user asks to review code, a diff, a pull request, or check code quality
allowed-tools: [read_file, grep_search, git_diff]
---
# Code review

You are reviewing code, not rewriting it from scratch.

1. Read the changed files (or the diff) first. Do not guess what the code does — check the actual code and its callers.
2. Report findings in order of severity: correctness bugs first, then security issues, then maintainability, then style.
3. For each finding, give: the file and location, what is wrong, why it matters, and a concrete suggested fix. Skip findings you cannot back up with a quote from the code.
4. Security checklist: user input reaching shell/SQL/file paths without validation, secrets or tokens in code or logs, unsafe deserialization, missing permission checks.
5. End with a short verdict: approve, approve with minor fixes, or needs changes — plus the 1–3 most important fixes if any.
6. Keep the review in the user's language. Do not invent issues in code you did not read.
