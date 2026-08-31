import { afterEach, describe, expect, it } from "vitest";
import { LoopError } from "../extensions/interval.ts";
import { type LoopMessageDetails, PROMPT_MAX_BYTES } from "../extensions/prompt.ts";
import {
  DISPATCH_CONFIRM_MS,
  type LoopDispatch,
  SessionLoopScheduler,
} from "../extensions/scheduler.ts";

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
  const scheduler = new SessionLoopScheduler({ clock, dispatch });
  scheduler.startSession();
  live.push(scheduler);
  return { clock, dispatch, sent, scheduler };
}

function drain(scheduler: SessionLoopScheduler): void {
  scheduler.handleSettled();
  scheduler.tick();
}

function fire(scheduler: SessionLoopScheduler): void {
  scheduler.markStarted();
}

describe("scheduler", () => {
  it("dispatches a due recurring task when idle and coalesces misses", () => {
    const { clock, dispatch, sent, scheduler } = setup();
    const created = scheduler.create({ prompt: "check deploy", interval: "5m" });
    expect(created.interval).toBe("5m");
    expect(created.raised).toBe(false);
    expect(sent).toHaveLength(0);

    clock.nowMs = Date.parse(created.next_fire_at!);
    scheduler.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).not.toMatch(/^\//);
    expect(sent[0]!.content).toContain(created.id);
    expect(sent[0]!.content).toContain("scheduler_delete");
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
    const created = scheduler.create({ prompt: "watch", interval: "30s" });
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
    const created = scheduler.create({ prompt: "check CI", interval: "5m", fireImmediately: true });
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
    const { clock, sent, scheduler } = setup();
    const created = scheduler.create({
      prompt: "ping once",
      interval: "5m",
      fireImmediately: true,
    });
    scheduler.dispatchPending();
    expect(sent).toHaveLength(1);
    clock.advance(DISPATCH_CONFIRM_MS + 1);
    scheduler.tick();
    expect(sent).toHaveLength(1);
    expect(scheduler.list().some((item) => item.id === created.id)).toBe(true);
  });

  it("does not time out a started run", () => {
    const { clock, sent, scheduler } = setup();
    const created = scheduler.create({ prompt: "watch CI", interval: "5m", fireImmediately: true });
    scheduler.dispatchPending();
    fire(scheduler);
    clock.advance(DISPATCH_CONFIRM_MS + 1);
    scheduler.tick();
    expect(scheduler.list().some((item) => item.id === created.id)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("updates interval in place and keeps the next fire", () => {
    const { scheduler } = setup();
    const created = scheduler.create({ prompt: "check deploy", interval: "5m" });
    const next = created.next_fire_at;
    const updated = scheduler.update({ id: created.id, interval: "10m" });
    expect(updated.updated).toBe(true);
    expect(updated.id).toBe(created.id);
    expect(updated.interval).toBe("10m");
    expect(updated.next_fire_at).toBe(next);
    expect(scheduler.list()).toHaveLength(1);
    expect(() => scheduler.update({ id: "deadbeef", interval: "10m" })).toThrow(/TASK_NOT_FOUND/);
  });

  it("deletes future/pending without aborting in-flight work", () => {
    const { sent, scheduler } = setup();
    const created = scheduler.create({ prompt: "watch CI", interval: "5m", fireImmediately: true });
    scheduler.dispatchPending();
    expect(scheduler.delete(created.id)).toBe("future_deleted_current_running");
    expect(sent).toHaveLength(1);
    expect(scheduler.delete("deadbeef")).toBe("not_found");
    const idle = scheduler.create({ prompt: "later", interval: "5m" });
    expect(scheduler.delete(idle.id)).toBe("deleted_before_dispatch");
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
