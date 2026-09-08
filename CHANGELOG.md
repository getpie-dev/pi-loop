# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 (2026-09-08)


### ⚠ BREAKING CHANGES

* rename package to @getpie/pi-loop

### Features

* add session-scoped /loop Pi package ([fd44b2b](https://github.com/getpie-dev/pi-loop/commit/fd44b2b02ebe7d62e0f33063da406a5592d4d709))
* pause and restart loops from /loops ([6101123](https://github.com/getpie-dev/pi-loop/commit/6101123a9cfed77b6bb4acf27db45963e750c3c9))
* show session loops in TUI widget and /loops ([31309c4](https://github.com/getpie-dev/pi-loop/commit/31309c472407f40fcbe3d34778bc4aa2b4a6e52d))
* stop a loop from /loops with d, x, or delete ([d798611](https://github.com/getpie-dev/pi-loop/commit/d798611459b7c6232c48c5410f7a9ab12b0cb2b8))


### Bug Fixes

* flatten scheduler_create schema and align tool copy with Grok Build ([4a08d38](https://github.com/getpie-dev/pi-loop/commit/4a08d382658c2f3e176ebe32013cb18f61ead459))
* keep the loop widget on one line ([2562f80](https://github.com/getpie-dev/pi-loop/commit/2562f80396e3d25568f47c72b7548e5994237ef8))
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
