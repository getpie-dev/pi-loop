# @getpie/pi-loop — Agent Context

## Project Overview

Pi package that adds session-scoped `/loop` to [Pi](https://pi.dev). The command injects a schedule instruction; the model must call `scheduler_create`. Runtime is an in-memory interval scheduler with a 1-second tick.

**Tech stack:** TypeScript (no build step — pi loads `.ts` via jiti), typebox for tool schemas, biome for lint/format, vitest for tests.

### Structure

```
extensions/index.ts       # Factory: /loop, scheduler_* tools, session lifecycle
extensions/scheduler.ts   # SessionLoopScheduler
extensions/interval.ts    # Compact interval parse
extensions/prompt.ts      # /loop instruction + scheduled fire content
extensions/types.ts       # customType constants
tests/                    # Unit tests for the contract, interval, scheduler
package.json              # Pi manifest, peer deps, npm publish config
```

### Key constraints

- **No build step** — pi loads `.ts` via jiti. Do not add a compile step.
- **Peer dependencies** — `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, `typebox` are provided by pi at runtime. Keep `"*"` ranges. Do not bundle them.
- **No Xiaohu/pie host deps** — this package must run in stock Pi CLI.
- **In-memory only** — no disk persistence, no cross-session recovery.
- **2-space indentation** — biome.

### Behaviour that must not regress

- `/loop` sends a hidden `customType: "@getpie/pi-loop/schedule"` message with `triggerTurn: true`. It does not create the task.
- Fires use `customType: "@getpie/pi-loop"` with `triggerTurn: true`. Never `sendUserMessage`.
- Tools: `scheduler_create` (create + in-place update), `scheduler_list`, `scheduler_delete`.
- Intervals are compact (`5m` / `2h` / `60s`), not 5-field cron. No `schedule_wakeup`, no `run_at`.
- Drain only when idle and no pending messages. Coalesce missed fires. `agent_settled` is the completion boundary.

---

## Git and PR conventions

- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`.
- Rebase merges only.

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
- Do not persist tasks to disk unless the user asks for it.
- Do not fire while the session is busy or has pending messages.
- Do not use `steer` to inject loop prompts.
- Tool parameters must use typebox, not raw TypeScript types.
