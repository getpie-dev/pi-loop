# @getpie/pi-loop

Session-scoped `/loop` for [Pi](https://pi.dev). Compact-interval scheduler in the current session: `scheduler_create`, `scheduler_list`, `scheduler_delete`.

Fires with `sendMessage({ customType: "@getpie/pi-loop" }, { triggerTurn: true })` so the fire is a custom message, not a user bubble. Task definitions and pause state are saved in Pi session records and restored when reopening the same session or using `/reload`. New and forked sessions start empty; `--no-session` stays ephemeral.

## Install

Requires Pi >= 1.4.0. Older hosts cannot activate the extension and receive an upgrade message.

```bash
pi install git:github.com/getpie-dev/pi-loop
```

Update later with `pi update git:github.com/getpie-dev/pi-loop`.

Local checkout:

```bash
pi install /Users/dinq/Code/oxwen11/pi-loop
```

Or load once without installing:

```bash
pi -ne -e /Users/dinq/Code/oxwen11/pi-loop --no-session
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

In TUI, active loops stay above the input as `[loop] next 12s · prompt`. `/loops` or `/loop list` opens the full list: `d` stop, `r` restart, `x` remove.

| Input | What the model should do |
|---|---|
| `/loop 5m check the deploy` | `interval=5m`, standing order, `fire_immediately=true` |
| `/loop check CI` | pick an interval, default `5m`, tell you, do not ask |
| `/loop` / `/loop 15m` | no prompt → `.pi/loop.md`, `~/.pi/agent/loop.md`, or the built-in maintenance prompt |

## Limits

- Interval: `Ns` / `Nm` / `Nh` / `Nd`. Below 60 seconds is raised to `60s`. Above 7 days is rejected.
- Max 50 tasks. 7-day TTL.
- Session idle and no pending messages before a fire. Busy fires wait; missed fires coalesce to one.
- Completion boundary is `agent_settled`, not proof that the task succeeded. `scheduler_list` includes only the latest dispatch fact per task in session memory; it is not restored. Unconfirmed start timeouts produce a warning with no automatic retry; later regular fires remain scheduled.
- Pause/remove clears future and locally pending fires, not work already dispatched. No queue revoke or loop-scoped abort.

## Reopen a session

Resume the original Pi session to recover task IDs, full prompts, cadence, pause state, and the original absolute expiry. Restoration uses the latest session-wide state, so conversation tree navigation does not undo task management. A fork does not inherit tasks, but tasks created inside it can be restored there.

After restoration, the next interval fire is planned from the current time. Downtime is not replayed, expired tasks are skipped, and expiry is never extended. Paused tasks stay paused; restart queues a fire until idle and resets the next interval deadline. Interval updates keep the existing next deadline.

Pi owns storage; there is no separate task database. A session must contain a conversation message for Pi to flush a new session file. No tasks run while Pi is closed. Pending/running work and recent dispatch facts are never restored.

Only changed recoverable definitions append plugin state snapshots, except for one checkpoint on the next explicit management operation after `/reload`: Pi may have retained an unsaved entry in memory. Normal conversation, tool, and scheduled-message records still follow Pi's transcript rules. If saving fails, the change stays applied in memory and the result/UI warns that it could not be saved for restart. No automatic retry or rollback is attempted; a later explicit management operation can save again.

## Develop

Development and tests use Pi 1.4.0.

```bash
npm install
npm test
npm run typecheck
npm run lint
pi -ne -e . --no-session
```

`npm test` includes an offline Pi 1.4.0 disk-backed reload and process-exit/resume smoke. It uses a temporary persistent session and never calls a model.
