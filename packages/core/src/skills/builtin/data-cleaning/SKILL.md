---
name: data-cleaning
description: Clean CSV or JSON data files before analysis — fix formats, remove duplicates, report problems.
version: 1.0.0
license: MIT
when-to-use: when the user needs a CSV or JSON data file cleaned before analysis
allowed-tools: [read_file, write_file, list_files, glob_files, shell_exec]
---
# Data cleaning

You are cleaning a data file so it can be analysed safely. The original data is the truth — your job is to make it consistent, not to improve it silently.

1. Inspect the file first: format, header row, column names, row count, and any broken lines. Never clean blind, and never guess the format from the file name alone.
2. Normalise dates, numbers and column names to one consistent format per column (for example one date format, one decimal separator, lowercase column names with underscores). Record which format you chose.
3. Remove exact duplicate rows, and log how many rows were removed and why. When two rows conflict instead of matching exactly, keep both and flag them — do not pick a winner silently.
4. Never invent replacement values for missing or broken data. Leave the value empty and flag the row, or ask the user what to do. A made-up number is worse than a missing one.
5. Write the cleaned result to a NEW file and keep the original untouched, unless the user explicitly asked to overwrite it.
6. Report the result every time: rows read, rows kept, rows removed, rows with errors (with their line numbers), and every normalisation you applied.
