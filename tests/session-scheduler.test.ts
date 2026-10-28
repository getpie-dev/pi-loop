import { afterEach, describe, expect, it } from "vitest";
import { LoopError } from "../extensions/interval.ts";
import { type LoopMessageDetails, PROMPT_MAX_BYTES } from "../extensions/prompt.ts";
import {
  DISPATCH_CONFIRM_MS,
  type LoopDispatch,
  SessionLoopScheduler,
  type TaskDefinition,
  TTL_MS,
} from "../extensions/session-scheduler.ts";

class FakeClock {
  nowMs: number;
  constructor(nowMs: number) {
    this.nowMs = nowMs;
  }
  now(): number {
    return this.nowMs;
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

const live: SessionLoopScheduler[] = [];

afterEach(() => {
  for (const scheduler of live) scheduler.dispose();
  live.length = 0;
});

function setup(idle = true) {
  const clock = new FakeClock(Date.parse("2026-08-24T10:00:00+08:00"));
  const sent: Array<{ content: string; details: LoopMessageDetails }> = [];
  const dispatch: LoopDispatch & { idle: boolean; pending: boolean } = {
    idle,
    pending: false,
    isIdle() {
      return this.idle;
    },
    hasPendingMessages() {
      return this.pending;
    },
    sendScheduled(payload) {
      sent.push(payload);
    },
  };
  const snapshots: TaskDefinition[][] = [];
  const warnings: string[] = [];
  const scheduler = new SessionLoopScheduler({
    clock,
    dispatch,
    onMutation: (definitions) => {
      snapshots.push(definitions);
      return undefined;
    },
    onWarning: (message) => warnings.push(message),
  });
  scheduler.startSession();
  live.push(scheduler);
  return { clock, dispatch, sent, scheduler, snapshots, warnings };
}

function drain(scheduler: SessionLoopScheduler): void {
  scheduler.handleSettled();
  scheduler.tick();
}

function fire(scheduler: SessionLoopScheduler): void {
  scheduler.markStarted();
}

describe("session scheduler", () => {
  it("dispatches a due recurring task when idle and coalesces misses", () => {
    const { clock, dispatch, sent, scheduler } = setup();
    const created = scheduler.create({ prompt: "check deploy", interval: "5m" }).value;
    expect(created.interval).toBe("5m");
    expect(created.raised).toBe(false);
    expect(sent).toHaveLength(0);

    clock.nowMs = Date.parse(created.next_fire_at!);
    scheduler.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).not.toMatch(/^\//);
    expect(sent[0]!.content).toContain(created.id);
    expect(sent[0]!.content).toContain("check deploy");
    expect(sent[0]!.content).toContain("every 5m");
    expect(sent[0]!.content).not.toContain("schedule_wakeup");
    expect(sent[0]!.details.prompt).toBe("check deploy");
    fire(scheduler);

    clock.advance(30 * 60_000);
    dispatch.idle = false;
    scheduler.tick();
    expect(sent).toHaveLength(1);

    dispatch.idle = true;
    drain(scheduler);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(scheduler.list()).toHaveLength(1);
  });

  it("returns raised when the interval is lifted to 60s", () => {
    const { scheduler } = setup();
    const created = scheduler.create({ prompt: "watch", interval: "30s" }).value;
    expect(created.interval).toBe("60s");
    expect(created.raised).toBe(true);
  });

  it("keeps one pending per task while busy and drains one at a time", () => {
    const { clock, dispatch, sent, scheduler } = setup(false);
    scheduler.create({ prompt: "a", interval: "1m" });
    scheduler.create({ prompt: "b", interval: "1m" });
    clock.advance(3 * 60_000);
    scheduler.tick();
    expect(sent).toHaveLength(0);
    expect(scheduler.list().every((item) => item.pending)).toBe(true);

    dispatch.idle = true;
    drain(scheduler);
    expect(sent).toHaveLength(1);
    fire(scheduler);
    drain(scheduler);
    expect(sent).toHaveLength(2);
    expect(sent.map((item) => item.details.prompt).sort()).toEqual(["a", "b"]);
  });

  it("keeps a fireImmediately create pending while busy", () => {
    const { dispatch, sent, scheduler } = setup(false);
    const created = scheduler.create({
      prompt: "check CI",
      interval: "5m",
      fireImmediately: true,
    }).value;
    expect(created.pending).toBe(true);
    expect(created.interval).toBe("5m");
    expect(sent).toHaveLength(0);
    dispatch.idle = true;
    drain(scheduler);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.details.prompt).toBe("check CI");
  });

  it("never uses steer", () => {
    const { dispatch, scheduler } = setup();
    scheduler.create({ prompt: "ping", interval: "5m", fireImmediately: true });
    expect(Object.keys(dispatch)).not.toContain("steer");
  });

  it("releases an unstarted inFlight after 30s without resending or deleting", () => {
    const { clock, sent, scheduler, warnings } = setup();
    const created = scheduler.create({
      prompt: "ping once",
      interval: "5m",
      fireImmediately: true,
    }).value;
    scheduler.dispatchPending();
    expect(sent).toHaveLength(1);
    clock.advance(DISPATCH_CONFIRM_MS + 1);
    scheduler.tick();
    expect(sent).toHaveLength(1);
    expect(scheduler.list()[0]?.last_dispatch?.status).toBe("unconfirmed_timeout");
    expect(scheduler.list().some((item) => item.id === created.id)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("timed out; no retry was queued");
    scheduler.tick();
    expect(sent).toHaveLength(1);
  });

  it("does not time out a started run", () => {
    const { clock, sent, scheduler } = setup();
    const created = scheduler.create({
      prompt: "watch CI",
      interval: "5m",
      fireImmediately: true,
    }).value;
    scheduler.dispatchPending();
    fire(scheduler);
    clock.advance(DISPATCH_CONFIRM_MS + 1);
    scheduler.tick();
    expect(scheduler.list().some((item) => item.id === created.id)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("updates interval in place and keeps the next fire", () => {
    const { scheduler } = setup();
    const created = scheduler.create({ prompt: "check deploy", interval: "5m" }).value;
    const next = created.next_fire_at;
    const updated = scheduler.update({ id: created.id, interval: "10m" }).value;
    expect(updated.updated).toBe(true);
    expect(updated.id).toBe(created.id);
    expect(updated.interval).toBe("10m");
    expect(updated.next_fire_at).toBe(next);
    expect(scheduler.list()).toHaveLength(1);
    expect(() => scheduler.update({ id: "deadbeef", interval: "10m" })).toThrow(/TASK_NOT_FOUND/);
  });

  it("deletes future/pending without aborting in-flight work", () => {
    const { sent, scheduler } = setup();
    const created = scheduler.create({
      prompt: "watch CI",
      interval: "5m",
      fireImmediately: true,
    }).value;
    scheduler.dispatchPending();
    expect(scheduler.delete(created.id).value).toBe("future_deleted_current_running");
    expect(sent).toHaveLength(1);
    expect(scheduler.delete("deadbeef").value).toBe("not_found");
    const idle = scheduler.create({ prompt: "later", interval: "5m" }).value;
    expect(scheduler.delete(idle.id).value).toBe("deleted_before_dispatch");
  });

  it("caps at 50 tasks and no-ops ticks after shutdown", () => {
    const { dispatch, scheduler } = setup();
    for (let i = 0; i < 50; i += 1) {
      scheduler.create({ prompt: `t${i}`, interval: "5m" });
    }
    expect(() => scheduler.create({ prompt: "overflow", interval: "5m" })).toThrow(
      /LOOP_LIMIT_REACHED/,
    );
    scheduler.dispose();
    dispatch.idle = true;
    expect(() => scheduler.create({ prompt: "nope", interval: "5m" })).toThrow();
    expect(() => scheduler.tick()).not.toThrow();
  });

  it("stops firing until restart, then dispatches when idle", () => {
    const { clock, dispatch, sent, scheduler } = setup();
    const created = scheduler.create({ prompt: "check deploy", interval: "5m" }).value;
    expect(scheduler.stop(created.id).value).toBe("stopped");
    expect(scheduler.list()[0]?.stopped).toBe(true);

    clock.nowMs = Date.parse(created.next_fire_at!);
    scheduler.tick();
    expect(sent).toHaveLength(0);

    dispatch.idle = true;
    const restarted = scheduler.restart(created.id).value;
    expect(restarted.updated).toBe(true);
    expect(restarted.pending).toBe(false);
    expect(sent).toHaveLength(1);
    expect(scheduler.list()[0]?.stopped).toBe(false);
    expect(scheduler.stop("deadbeef").value).toBe("not_found");
  });

  it("validates the entire update before changing the task or persisting", () => {
    const { scheduler, snapshots } = setup();
    const created = scheduler.create({ prompt: "original", interval: "5m" }).value;
    const before = scheduler.definitions();
    expect(() =>
      scheduler.update({ id: created.id, prompt: "changed", interval: "invalid" }),
    ).toThrow(/INVALID_INTERVAL/);
    expect(scheduler.definitions()).toEqual(before);
    expect(snapshots).toHaveLength(1);
  });

  it("never dispatches expired due or locally pending tasks, even on restart", () => {
    for (const fireImmediately of [false, true]) {
      const { scheduler, clock, dispatch, sent } = setup(false);
      const created = scheduler.create({ prompt: "watch", interval: "1m", fireImmediately }).value;
      if (!fireImmediately) {
        clock.advance(60_000);
        scheduler.tick();
      }
      clock.nowMs = Date.parse(created.expires_at!);
      expect(() => scheduler.restart(created.id)).toThrow(/TASK_EXPIRED/);
      dispatch.idle = true;
      scheduler.dispatchPending();
      scheduler.tick();
      expect(sent).toHaveLength(0);
      expect(scheduler.list()).toEqual([]);
    }
  });

  it("does not retract dispatched work at expiry and records settlement, not success", () => {
    const { scheduler, clock, sent, snapshots } = setup();
    const created = scheduler.create({
      prompt: "watch",
      interval: "5m",
      fireImmediately: true,
    }).value;
    scheduler.dispatchPending();
    expect(scheduler.list()[0]).toMatchObject({
      pending: true,
      running: false,
      last_dispatch: { status: "dispatched" },
    });
    scheduler.markStarted();
    expect(scheduler.list()[0]?.running).toBe(true);
    scheduler.handleSettled();
    expect(scheduler.list()[0]?.last_dispatch?.status).toBe("settled");
    scheduler.restart(created.id);
    scheduler.markStarted();
    clock.nowMs = Date.parse(created.expires_at!);
    scheduler.tick();
    expect(scheduler.list()[0]?.running).toBe(true);
    scheduler.handleSettled();
    expect(scheduler.list()).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(snapshots).toHaveLength(2);
  });

  it("restores paused definitions without downtime replay or expiry extension", () => {
    const { scheduler, clock, sent, snapshots } = setup();
    const created = scheduler.create({
      prompt: "full standing order",
      interval: "5m",
      fireImmediately: true,
    }).value;
    scheduler.stop(created.id);
    const definitions = scheduler.definitions();
    scheduler.dispose();
    clock.advance(3_600_000);
    scheduler.startSession(definitions);
    expect(scheduler.definitions()).toEqual(definitions);
    expect(scheduler.list()[0]).toMatchObject({
      stopped: true,
      pending: false,
      running: false,
      expires_at: created.expires_at,
    });
    scheduler.tick();
    expect(sent).toHaveLength(0);
    scheduler.restart(created.id);
    expect(sent).toHaveLength(1);
    expect(scheduler.list()[0]?.next_fire_at).toBe(new Date(clock.now() + 300_000).toISOString());
    expect(snapshots).toHaveLength(3);
    expect(
      snapshots
        .flat()
        .every(
          (task) =>
            Object.keys(task).sort().join() ===
            "anchorAt,createdAt,expiresAt,id,interval,prompt,stopped",
        ),
    ).toBe(true);
  });

  it("preserves a future deadline across repeated restoration", () => {
    const { scheduler, clock, snapshots } = setup();
    const created = scheduler.create({ prompt: "watch", interval: "3h" }).value;
    const saved = snapshots[0]!;
    for (const elapsed of [25 * 60_000, 10 * 60_000]) {
      clock.advance(elapsed);
      scheduler.startSession(saved);
      expect(scheduler.list()[0]?.next_fire_at).toBe(created.next_fire_at);
      expect(scheduler.definitions()).toEqual(saved);
    }
    expect(snapshots).toHaveLength(1);
  });

  it("keeps cadence through late ticks and reload without persisting ticks or replaying misses", () => {
    const { scheduler, clock, snapshots, sent } = setup(false);
    const start = clock.now();
    scheduler.create({ prompt: "watch", interval: "5m" });
    const saved = snapshots[0]!;
    clock.advance(5 * 60_000 + 1700);
    scheduler.tick();
    expect(scheduler.list()[0]?.next_fire_at).toBe(new Date(start + 10 * 60_000).toISOString());
    clock.advance(13 * 60_000);
    scheduler.tick();
    const next = new Date(start + 20 * 60_000).toISOString();
    expect(scheduler.list()[0]).toMatchObject({ next_fire_at: next, pending: true });
    expect(scheduler.definitions()).toEqual(saved);
    expect(snapshots).toHaveLength(1);
    scheduler.startSession(saved);
    expect(scheduler.list()[0]).toMatchObject({
      next_fire_at: next,
      pending: false,
      running: false,
    });
    scheduler.tick();
    expect(sent).toHaveLength(0);
  });

  it("preserves interval-update and restart deadlines across restoration", () => {
    const { scheduler, clock, snapshots } = setup(false);
    const created = scheduler.create({ prompt: "watch", interval: "5m" }).value;
    clock.advance(2 * 60_000);
    scheduler.update({ id: created.id, interval: "10m" });
    let saved = snapshots.at(-1)!;
    clock.advance(60_000);
    scheduler.startSession(saved);
    expect(scheduler.list()[0]?.next_fire_at).toBe(created.next_fire_at);
    clock.advance(3 * 60_000);
    scheduler.tick();
    const next = new Date(Date.parse(created.next_fire_at!) + 10 * 60_000).toISOString();
    scheduler.startSession(saved);
    expect(scheduler.list()[0]?.next_fire_at).toBe(next);
    const restarted = scheduler.restart(created.id).value;
    saved = snapshots.at(-1)!;
    clock.advance(2 * 60_000);
    scheduler.startSession(saved);
    expect(scheduler.list()[0]).toMatchObject({
      next_fire_at: restarted.next_fire_at,
      pending: false,
      expires_at: created.expires_at,
    });
  });

  it("restores legacy definitions from their creation cadence", () => {
    const { scheduler, clock, snapshots } = setup();
    const created = scheduler.create({ prompt: "watch", interval: "3h" }).value;
    const legacy = { ...snapshots[0]![0]! };
    delete legacy.anchorAt;
    clock.advance(25 * 60_000);
    scheduler.startSession([legacy]);
    expect(scheduler.list()[0]?.next_fire_at).toBe(created.next_fire_at);
  });

  it("retains definitions with no interval fire before expiry", () => {
    const { scheduler, clock, snapshots } = setup();
    const created = scheduler.create({ prompt: "watch", interval: "7d" }).value;
    expect(created.next_fire_at).toBeNull();
    clock.advance(60_000);
    const saved = { ...snapshots[0]![0]! };
    for (const legacy of [false, true]) {
      if (legacy) delete saved.anchorAt;
      scheduler.startSession([saved]);
      expect(scheduler.list()[0]).toMatchObject({ id: created.id, next_fire_at: null });
    }
  });

  it("persists only successful management mutations, including the final empty state", () => {
    const { scheduler, snapshots } = setup();
    const created = scheduler.create({
      prompt: "watch",
      interval: "5m",
      fireImmediately: true,
    }).value;
    scheduler.update({ id: created.id, interval: "10m" });
    scheduler.stop(created.id);
    scheduler.restart(created.id);
    scheduler.markStarted();
    scheduler.handleSettled();
    scheduler.tick();
    expect(snapshots).toHaveLength(4);
    scheduler.delete(created.id);
    expect(snapshots).toHaveLength(5);
    expect(snapshots.at(-1)).toEqual([]);
    scheduler.dispose();
    scheduler.startSession();
    scheduler.tick();
    expect(snapshots).toHaveLength(5);
  });

  it("skips malformed and expired definitions on recovery", () => {
    const { scheduler, clock } = setup();
    scheduler.create({ prompt: "watch", interval: "5m" });
    const definition = scheduler.definitions()[0]!;
    scheduler.startSession([
      null,
      { ...definition, prompt: "" },
      { ...definition, interval: "bad" },
      { ...definition, stopped: "yes" },
      { ...definition, anchorAt: "tomorrow" },
      { ...definition, anchorAt: Number.NaN },
      { ...definition, anchorAt: -1 },
      { ...definition, anchorAt: definition.expiresAt },
    ]);
    expect(scheduler.list()).toEqual([]);
    clock.advance(TTL_MS);
    scheduler.startSession([definition]);
    expect(scheduler.list()).toEqual([]);
  });

  it("rejects empty and oversized prompts with distinct codes", () => {
    const { scheduler } = setup();
    try {
      scheduler.create({ prompt: "", interval: "5m" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LoopError);
      expect((error as LoopError).code).toBe("EMPTY_PROMPT");
    }
    try {
      scheduler.create({ prompt: "x".repeat(PROMPT_MAX_BYTES + 1), interval: "5m" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LoopError);
      expect((error as LoopError).code).toBe("PROMPT_TOO_LARGE");
    }
  });
});
