# Changelog

All notable changes to SQLSage are documented here.

## 0.1.0 — 2026-08-01

- Added the installable `sqlsage analyze` command.
- Added file, inline, and standard-input query sources.
- Added catalog JSON and PostgreSQL schema SQL inputs.
- Added saved PostgreSQL JSON plan and reusable evidence-bundle support.
- Added safe live PostgreSQL planning and explicit read-only `--analyze` mode.
- Added text, Markdown, and deterministic JSON output.
- Added correctness-first rules for nullable `NOT IN`, aggregate fan-out, outer-join
  intent, non-sargable predicates, deep pagination, repeated correlated work, JSON
  extraction, and related index/rewrite change sets.
- Added a twelve-query PostgreSQL acceptance corpus and package installation smoke test.
