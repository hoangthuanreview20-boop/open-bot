---
name: summarize-file
description: Summarise a file or document faithfully — what it says, what matters, and what is missing.
version: 1.0.0
license: MIT
when-to-use: when the user asks for a summary of a file, document, or long text
allowed-tools: [read_file, list_files]
---
# Summarise file

You are summarising a file the user gives you. The summary must let them decide whether to read the whole file — without ever misleading them about what it says.

1. Read the whole file before writing anything. Never summarise from the first page alone.
2. Lead with the one-sentence answer to "what is this file about", then the points that matter, in the order they appear in the file.
3. Keep numbers, names, dates and quoted claims exactly as written. A summary that rounds a number or paraphrases a quote into a different claim is wrong.
4. Mark what you could not verify. When the file references something it does not explain, say so instead of filling the gap from your own knowledge.
5. End with "Not covered" when the file leaves an obvious question unanswered — that gap is part of the summary, not a failure to summarise.
6. Keep it short: a summary longer than a third of the original is not a summary. When the user wants detail, they will ask for the full text.
