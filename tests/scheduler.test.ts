import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDefinition } from "../extensions/scheduler.ts";
import { Scheduler } from "../extensions/scheduler.ts";

vi.mock("@earendil-works/pi-coding-agent", () => {
  throw new Error("Scheduler must not load the Pi host, even through its dependencies");
});

const live: Scheduler[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const scheduler of live) scheduler.dispose();
  live.length = 0;
  vi.useRealTimers();
});

function setup(definitions: unknown[] = [], checkpointRequired = false) {
  const saved: TaskDefinition[][] = [];
  const saveDefinitions = vi.fn((tasks: TaskDefinition[]) => {
    saved.push(tasks);
  });
  const dispatch = {
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    sendScheduled: vi.fn(),
  };
  const onChange = vi.fn();
  const onWarning = vi.fn();
  const scheduler = new Scheduler({
    clock: { now: () => Date.now() },
    dispatch,
    saveDefinitions,
    onChange,
    onWarning,
  });
  live.push(scheduler);
  scheduler.restore(definitions, { checkpointRequired });
  return { scheduler, saved, saveDefinitions, dispatch, onChange, onWarning };
}

describe("host-independent Scheduler", () => {
  it("deduplicates recoverable definitions and checkpoints once when explicitly required", () => {
    const { scheduler, saved, saveDefinitions } = setup();
    expect(saveDefinitions).not.toHaveBeenCalled();
    const { value: task } = scheduler.create({ prompt: "watch", interval: "5m" });
    scheduler.update({ id: task.id, prompt: "watch" });
    expect(saved).toHaveLength(1);
    const definitions = saved[0]!;
    scheduler.restore(definitions);
    scheduler.update({ id: task.id, prompt: "watch" });
    expect(saved).toHaveLength(1);
    scheduler.restore(definitions, { checkpointRequired: true });
    expect(saved).toHaveLength(1);
    scheduler.update({ id: task.id, prompt: "watch" });
    expect(saved).toHaveLength(2);
    scheduler.update({ id: task.id, prompt: "watch" });
    expect(saved).toHaveLength(2);
    scheduler.pause(task.id);
    scheduler.pause(task.id);
    expect(saved).toHaveLength(3);
    expect(saved.at(-1)![0]?.stopped).toBe(true);
    scheduler.resume(task.id);
    scheduler.resume(task.id);
    expect(saved).toHaveLength(4);
    scheduler.remove(task.id);
    expect(saved.at(-1)).toEqual([]);
    expect(saved).toHaveLength(5);
  });

  it("returns failed-save outcomes with actual values, and does not lend warnings to other operations", () => {
    const { scheduler, saveDefinitions } = setup();
    saveDefinitions.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    const created = scheduler.create({ prompt: "watch", interval: "5m" });
    const id = created.value.id;
    expect(created.warning).toContain("applied in memory but could not be saved for restart");
    expect(scheduler.list()[0]?.id).toBe(id);
    expect(scheduler.pause("deadbeef")).toEqual({ value: "not_found" });
    expect(scheduler.remove("deadbeef")).toEqual({ value: "not_found" });
    expect(() => scheduler.update({ id, prompt: "changed", interval: "invalid" })).toThrow(
      /INVALID_INTERVAL/,
    );
    expect(saveDefinitions).toHaveBeenCalledTimes(1);
    expect(scheduler.update({ id, prompt: "watch" }).warning).toBeUndefined();
    expect(saveDefinitions).toHaveBeenCalledTimes(2);
    scheduler.update({ id, prompt: "watch" });
    expect(saveDefinitions).toHaveBeenCalledTimes(2);
    expect(created.warning).toContain("could not be saved");
    saveDefinitions.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    const removed = scheduler.remove(id);
    expect(removed.value).toBe("deleted_before_dispatch");
    expect(removed.warning).toContain("could not be saved");
    expect(scheduler.list()).toEqual([]);
    const replacement = scheduler.create({ prompt: "replacement", interval: "5m" });
    expect(replacement.warning).toBeUndefined();
    expect(saveDefinitions).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])(
    "applies, checkpoints and notifies before explicit resume dispatch; save failure=%s",
    (failSave) => {
      const { scheduler, saved, saveDefinitions, onChange, dispatch } = setup();
      const { value: task } = scheduler.create({ prompt: "watch", interval: "5m" });
      scheduler.pause(task.id);
      const order: string[] = [];
      saveDefinitions.mockImplementation((tasks) => {
        expect(scheduler.list()[0]?.stopped).toBe(false);
        order.push("checkpoint");
        if (failSave) throw new Error("storage unavailable");
        saved.push(tasks);
      });
      onChange.mockImplementation(() => {
        order.push("change");
      });
      dispatch.sendScheduled.mockImplementation(() => {
        order.push("dispatch");
      });
      const outcome = scheduler.resume(task.id);
      expect(order).toEqual(["checkpoint", "change", "dispatch", "change"]);
      expect(outcome.value).toMatchObject({ id: task.id, stopped: false });
      expect(Boolean(outcome.warning)).toBe(failSave);
    },
  );

  it("restores pause and absolute expiry without restoring pending/running work or replaying downtime", () => {
    const { scheduler, saved } = setup();
    const { value: task } = scheduler.create({
      prompt: "full standing order",
      interval: "5m",
      fireImmediately: true,
    });
    scheduler.pause(task.id);
    scheduler.dispose();
    vi.setSystemTime(Date.now() + 3_600_000);
    const restored = setup(saved.at(-1));
    expect(restored.scheduler.list()).toMatchObject([
      { id: task.id, stopped: true, pending: false, running: false, expires_at: task.expires_at },
    ]);
    vi.advanceTimersByTime(1000);
    expect(restored.dispatch.sendScheduled).not.toHaveBeenCalled();
    expect(restored.saveDefinitions).not.toHaveBeenCalled();
    vi.setSystemTime(Date.parse(task.expires_at!));
    expect(() => restored.scheduler.resume(task.id)).toThrow(/TASK_EXPIRED/);
    restored.scheduler.restore(saved.at(-1));
    expect(restored.scheduler.list()).toEqual([]);
  });

  it("uses injected idle/queue checks and dispatch lifecycle without a context or tool wrapper", () => {
    const { scheduler, dispatch, saveDefinitions } = setup();
    scheduler.create({ prompt: "watch", interval: "5m", fireImmediately: true });
    dispatch.isIdle.mockReturnValue(false);
    vi.advanceTimersByTime(1000);
    expect(dispatch.sendScheduled).not.toHaveBeenCalled();
    dispatch.isIdle.mockReturnValue(true);
    dispatch.hasPendingMessages.mockReturnValue(true);
    vi.advanceTimersByTime(1000);
    expect(dispatch.sendScheduled).not.toHaveBeenCalled();
    dispatch.hasPendingMessages.mockReturnValue(false);
    scheduler.settle();
    vi.advanceTimersByTime(0);
    expect(dispatch.sendScheduled).toHaveBeenCalledOnce();
    expect(scheduler.list()[0]).toMatchObject({ pending: true, running: false });
    scheduler.markStarted();
    expect(scheduler.list()[0]?.running).toBe(true);
    scheduler.settle();
    expect(scheduler.list()[0]?.last_dispatch?.status).toBe("settled");
    expect(saveDefinitions).toHaveBeenCalledTimes(1);
  });

  it("releases interval/deferred drain resources and task state without a disposal checkpoint", () => {
    const { scheduler, saveDefinitions, dispatch } = setup();
    scheduler.create({ prompt: "watch", interval: "5m" });
    scheduler.settle();
    expect(vi.getTimerCount()).toBe(2);
    scheduler.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler.list()).toEqual([]);
    vi.advanceTimersByTime(600_000);
    expect(dispatch.sendScheduled).not.toHaveBeenCalled();
    expect(saveDefinitions).toHaveBeenCalledTimes(1);
    expect(() => scheduler.create({ prompt: "inactive", interval: "5m" })).toThrow(
      /session is not active/,
    );
  });
});
