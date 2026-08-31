# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.1 (2026-08-31)

### Added

- Session-scoped `/loop` command that asks the model to call `scheduler_create`
- `scheduler_create` / `scheduler_list` / `scheduler_delete` tools
- Compact intervals (`5m` / `2h` / `60s`), 7-day TTL, max 50 tasks
- In-memory scheduler: tasks disappear on process exit, `/reload`, `/new`, `/resume`, and `/fork`
