# @getpie/pi-loop

Session-scoped `/loop` for [Pi](https://pi.dev). Compact-interval scheduler in the current session: `scheduler_create`, `scheduler_list`, `scheduler_delete`.

Fires with `sendMessage({ customType: "@getpie/pi-loop" }, { triggerTurn: true })` so the fire is a custom message, not a user bubble. In-memory only: tasks disappear on process exit, `/reload`, `/new`, `/resume`, and `/fork`.

## Install

Local checkout:

```bash
pi install /Users/dinq/Code/oxwen11/pi-loop
```

Or load once without installing:

```bash
pi -ne -e /Users/dinq/Code/oxwen11/pi-loop --no-session
```

After publishing:

```bash
pi install npm:@getpie/pi-loop
```

## Use

```text
/loop 5m check the deploy
/loop check CI
/loop
/loops
/loop list
```

`/loop` asks the model to call `scheduler_create`. It does not create the loop itself.

In TUI, active loops stay above the input. `/loops` or `/loop list` opens the full list.

| Input | What the model should do |
|---|---|
| `/loop 5m check the deploy` | `interval=5m`, standing order, `fire_immediately=true` |
| `/loop check CI` | pick an interval, default `5m`, tell you, do not ask |
| `/loop` / `/loop 15m` | no prompt → `.pi/loop.md`, `~/.pi/agent/loop.md`, or the built-in maintenance prompt |

Clock-time, weekday, and one-shot delays are not this tool. Use cron / systemd / GitHub Actions.

## Limits

- Interval: `Ns` / `Nm` / `Nh` / `Nd`. Below 60 seconds is raised to `60s`. Above 7 days is rejected.
- Max 50 tasks. 7-day TTL.
- Session idle and no pending messages before a fire. Busy fires wait; missed fires coalesce to one.
- Completion boundary is `agent_settled`.
- No restart recovery, no queue revoke, no loop-scoped abort.

## Develop

```bash
npm install
npm test
npm run typecheck
npm run lint
pi -ne -e . --no-session
```
