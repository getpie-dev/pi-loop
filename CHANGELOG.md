# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.3 (2026-09-08)

### Changed

- `scheduler_create` returns a one-line confirmation with the id instead of raw JSON.
- Scheduler tool copy and `/loop` instruction follow Grok Build: interval scheduler only, no clock-time/weekday routing. Fire content is a short frame plus the stored prompt.

### Fixed

- Flatten `scheduler_create` to a single object schema. `Type.Union` / `anyOf` was arriving as an empty `input_schema` on Anthropic, so the model called the tool with `{}`.

## 0.0.2 (2026-09-05)

### Added

- Active-loop widget and `/loops` list
- Keyboard controls to pause, restart, and remove loops from `/loops`

### Changed

- Show a compact `[loop]` countdown without task IDs

## 0.0.1 (2026-08-31)

### Added

- Session-scoped `/loop` command that asks the model to call `scheduler_create`
- `scheduler_create` / `scheduler_list` / `scheduler_delete` tools
- Compact intervals (`5m` / `2h` / `60s`), 7-day TTL, max 50 tasks
- In-memory scheduler: tasks disappear on process exit, `/reload`, `/new`, `/resume`, and `/fork`
