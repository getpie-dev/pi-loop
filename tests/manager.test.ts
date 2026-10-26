import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopManager } from "../extensions/manager.ts";
import type { TaskDefinition } from "../extensions/scheduler.ts";

vi.mock("@earendil-works/pi-coding-agent", () => {
  throw new Error("LoopManager must not load the Pi host, even through its dependencies");
});

const live: LoopManager[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const manager of live) manager.dispose();
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
  const manager = new LoopManager({
    clock: { now: () => Date.now() },
    dispatch,
    saveDefinitions,
    onChange,
    onWarning,
  });
  live.push(manager);
  manager.restore(definitions, { checkpointRequired });
  return { manager, saved, saveDefinitions, dispatch, onChange, onWarning };
}

describe("host-independent LoopManager", () => {
  it("deduplicates recoverable definitions and checkpoints once when explicitly required", () => {
    const { manager, saved, saveDefinitions } = setup();
    expect(saveDefinitions).not.toHaveBeenCalled();
    const { value: task } = manager.create({ prompt: "watch", interval: "5m" });
    manager.update({ id: task.id, prompt: "watch" });
    expect(saved).toHaveLength(1);
    const definitions = saved[0]!;
    manager.restore(definitions);
    manager.update({ id: task.id, prompt: "watch" });
    expect(saved).toHaveLength(1);
    manager.restore(definitions, { checkpointRequired: true });
    expect(saved).toHaveLength(1);
    manager.update({ id: task.id, prompt: "watch" });
    expect(saved).toHaveLength(2);
    manager.update({ id: task.id, prompt: "watch" });
    expect(saved).toHaveLength(2);
    manager.pause(task.id);
    manager.pause(task.id);
    expect(saved).toHaveLength(3);
    expect(saved.at(-1)![0]?.stopped).toBe(true);
    manager.resume(task.id);
    manager.resume(task.id);
    expect(saved).toHaveLength(4);
    manager.remove(task.id);
    expect(saved.at(-1)).toEqual([]);
    expect(saved).toHaveLength(5);
  });

  it("returns failed-save outcomes with actual values, and does not lend warnings to other operations", () => {
    const { manager, saveDefinitions } = setup();
    saveDefinitions.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    const created = manager.create({ prompt: "watch", interval: "5m" });
    const id = created.value.id;
    expect(created.warning).toContain("applied in memory but could not be saved for restart");
    expect(manager.list()[0]?.id).toBe(id);
    expect(manager.pause("deadbeef")).toEqual({ value: "not_found" });
    expect(manager.remove("deadbeef")).toEqual({ value: "not_found" });
    expect(() => manager.update({ id, prompt: "changed", interval: "invalid" })).toThrow(
      /INVALID_INTERVAL/,
    );
    expect(saveDefinitions).toHaveBeenCalledTimes(1);
    expect(manager.update({ id, prompt: "watch" }).warning).toBeUndefined();
    expect(saveDefinitions).toHaveBeenCalledTimes(2);
    manager.update({ id, prompt: "watch" });
    expect(saveDefinitions).toHaveBeenCalledTimes(2);
    expect(created.warning).toContain("could not be saved");
    saveDefinitions.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    const removed = manager.remove(id);
    expect(removed.value).toBe("deleted_before_dispatch");
    expect(removed.warning).toContain("could not be saved");
    expect(manager.list()).toEqual([]);
    const replacement = manager.create({ prompt: "replacement", interval: "5m" });
    expect(replacement.warning).toBeUndefined();
    expect(saveDefinitions).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])(
    "applies, checkpoints and notifies before explicit resume dispatch; save failure=%s",
    (failSave) => {
      const { manager, saved, saveDefinitions, onChange, dispatch } = setup();
      const { value: task } = manager.create({ prompt: "watch", interval: "5m" });
      manager.pause(task.id);
      const order: string[] = [];
      saveDefinitions.mockImplementation((tasks) => {
        expect(manager.list()[0]?.stopped).toBe(false);
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
      const outcome = manager.resume(task.id);
      expect(order).toEqual(["checkpoint", "change", "dispatch", "change"]);
      expect(outcome.value).toMatchObject({ id: task.id, stopped: false });
      expect(Boolean(outcome.warning)).toBe(failSave);
    },
  );

  it("restores pause and absolute expiry without restoring pending/running work or replaying downtime", () => {
    const { manager, saved } = setup();
    const { value: task } = manager.create({
      prompt: "full standing order",
      interval: "5m",
      fireImmediately: true,
    });
    manager.pause(task.id);
    manager.dispose();
    vi.setSystemTime(Date.now() + 3_600_000);
    const restored = setup(saved.at(-1));
    expect(restored.manager.list()).toMatchObject([
      { id: task.id, stopped: true, pending: false, running: false, expires_at: task.expires_at },
    ]);
    vi.advanceTimersByTime(1000);
    expect(restored.dispatch.sendScheduled).not.toHaveBeenCalled();
    expect(restored.saveDefinitions).not.toHaveBeenCalled();
    vi.setSystemTime(Date.parse(task.expires_at!));
    expect(() => restored.manager.resume(task.id)).toThrow(/TASK_EXPIRED/);
    restored.manager.restore(saved.at(-1));
    expect(restored.manager.list()).toEqual([]);
  });

  it("uses injected idle/queue checks and dispatch lifecycle without a context or tool wrapper", () => {
    const { manager, dispatch, saveDefinitions } = setup();
    manager.create({ prompt: "watch", interval: "5m", fireImmediately: true });
    dispatch.isIdle.mockReturnValue(false);
    vi.advanceTimersByTime(1000);
    expect(dispatch.sendScheduled).not.toHaveBeenCalled();
    dispatch.isIdle.mockReturnValue(true);
    dispatch.hasPendingMessages.mockReturnValue(true);
    vi.advanceTimersByTime(1000);
    expect(dispatch.sendScheduled).not.toHaveBeenCalled();
    dispatch.hasPendingMessages.mockReturnValue(false);
    manager.settle();
    vi.advanceTimersByTime(0);
    expect(dispatch.sendScheduled).toHaveBeenCalledOnce();
    expect(manager.list()[0]).toMatchObject({ pending: true, running: false });
    manager.markStarted();
    expect(manager.list()[0]?.running).toBe(true);
    manager.settle();
    expect(manager.list()[0]?.last_dispatch?.status).toBe("settled");
    expect(saveDefinitions).toHaveBeenCalledTimes(1);
  });

  it("releases interval/deferred drain resources and task state without a disposal checkpoint", () => {
    const { manager, saveDefinitions, dispatch } = setup();
    manager.create({ prompt: "watch", interval: "5m" });
    manager.settle();
    expect(vi.getTimerCount()).toBe(2);
    manager.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(manager.list()).toEqual([]);
    vi.advanceTimersByTime(600_000);
    expect(dispatch.sendScheduled).not.toHaveBeenCalled();
    expect(saveDefinitions).toHaveBeenCalledTimes(1);
    expect(() => manager.create({ prompt: "inactive", interval: "5m" })).toThrow(
      /session is not active/,
    );
  });
});
