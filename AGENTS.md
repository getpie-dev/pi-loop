# @getpie/pi-loop — Agent Context

## Project Overview

Pi package that adds session-scoped `/loop` to [Pi](https://pi.dev). The command injects a schedule instruction; the model must call `scheduler_create`. Runtime is an in-memory interval scheduler with a 1-second tick.

**Tech stack:** TypeScript (no build step — pi loads `.ts` via jiti), typebox for tool schemas, biome for lint/format, vitest for tests.

### Structure

```
extensions/index.ts       # TypeBox schemas, registrations, and explicit Pi operation adapters
extensions/integration.ts # Pi lifecycle/records, commands/tools, prompt trust, picker, widget
extensions/scheduler.ts   # Host-independent Scheduler: orchestration and checkpoint/dedup policy
extensions/session-scheduler.ts # SessionLoopScheduler: authoritative tasks, dispatch state, timers
extensions/interval.ts    # Compact interval parse
extensions/prompt.ts      # /loop instruction + scheduled fire content
extensions/format.ts      # TUI widget and /loops list formatting
extensions/types.ts       # customType constants
tests/                    # Scheduler capability, Pi integration/wiring, session scheduler, persistence, formatting
package.json              # Pi manifest, peer deps, npm publish config
```

The host-independent `Scheduler` accepts only domain clock/dispatch, definition-storage, and change/warning capabilities. It owns checkpoint deduplication around exactly one private `SessionLoopScheduler`; restoration accepts definitions and a checkpoint-required flag, never a Pi context or lifecycle reason. `LoopIntegration` localizes the Pi context/render cache, session record selection/envelopes, and all command/tool/UI translation. Management mutations return `{ value, warning? }`: checkpoint feedback belongs to the completed operation, not ambient warning state. The mutation hook checkpoints before change notification and explicit restart dispatch. Disposal clears runtime resources without appending a snapshot.

### Key constraints

- **No build step** — pi loads `.ts` via jiti. Do not add a compile step.
- **Peer dependencies** — `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, `typebox` are provided by pi at runtime. Keep `"*"` ranges. Do not bundle them.
- **No Xiaohu/pie host deps** — this package must run in stock Pi CLI.
- **Session-owned persistence** — save definitions and pause state using Pi >= 1.4.0 public session records. Restore only the same session; no separate database, cross-session inheritance, downtime replay, or background execution. `--no-session` stays ephemeral.
- **2-space indentation** — biome.

### Behaviour that must not regress

- `/loop` sends a hidden `customType: "@getpie/pi-loop/schedule"` message with `triggerTurn: true`. It does not create the task.
- `/loops` and `/loop list` query in-memory loops and do not start a turn. TUI shows active loops in a widget above the editor. In the list: `d` stop (pause), `r` restart, `x` / Backspace / Delete remove.
- Fires use `customType: "@getpie/pi-loop"` with `triggerTurn: true`. Never `sendUserMessage`.
- Tools: `scheduler_create` (create + in-place update), `scheduler_list`, `scheduler_delete`.
- `scheduler_create` is a single object schema (all fields optional). Do not use `Type.Union` / `anyOf`: Anthropic `convertTools` only copies top-level `properties`, so a Union arrives as an empty `input_schema`. Create vs update is decided at runtime (`id` present → update; otherwise `prompt` and `interval` are required).
- Intervals are compact (`5m` / `2h` / `60s`), not 5-field cron. No `schedule_wakeup`, no `run_at`.
- Drain only when idle and no pending messages. Coalesce missed fires. `agent_settled` is the completion boundary.

---

## Git and PR conventions

- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`.
- Rebase merges only.

---

## Documentation

Keep `README.md` focused on installation, usage, and user-visible behavior. Repository architecture, CI, testing, and release procedures belong in `AGENTS.md`, not the README.

## CI and releases

CI runs on pushes and pull requests to `main`, using Blacksmith's 2 vCPU Ubuntu runners. The Blacksmith GitHub App must have access to this repository.

Release runs only when a `v*` git tag is pushed, never on ordinary branch pushes. The tag must exactly match `v` plus the version in `package.json`. Update `package.json` and `package-lock.json` to a new, unpublished version, commit the change, then tag that commit and push the version tag explicitly. Do not create or push a release tag unless the user requests a release.

Publishing uses npm OIDC, not an `NPM_TOKEN`. The publish job stays on a GitHub-hosted runner because npm trusted publishing does not support third-party runners. It validates the tag, runs type checking, tests, and lint, publishes to npm, then creates the GitHub release.

One-time setup:

1. In the npm package's **Settings → Trusted publishing**, add a GitHub Actions publisher with organization `getpie-dev`, repository `pi-loop`, workflow filename `release.yml`, and environment `publish`. Allow direct `npm publish`. A new publisher must complete its first successful publish within two days or be recreated.
2. Create the repository environment `publish` and restrict deployment tags to `v*`. Add a required reviewer if releases should need an extra approval.

If publishing fails, fix the cause and rerun the failed job for the same tag. If npm publication already succeeded, do not republish that version; complete the GitHub release separately.

---

## Development commands

```bash
npm test               # vitest
npm run typecheck      # tsc --noEmit
npm run lint           # biome check
npm run lint:fix       # biome check --write
npm run format         # biome format --write
```

### Testing with pi

```bash
pi -ne -e . --no-session -p "Call scheduler_list. You MUST use the scheduler_list tool."
pi -ne -e . --no-session
# then: /loop 5m check the deploy
```

Always use `-ne` with `-e .` so globally installed extensions do not interfere.

---

## Anti-patterns

- Do not import Xiaohu or pie packages.
- Do not write a custom task database. Persist only versioned, session-owned definition snapshots through `pi.appendEntry`; use `getEntries()` for session-wide restoration. Never persist pending/running state, countdown ticks, or shutdown cleanup.
- Do not fire while the session is busy or has pending messages.
- Do not use `steer` to inject loop prompts.
- Tool parameters must use typebox, not raw TypeScript types.
