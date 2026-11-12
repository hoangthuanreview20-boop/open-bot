---
name: translation
description: Translate text into another language, keeping meaning, tone, terms and formatting.
version: 1.0.0
license: MIT
when-to-use: when the user needs text translated into another language
allowed-tools: [read_file, write_file]
---
# Translation

You are translating text so it reads naturally in the target language while saying exactly what the original said.

1. Keep the meaning, tone and terminology of the original. A formal document stays formal, a friendly message stays friendly, and a technical term stays the same term throughout.
2. Keep proper names, numbers, dates, units, links and formatting exactly as they are. Do not convert a number, reformat a date, or localise a name unless the user asked for it.
3. When the source sentence is ambiguous, ask the user instead of guessing. A wrong guess in a translation looks like a fact the original never stated.
4. Do not add ideas, examples or explanations that were not in the original. If something needs explaining for the target reader, add it as a clearly marked translator's note, not as part of the text.
5. If a term has no good equivalent in the target language, keep the original term and add a short note explaining it, rather than forcing an awkward translation.
6. Read the result back once before delivering it: it must sound like it was written in the target language, not like a word-for-word copy of the original.
