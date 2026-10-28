# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.0.6 (2026-10-28)

### Fixed

- Keep the loop summary on one screen row by truncating long prompts, including Chinese and emoji. Show hours and remaining minutes instead of rounding up to whole hours or days.

## 0.0.5 (2026-10-27)

### Changed

- Release automation only; no runtime changes.

## 0.0.4 (2026-10-26)

### Added

- Restore task definitions and pause state from the original Pi session, preserving IDs and absolute expiry without replaying downtime. New/forked sessions and `--no-session` do not inherit tasks.
- Show the latest transient dispatch fact in `scheduler_list` and warn when start confirmation times out, without automatic retry. Settlement does not imply business success.

### Fixed

- Skip duplicate recovery snapshots for unchanged task definitions, including repeated pause/restart requests. After reload, checkpoint once on the next explicit management operation because restored in-memory entries may not be saved.
- Report session-save failures as applied-in-memory changes with a warning, preserving task IDs and allowing later explicit operations to save again.
- Validate all update fields before changing a task.
- Prevent new dispatch at or after expiry, including pending fires and expired restarts, without interrupting already dispatched work.

### Changed

- Encapsulate Loop orchestration and checkpoint policy in a host-independent `Scheduler`, bridged by explicit Pi integration callbacks. Pi tool responses, snapshot records, operation-scoped save warnings, and the compact widget remain unchanged.
- Direct `SessionLoopScheduler` create/update/stop/restart/delete calls now return `{ value, warning? }`; mutation hooks receive definitions and return an optional save warning.
- Include cadence, next planned fire, and expiry in create/update feedback. Describe immediate fires as queued until idle; pause/remove does not cancel dispatched work. Keep the existing single-line widget.
- Require Pi >= 1.4.0 and use Pi 1.4.0 for development and tests. Older hosts receive an upgrade message instead of activating the extension.

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
