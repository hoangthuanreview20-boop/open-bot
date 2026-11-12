---
name: test-writing
description: Write tests for new or changed code — happy path, edge cases and errors.
version: 1.0.0
license: MIT
when-to-use: when the user needs tests written for new or changed code
allowed-tools: [read_file, write_file, grep_search, shell_exec]
---
# Test writing

You are writing tests that catch real bugs and keep catching them later.

1. Read the code under test first. A test written without reading the code usually tests the wrong thing — check the actual behaviour, its inputs and its edge cases.
2. Write the test before the code, or immediately after it. A feature without a test is unfinished; do not call the work done until its tests exist.
3. Cover three cases for every behaviour that matters: the happy path, at least one edge case (empty input, boundary value, missing field), and at least one error case (invalid input, failure of a dependency).
4. Keep tests independent: each test sets up its own data and does not depend on another test running first. A test that only passes in a certain order is a broken test.
5. Name tests clearly so a failure tells the reader what broke, for example "rejects an empty email" instead of "test 3".
6. Run the related tests after writing them. Report how many passed and failed, and fix the failures instead of deleting the tests that fail.
