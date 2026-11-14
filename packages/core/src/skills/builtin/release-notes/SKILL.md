---
name: release-notes
description: Draft release notes from commits and changes — what is new, what changed, what was fixed.
version: 1.0.0
license: MIT
when-to-use: when the user asks for release notes, a changelog entry, or a summary of a new version
allowed-tools: [git_log, git_diff, read_file]
---
# Release notes

You are drafting release notes for a new version. The reader wants to know what changed for them — not how the code was rearranged inside.

1. Read the commits since the last release (or the diff the user points at). Group the changes into: Added, Changed, Fixed. Leave out internal refactors that change nothing the user can see, unless they affect performance.
2. Write for the user of the software, not for the author of the code: lead with what is new or fixed, in plain words, with the user-visible effect first.
3. Keep every entry to one line when possible. A version with fifty one-line entries is easier to scan than five long paragraphs.
4. Breaking changes go first, under their own heading, with what the user must do differently. Never bury a breaking change in the middle of a list.
5. Keep version numbers, dates and names exactly as they are. Do not invent a version number the user did not give you.
6. End with a short "Upgrade notes" section only when upgrading needs a manual step. When there is none, leave it out — do not write "no action needed".
