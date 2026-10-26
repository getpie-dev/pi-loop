# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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

## 1.0.0 (2026-10-26)


### ⚠ BREAKING CHANGES

* rename package to @getpie/pi-loop

### Features

* add session-scoped /loop Pi package ([fd44b2b](https://github.com/getpie-dev/pi-loop/commit/fd44b2b02ebe7d62e0f33063da406a5592d4d709))
* pause and restart loops from /loops ([6101123](https://github.com/getpie-dev/pi-loop/commit/6101123a9cfed77b6bb4acf27db45963e750c3c9))
* restore loop tasks in their original Pi session ([f3d0acb](https://github.com/getpie-dev/pi-loop/commit/f3d0acb21465b47418658a5f6ad4a27bdfb9d08b))
* show session loops in TUI widget and /loops ([31309c4](https://github.com/getpie-dev/pi-loop/commit/31309c472407f40fcbe3d34778bc4aa2b4a6e52d))
* stop a loop from /loops with d, x, or delete ([d798611](https://github.com/getpie-dev/pi-loop/commit/d798611459b7c6232c48c5410f7a9ab12b0cb2b8))


### Bug Fixes

* flatten scheduler_create schema and align tool copy with Grok Build ([4a08d38](https://github.com/getpie-dev/pi-loop/commit/4a08d382658c2f3e176ebe32013cb18f61ead459))
* keep the loop widget on one line ([2562f80](https://github.com/getpie-dev/pi-loop/commit/2562f80396e3d25568f47c72b7548e5994237ef8))
* require Pi 1.4.0 before activating loop ([cb2f7bf](https://github.com/getpie-dev/pi-loop/commit/cb2f7bf6ca6e793ca368cfbe939eed05f0e75ad0))
* show [loop] countdown in TUI, drop task ids ([4ac57aa](https://github.com/getpie-dev/pi-loop/commit/4ac57aa803dcf7f38e20e9e200f1b0a40d4c68d7))


### Code Refactoring

* rename package to @getpie/pi-loop ([c40da40](https://github.com/getpie-dev/pi-loop/commit/c40da40f8963fc9435ba3b453fa84e7cd7c05888))

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
