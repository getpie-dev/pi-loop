import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queryObjects } from "node:v8";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WIDGET_ID } from "../extensions/format.ts";
import { LoopIntegration } from "../extensions/integration.ts";
import type { LoopPickResult } from "../extensions/list-ui.ts";
import type { SchedulerListItem } from "../extensions/scheduler.ts";
import { Scheduler } from "../extensions/scheduler.ts";
import {
  LOOP_CUSTOM_TYPE,
  LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE,
  LOOP_STATE_CUSTOM_TYPE,
} from "../extensions/types.ts";

type StateEntry = { type: "custom"; customType: string; data: unknown };
const live: LoopIntegration[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const loop of live) loop.dispose();
  live.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function setup(sessionId = "original", entries: StateEntry[] = []) {
  const sendMessage = vi.fn();
  const appendEntry = vi.fn((customType: string, data?: unknown) => {
    entries.push({ type: "custom", customType, data });
  });
  const loop = new LoopIntegration({ sendMessage, appendEntry });
  live.push(loop);
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    isProjectTrusted: vi.fn(() => false),
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
      getBranch: () => {
        throw new Error("task state must be session-wide");
      },
    },
    ui: {
      notify: vi.fn(),
      setWidget: vi.fn(),
      custom: vi.fn(async (): Promise<LoopPickResult> => ({ action: "close" })),
    },
  };
  const context = ctx as unknown as ExtensionContext;
  loop.recover(context, "startup");
  return { loop, ctx, context, entries, sendMessage, appendEntry };
}

const list = (loop: LoopIntegration): SchedulerListItem[] =>
  JSON.parse(loop.listTool().content[0]!.text);

describe("LoopIntegration", () => {
  it("injects the standing-order instruction without creating a task or using a user message", async () => {
    const { loop, context, sendMessage } = setup();
    await loop.handleLoopCommand("check CI", context);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        customType: LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE,
        display: false,
      }),
      { triggerTurn: true },
    );
    const instruction = String(sendMessage.mock.calls[0]![0].content);
    for (const text of ["scheduler_create", "fire_immediately: true", "check CI", "Default to 5m"])
      expect(instruction).toContain(text);
    for (const text of ["schedule_wakeup", "Clock-time", "weekday"])
      expect(instruction).not.toContain(text);
    expect(list(loop)).toEqual([]);
  });

  it("resolves project prompt files only when the Pi context is trusted", async () => {
    const directory = mkdtempSync("/tmp/pi-loop-prompt-");
    const agentDir = join(directory, "agent");
    try {
      mkdirSync(join(directory, ".pi"));
      mkdirSync(agentDir);
      writeFileSync(join(directory, ".pi", "loop.md"), "Trusted project standing order");
      writeFileSync(join(agentDir, "loop.md"), "Personal standing order");
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      const { loop, ctx, context, sendMessage } = setup();
      ctx.cwd = directory;
      await loop.handleLoopCommand("", context);
      expect(sendMessage.mock.lastCall![0].content).toContain("Personal standing order");
      expect(sendMessage.mock.lastCall![0].content).not.toContain("Trusted project standing order");
      ctx.isProjectTrusted.mockReturnValue(true);
      await loop.handleLoopCommand("", context);
      expect(sendMessage.mock.lastCall![0].content).toContain("Trusted project standing order");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates and updates with unchanged confirmations and tool details, and validates arguments", () => {
    const { loop } = setup();
    const created = loop.createTool({ prompt: "check deploy", interval: "30s" });
    const task = created.details;
    expect(task).toMatchObject({ interval: "60s", raised: true, updated: false });
    expect(created.content[0]!.text).toBe(
      `Loop ${task.id} created, every 60s, next interval fire at ${task.next_fire_at}. Expires at ${task.expires_at}. Interval was raised to the 60s minimum.`,
    );
    const immediate = loop.createTool({
      prompt: "check deploy",
      interval: "5m",
      fire_immediately: true,
    });
    expect(immediate.details.pending).toBe(true);
    expect(immediate.content[0]!.text).toContain(
      "A fire is queued until the session is idle with no pending messages.",
    );
    expect(immediate.content[0]!.text).not.toContain("60s minimum");
    const updated = loop.createTool({ id: task.id, interval: "10m" });
    expect(updated.details).toMatchObject({ id: task.id, interval: "10m", updated: true });
    expect(updated.content[0]!.text).toBe(
      `Loop ${task.id} updated, every 10m, next interval fire at ${updated.details.next_fire_at}. Expires at ${task.expires_at}.`,
    );
    const queued = loop.createTool({ id: immediate.details.id, interval: "15m" });
    expect(queued.details).toMatchObject({ pending: true, updated: true });
    expect(queued.content[0]!.text).toContain("A fire is queued until the session is idle");
    expect(() => loop.createTool({ id: task.id })).toThrow(/NOTHING_TO_UPDATE/);
    expect(() => loop.createTool({ interval: "5m" })).toThrow(
      /prompt is required when creating a task/,
    );
    const emptyId = loop.createTool({ id: "", prompt: "check empty id", interval: "5m" });
    expect(emptyId.details.updated).toBe(false);
    expect(emptyId.content[0]!.text).toContain("created, every 5m");
    expect(Object.keys(task).sort()).toEqual([
      "expires_at",
      "id",
      "interval",
      "next_fire_at",
      "pending",
      "raised",
      "stopped",
      "updated",
    ]);
  });

  it("lists through both commands without starting a turn", async () => {
    const { loop, ctx, context, sendMessage } = setup();
    await loop.showLoops(context);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No session loops. Use /loop [interval] [prompt] to create one.",
      "info",
    );
    loop.createTool({ prompt: "check deploy", interval: "5m" });
    ctx.ui.notify.mockClear();
    await loop.handleLoopCommand("list", context);
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("check deploy"),
      "info",
    );
    expect(ctx.ui.notify.mock.calls[0]![0]).toContain("5m");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(JSON.parse(loop.listTool().content[0]!.text)).toEqual(list(loop));
  });

  it("pauses the selected task without removing other tasks", async () => {
    const { loop, ctx, context } = setup();
    ctx.hasUI = true;
    const { details: task } = loop.createTool({ prompt: "check deploy", interval: "5m" });
    loop.createTool({ prompt: "watch CI", interval: "10m" });
    ctx.ui.custom.mockResolvedValueOnce({ action: "stop", id: task.id });
    await loop.showLoops(context);
    expect(list(loop)).toHaveLength(2);
    expect(list(loop).find((item) => item.id === task.id)?.stopped).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Paused loop. Already dispatched work was not cancelled.",
      "info",
    );
  });

  it("resumes and removes through the picker with local-only cancellation feedback", async () => {
    const { loop, ctx, context } = setup();
    ctx.hasUI = true;
    const { details: task } = loop.createTool({ prompt: "check deploy", interval: "5m" });
    ctx.ui.custom
      .mockResolvedValueOnce({ action: "restart", id: task.id })
      .mockResolvedValueOnce({ action: "remove", id: task.id });
    await loop.showLoops(context);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Restarted loop; queued until idle.", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Removed loop. Already dispatched work was not cancelled.",
      "info",
    );
    expect(list(loop)).toEqual([]);
  });

  it("keeps one compact widget line, suppresses unchanged renders, and shows dispatch lifecycle", () => {
    const { loop, ctx, context, sendMessage, appendEntry } = setup();
    ctx.hasUI = true;
    loop.createTool({ prompt: "check deploy", interval: "5m", fire_immediately: true });
    loop.createTool({ prompt: "watch CI", interval: "10m" });
    const lines = ctx.ui.setWidget.mock.lastCall![1];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[loop] waiting · check deploy · +1");
    const writes = appendEntry.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(sendMessage.mock.calls[0]).toMatchObject([
      { customType: LOOP_CUSTOM_TYPE, display: true, details: { prompt: "check deploy" } },
      { triggerTurn: true },
    ]);
    loop.agentStarted();
    expect(ctx.ui.setWidget.mock.lastCall![1][0]).toContain("running");
    loop.agentSettled(context);
    expect(ctx.ui.setWidget.mock.lastCall![1][0]).toContain("next 5m");
    const renders = ctx.ui.setWidget.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(renders);
    expect(appendEntry).toHaveBeenCalledTimes(writes);
  });

  it("releases context and timer resources on disposal without writing a shutdown snapshot", () => {
    class OwnedContext {
      cwd = process.cwd();
      hasUI = false;
      isIdle = () => true;
      hasPendingMessages = () => false;
      sessionManager = { getSessionId: () => "owned", getEntries: () => [] };
    }
    const before = queryObjects(OwnedContext, { format: "count" });
    const appendEntry = vi.fn();
    const loop = new LoopIntegration({ appendEntry, sendMessage: vi.fn() });
    live.push(loop);
    loop.recover(new OwnedContext() as unknown as ExtensionContext, "startup");
    loop.createTool({ prompt: "release me", interval: "5m" });
    // Use a fresh context to exercise the deferred settlement callback as well.
    loop.agentSettled(new OwnedContext() as unknown as ExtensionContext);
    expect(vi.getTimerCount()).toBe(2);
    expect(queryObjects(OwnedContext, { format: "count" })).toBe(before + 1);
    loop.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(list(loop)).toEqual([]);
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(queryObjects(OwnedContext, { format: "count" })).toBe(before);
    expect(() => loop.createTool({ prompt: "inactive", interval: "5m" })).toThrow(
      /session is not active/,
    );
    loop.dispose();
  });

  it.each(["stop", "restart", "remove"] as const)(
    "ignores a %s picker continuation after disposal",
    async (action) => {
      const { loop, ctx, context, appendEntry, sendMessage } = setup();
      ctx.hasUI = true;
      const { details: task } = loop.createTool({ prompt: "watch", interval: "5m" });
      let finish!: (result: LoopPickResult) => void;
      ctx.ui.custom.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const interaction = loop.showLoops(context);
      loop.dispose();
      loop.agentStarted();
      loop.agentSettled(context);
      await loop.handleLoopCommand("inactive", context);
      await loop.showLoops(context);
      expect(ctx.ui.setWidget.mock.lastCall).toEqual([WIDGET_ID, undefined]);
      const renders = ctx.ui.setWidget.mock.calls.length;
      finish({ action, id: task.id });
      await interaction;
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(ctx.ui.setWidget).toHaveBeenCalledTimes(renders);
      expect(appendEntry).toHaveBeenCalledTimes(1);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("Pi recovery and operation feedback", () => {
  it("translates Pi lifecycle reasons into definition restoration and checkpoint requirements", () => {
    const restore = vi.spyOn(Scheduler.prototype, "restore");
    const { loop, context, entries } = setup();
    loop.createTool({ prompt: "watch", interval: "5m" });
    const definitions = (entries[0]!.data as { tasks: unknown[] }).tasks;
    loop.recover(context, "reload");
    expect(restore).toHaveBeenLastCalledWith(definitions, { checkpointRequired: true });
    for (const reason of ["new", "fork"] as const) {
      loop.recover(context, reason);
      expect(restore).toHaveBeenLastCalledWith([], { checkpointRequired: false });
    }
    loop.recover(context, "resume");
    expect(restore).toHaveBeenLastCalledWith(definitions, { checkpointRequired: false });
  });
  it("restores full definitions, pause state and original expiry without downtime replay", async () => {
    const original = setup();
    const active = original.loop.createTool({
      prompt: `standing order ${"x".repeat(100)}`,
      interval: "5m",
      fire_immediately: true,
    }).details;
    const paused = original.loop.createTool({ prompt: "paused", interval: "10m" }).details;
    original.ctx.hasUI = true;
    original.ctx.ui.custom.mockResolvedValueOnce({ action: "stop", id: paused.id });
    await original.loop.showLoops(original.context);
    expect(original.entries[0]).toMatchObject({
      customType: LOOP_STATE_CUSTOM_TYPE,
      data: { version: 1, sessionId: "original", tasks: [{ id: active.id }] },
    });
    original.loop.dispose();
    expect(original.entries).toHaveLength(3);
    vi.setSystemTime(Date.now() + 3_600_000);
    const reopened = setup("original", original.entries);
    expect(list(reopened.loop)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: active.id,
          pending: false,
          running: false,
          expires_at: active.expires_at,
          next_fire_at: new Date(Date.now() + 300_000).toISOString(),
        }),
        expect.objectContaining({
          id: paused.id,
          stopped: true,
          pending: false,
          expires_at: paused.expires_at,
        }),
      ]),
    );
    vi.advanceTimersByTime(1000);
    expect(reopened.sendMessage).not.toHaveBeenCalled();
    expect(reopened.entries).toHaveLength(3);
  });

  it("uses the latest session-wide updates and final empty snapshot", () => {
    const original = setup();
    const { details: task } = original.loop.createTool({ prompt: "old", interval: "5m" });
    original.loop.createTool({ id: task.id, prompt: "updated", interval: "10m" });
    const reopened = setup("original", original.entries);
    reopened.loop.recover(reopened.context, "reload");
    expect(list(reopened.loop)).toMatchObject([
      { id: task.id, interval: "10m", prompt_preview: "updated" },
    ]);
    const removed = reopened.loop.deleteTool(task.id);
    expect(removed.details).toEqual({});
    expect(removed.content[0]!.text).toContain("deleted_before_dispatch");
    expect(original.entries.at(-1)?.data).toEqual({ version: 1, sessionId: "original", tasks: [] });
    reopened.loop.recover(reopened.context, "resume");
    expect(list(reopened.loop)).toEqual([]);
    expect(original.entries).toHaveLength(3);
  });

  it("does not inherit tasks into new or forked sessions, but restores their own tasks", () => {
    const original = setup();
    original.loop.createTool({ prompt: "original only", interval: "5m" });
    for (const reason of ["new", "fork", "startup"] as const) {
      const fork = setup("fork-id", [...original.entries]);
      fork.loop.recover(fork.context, reason);
      expect(list(fork.loop)).toEqual([]);
      const own = fork.loop.createTool({ prompt: "fork own task", interval: "10m" }).details;
      expect(list(setup("fork-id", fork.entries).loop)).toMatchObject([
        { id: own.id, prompt_preview: "fork own task" },
      ]);
    }
    expect(list(setup("original", original.entries).loop)).toMatchObject([
      { prompt_preview: "original only" },
    ]);
  });

  it("deduplicates definitions, except one explicit checkpoint after reload, including picker actions", async () => {
    const { loop, ctx, context, entries, appendEntry } = setup();
    const { details: task } = loop.createTool({ prompt: "watch", interval: "5m" });
    loop.createTool({ id: task.id, prompt: "watch", interval: "5m" });
    expect(appendEntry).toHaveBeenCalledTimes(1);
    loop.recover(context, "reload");
    expect(appendEntry).toHaveBeenCalledTimes(1);
    loop.createTool({ id: task.id, prompt: "watch", interval: "5m" });
    expect(appendEntry).toHaveBeenCalledTimes(2);
    loop.createTool({ id: task.id, prompt: "watch" });
    expect(appendEntry).toHaveBeenCalledTimes(2);
    ctx.hasUI = true;
    loop.recover(context, "reload");
    for (const [action, count] of [
      ["restart", 3],
      ["stop", 4],
      ["stop", 4],
      ["restart", 5],
      ["restart", 5],
      ["remove", 6],
    ] as const) {
      ctx.ui.custom.mockResolvedValueOnce({ action, id: task.id });
      await loop.showLoops(context);
      expect(appendEntry).toHaveBeenCalledTimes(count);
    }
    expect(entries.at(-1)?.data).toEqual({ version: 1, sessionId: "original", tasks: [] });
    loop.recover(context, "resume");
    expect(list(loop)).toEqual([]);
  });

  it("formats failed-save results with actual IDs and unchanged details, then clears feedback on retry", () => {
    const { loop, ctx, entries, appendEntry } = setup();
    ctx.hasUI = true;
    appendEntry.mockImplementationOnce((customType, data) => {
      entries.push({ type: "custom", customType, data });
      throw new Error("EISDIR");
    });
    const created = loop.createTool({ prompt: "watch", interval: "5m" });
    expect(created.content[0]!.text).toContain(created.details.id);
    expect(created.content[0]!.text).toContain(
      "applied in memory but could not be saved for restart",
    );
    expect(created.details).not.toHaveProperty("warning");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("could not be saved for restart"),
      "warning",
    );
    const saved = loop.createTool({ id: created.details.id, prompt: "watch" });
    expect(saved.content[0]!.text).not.toContain("could not be saved");
    expect(appendEntry).toHaveBeenCalledTimes(2);
    appendEntry.mockImplementationOnce(() => {
      throw new Error("EISDIR");
    });
    const removed = loop.deleteTool(created.details.id);
    expect(removed.details).toEqual({});
    expect(removed.content[0]!.text).toContain("could not be saved");
    expect(() => loop.deleteTool(created.details.id)).toThrow(/^TASK_NOT_FOUND:/);
  });

  it("presents the selected operation warning without making it sticky", async () => {
    const { loop, ctx, context, appendEntry } = setup();
    ctx.hasUI = true;
    const { details: task } = loop.createTool({ prompt: "watch", interval: "5m" });
    appendEntry.mockImplementationOnce(() => {
      throw new Error("EISDIR");
    });
    ctx.ui.custom.mockResolvedValueOnce({ action: "stop", id: task.id });
    await loop.showLoops(context);
    expect(ctx.ui.notify.mock.lastCall).toEqual([
      expect.stringContaining(
        "Paused loop. Already dispatched work was not cancelled. Warning: Loop change applied in memory",
      ),
      "warning",
    ]);
    ctx.ui.custom.mockResolvedValueOnce({ action: "restart", id: task.id });
    await loop.showLoops(context);
    expect(ctx.ui.notify.mock.lastCall).toEqual(["Restarted loop; queued until idle.", "info"]);
  });

  it("ignores unsupported or malformed owned state without resurrecting earlier tasks", () => {
    const { loop, context, entries } = setup();
    loop.createTool({ prompt: "old", interval: "5m" });
    entries.push({
      type: "custom",
      customType: LOOP_STATE_CUSTOM_TYPE,
      data: { version: 2, sessionId: "original", tasks: [] },
    });
    loop.recover(context, "startup");
    expect(list(loop)).toEqual([]);
  });
});
