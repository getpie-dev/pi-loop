import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piLoopExtension from "../extensions/index.ts";
import type { CreateResult } from "../extensions/scheduler.ts";
import {
  LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE,
  LOOP_STATE_CUSTOM_TYPE,
} from "../extensions/types.ts";

const host = vi.hoisted(() => ({ VERSION: "1.4.0" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    get VERSION() {
      return host.VERSION;
    },
  };
});

beforeEach(() => {
  host.VERSION = "1.4.0";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Handler = (...args: never[]) => unknown;

type StateEntry = { type: "custom"; customType: string; data: unknown };

function fakePi(sessionId = "original", entries: StateEntry[] = []) {
  const commands = new Map<string, { description?: string; handler: Handler }>();
  const tools = new Map<string, { description: string; parameters: unknown; execute: Handler }>();
  const events = new Map<string, Handler>();
  const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      events.set(event, ((payload: unknown, ctx: Record<string, unknown>) => {
        if (event === "session_start") {
          ctx.sessionManager = {
            getSessionId: () => sessionId,
            getEntries: () => entries,
            getBranch: () => {
              throw new Error("task state must be session-wide");
            },
          };
        }
        return handler((payload ?? { reason: "startup" }) as never, ctx as never);
      }) as Handler);
    },
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    registerCommand(name: string, options: { description?: string; handler: Handler }) {
      commands.set(name, options);
    },
    registerTool(tool: {
      name: string;
      description: string;
      parameters: unknown;
      execute: Handler;
    }) {
      tools.set(tool.name, tool);
    },
    sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
      sent.push({ message, options });
    },
    sendUserMessage() {
      throw new Error("loop must not send user messages");
    },
  };
  piLoopExtension(pi as unknown as ExtensionAPI);
  return { commands, tools, events, sent, entries, appendEntry: pi.appendEntry };
}

describe("minimum host version", () => {
  it.each(["0.84.2", "1.3.99", "1.4.0-rc.1"])(
    "rejects Pi %s before registering any capabilities",
    (version) => {
      host.VERSION = version;
      const pi = {
        on: vi.fn(),
        registerCommand: vi.fn(),
        registerTool: vi.fn(),
      };
      expect(() => piLoopExtension(pi as unknown as ExtensionAPI)).toThrow(
        `@getpie/pi-loop requires Pi >= 1.4.0 (running ${version}). Upgrade Pi and reload the extension.`,
      );
      expect(pi.on).not.toHaveBeenCalled();
      expect(pi.registerCommand).not.toHaveBeenCalled();
      expect(pi.registerTool).not.toHaveBeenCalled();
    },
  );

  it.each(["1.4.0", "1.4.0+build.1", "1.4.1", "1.5.0", "1.10.0", "2.0.0"])(
    "activates on Pi %s",
    (version) => {
      host.VERSION = version;
      const { commands, tools, events } = fakePi();
      expect([...commands.keys()]).toEqual(["loop", "loops"]);
      expect([...tools.keys()]).toEqual(["scheduler_create", "scheduler_list", "scheduler_delete"]);
      expect(events.has("session_start")).toBe(true);
    },
  );
});

describe("extension contract", () => {
  it("registers /loop, scheduler tools, and settled lifecycle", () => {
    const { commands, tools, events } = fakePi();
    expect([...commands.keys()]).toEqual(["loop", "loops"]);
    expect([...tools.keys()]).toEqual(["scheduler_create", "scheduler_list", "scheduler_delete"]);
    expect(events.has("session_start")).toBe(true);
    expect(events.has("agent_start")).toBe(true);
    expect(events.has("agent_settled")).toBe(true);
    expect(events.has("session_shutdown")).toBe(true);
    expect(events.has("agent_end")).toBe(false);
    expect(events.has("before_agent_start")).toBe(false);
    expect(commands.get("loop")!.description).toContain("Ask the model");
    expect(commands.get("loops")!.description).toContain("List session loops");
    expect(tools.get("scheduler_create")!.description).toContain("recurring interval");
    expect(tools.get("scheduler_create")!.description).not.toContain("clock-time");
    expect(tools.get("scheduler_delete")!.description).toContain("Cancel a scheduled task");
  });

  it("uses a single object schema Anthropic can flatten to input_schema.properties", () => {
    const { tools } = fakePi();
    const schema = tools.get("scheduler_create")!.parameters as {
      anyOf?: unknown;
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(schema.anyOf).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toHaveProperty("interval");
    expect(schema.properties).toHaveProperty("prompt");
    expect(schema.properties).toHaveProperty("fire_immediately");
    expect(schema.properties).toHaveProperty("id");
    expect(schema.properties).not.toHaveProperty("cron");
    expect(schema.properties).not.toHaveProperty("run_at");
  });

  it("injects a schedule instruction and lets the model create the loop", async () => {
    const { commands, events, sent, tools } = fakePi();
    const ctx = {
      cwd: process.cwd(),
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => false,
      ui: { notify: () => undefined },
    };
    await events.get("session_start")!(undefined as never, ctx as never);
    await commands.get("loop")!.handler("check CI" as never, ctx as never);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      message: {
        customType: LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE,
        display: false,
      },
      options: { triggerTurn: true },
    });
    const instruction = String(sent[0]!.message.content);
    expect(instruction).toContain("scheduler_create");
    expect(instruction).toContain("fire_immediately: true");
    expect(instruction).toContain("check CI");
    expect(instruction).toContain("Default to 5m");
    expect(instruction).not.toContain("schedule_wakeup");
    expect(instruction).not.toContain("Clock-time");
    expect(instruction).not.toContain("weekday");
    expect(await tools.get("scheduler_list")!.execute()).toMatchObject({
      content: [{ type: "text", text: "[]" }],
    });
  });

  it("creates and updates through the tool and rejects an empty update", async () => {
    const { events, tools } = fakePi();
    const ctx = {
      cwd: process.cwd(),
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => false,
      ui: { notify: () => undefined },
    };
    await events.get("session_start")!(undefined as never, ctx as never);
    const createdRaw = (await tools
      .get("scheduler_create")!
      .execute(undefined as never, { prompt: "check deploy", interval: "30s" } as never)) as {
      content: Array<{ text: string }>;
      details: CreateResult;
    };
    const created = createdRaw.details;
    expect(created.interval).toBe("60s");
    expect(created.raised).toBe(true);
    expect(created.updated).toBe(false);
    expect(createdRaw.content[0]!.text).toBe(
      `Loop ${created.id} created, every 60s, next interval fire at ${created.next_fire_at}. Expires at ${created.expires_at}. Interval was raised to the 60s minimum.`,
    );

    const immediateRaw = (await tools
      .get("scheduler_create")!
      .execute(
        undefined as never,
        { prompt: "check deploy", interval: "5m", fire_immediately: true } as never,
      )) as { content: Array<{ text: string }>; details: CreateResult };
    expect(immediateRaw.details.pending).toBe(true);
    expect(immediateRaw.content[0]!.text).toContain(
      "A fire is queued until the session is idle with no pending messages.",
    );
    expect(immediateRaw.content[0]!.text).not.toContain("60s minimum");

    const updatedRaw = (await tools
      .get("scheduler_create")!
      .execute(undefined as never, { id: created.id, interval: "10m" } as never)) as {
      content: Array<{ text: string }>;
      details: CreateResult;
    };
    const updated = updatedRaw.details;
    expect(updated.id).toBe(created.id);
    expect(updated.interval).toBe("10m");
    expect(updated.updated).toBe(true);
    expect(updatedRaw.content[0]!.text).toBe(
      `Loop ${created.id} updated, every 10m, next interval fire at ${updated.next_fire_at}. Expires at ${updated.expires_at}.`,
    );

    const queuedUpdateRaw = (await tools
      .get("scheduler_create")!
      .execute(undefined as never, { id: immediateRaw.details.id, interval: "15m" } as never)) as {
      content: Array<{ text: string }>;
      details: CreateResult;
    };
    expect(queuedUpdateRaw.details.pending).toBe(true);
    expect(queuedUpdateRaw.details.updated).toBe(true);
    expect(queuedUpdateRaw.content[0]!.text).toContain(
      "A fire is queued until the session is idle",
    );

    await expect(
      tools.get("scheduler_create")!.execute(undefined as never, { id: created.id } as never),
    ).rejects.toThrow(/NOTHING_TO_UPDATE/);

    const emptyIdRaw = (await tools.get("scheduler_create")!.execute(
      undefined as never,
      {
        id: "",
        prompt: "check empty id",
        interval: "5m",
      } as never,
    )) as { content: Array<{ text: string }>; details: CreateResult };
    expect(emptyIdRaw.details.updated).toBe(false);
    expect(emptyIdRaw.content[0]!.text).toContain("Loop ");
    expect(emptyIdRaw.content[0]!.text).toContain("created, every 5m");

    await expect(
      tools.get("scheduler_create")!.execute(undefined as never, { interval: "5m" } as never),
    ).rejects.toThrow(/prompt is required when creating a task/);
  });

  it("lists loops from /loops and /loop list without starting a turn", async () => {
    const { commands, events, sent, tools } = fakePi();
    const notices: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => false,
      ui: { notify: (message: string) => notices.push(message) },
    };
    await events.get("session_start")!(undefined as never, ctx as never);
    await commands.get("loops")!.handler("" as never, ctx as never);
    expect(notices).toEqual(["No session loops. Use /loop [interval] [prompt] to create one."]);
    expect(sent).toHaveLength(0);

    await tools
      .get("scheduler_create")!
      .execute(undefined as never, { prompt: "check deploy", interval: "5m" } as never);
    notices.length = 0;
    await commands.get("loop")!.handler("list" as never, ctx as never);
    expect(sent).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("check deploy");
    expect(notices[0]).toContain("5m");
  });

  it("stops a loop returned by the TUI picker", async () => {
    const { commands, events, tools } = fakePi();
    let createdId = "";
    let customCalls = 0;
    const notices: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => false,
      ui: {
        notify: (message: string) => notices.push(message),
        setWidget: () => undefined,
        custom: async () => {
          customCalls += 1;
          if (customCalls === 1) return { action: "stop", id: createdId };
          return { action: "close" };
        },
      },
    };
    await events.get("session_start")!(undefined as never, ctx as never);
    const createdRaw = (await tools
      .get("scheduler_create")!
      .execute(undefined as never, { prompt: "check deploy", interval: "5m" } as never)) as {
      details: CreateResult;
    };
    createdId = createdRaw.details.id;
    await tools
      .get("scheduler_create")!
      .execute(undefined as never, { prompt: "watch CI", interval: "10m" } as never);

    await commands.get("loops")!.handler("" as never, ctx as never);
    const remaining = JSON.parse(
      (
        (await tools.get("scheduler_list")!.execute()) as {
          content: Array<{ text: string }>;
        }
      ).content[0]!.text,
    );
    expect(remaining).toHaveLength(2);
    expect(remaining.find((item: { id: string }) => item.id === createdId)?.stopped).toBe(true);
    expect(notices).toContain("Paused loop. Already dispatched work was not cancelled.");
  });

  it("restarts and removes loops from the TUI picker", async () => {
    const { commands, events, tools } = fakePi();
    let createdId = "";
    const actions = [
      () => ({ action: "restart" as const, id: createdId }),
      () => ({ action: "remove" as const, id: createdId }),
    ];
    const notices: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => false,
      ui: {
        notify: (message: string) => notices.push(message),
        setWidget: () => undefined,
        custom: async () => actions.shift()?.() ?? { action: "close" },
      },
    };
    await events.get("session_start")!(undefined as never, ctx as never);
    const createdRaw = (await tools
      .get("scheduler_create")!
      .execute(undefined as never, { prompt: "check deploy", interval: "5m" } as never)) as {
      details: CreateResult;
    };
    createdId = createdRaw.details.id;

    await commands.get("loops")!.handler("" as never, ctx as never);
    expect(notices).toContain("Restarted loop; queued until idle.");
    expect(notices).toContain("Removed loop. Already dispatched work was not cancelled.");
    expect(await tools.get("scheduler_list")!.execute()).toMatchObject({
      content: [{ type: "text", text: "[]" }],
    });
  });

  it("updates the TUI widget when a loop is created", async () => {
    const { events, tools } = fakePi();
    const widgets: unknown[] = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => false,
      ui: {
        notify: () => undefined,
        setWidget: (_id: string, lines: unknown) => {
          widgets.push(lines);
        },
      },
    };
    await events.get("session_start")!(undefined as never, ctx as never);
    await tools
      .get("scheduler_create")!
      .execute(undefined as never, { prompt: "check deploy", interval: "5m" } as never);
    const last = widgets.at(-1);
    expect(Array.isArray(last)).toBe(true);
    expect(String((last as string[])[0])).toContain("check deploy");
  });
});

describe("same-session snapshots", () => {
  const context = () => ({
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { notify: () => undefined },
  });
  const start = async (pi: ReturnType<typeof fakePi>, reason = "startup") => {
    await pi.events.get("session_start")!({ reason } as never, context() as never);
  };
  const create = async (pi: ReturnType<typeof fakePi>, params: object) =>
    (await pi.tools.get("scheduler_create")!.execute("test" as never, params as never)) as {
      details: CreateResult;
      content: { text: string }[];
    };
  const list = async (pi: ReturnType<typeof fakePi>) =>
    JSON.parse(
      ((await pi.tools.get("scheduler_list")!.execute()) as { content: { text: string }[] })
        .content[0]!.text,
    );

  it("reopens the original session with full definitions and a fresh next deadline", async () => {
    const original = fakePi();
    await start(original);
    const { details } = await create(original, {
      prompt: `standing order ${"x".repeat(100)}`,
      interval: "5m",
      fire_immediately: true,
    });
    expect(original.entries).toHaveLength(1);
    const snapshot = original.entries[0]!;
    expect(snapshot.customType).toBe(LOOP_STATE_CUSTOM_TYPE);
    expect(snapshot.data).toMatchObject({
      version: 1,
      sessionId: "original",
      tasks: [{ id: details.id, stopped: false }],
    });
    await original.events.get("session_shutdown")!({} as never, context() as never);
    expect(original.entries).toHaveLength(1);
    vi.setSystemTime(Date.now() + 3_600_000);
    const reopened = fakePi("original", original.entries);
    await start(reopened);
    expect(await list(reopened)).toMatchObject([
      {
        id: details.id,
        pending: false,
        running: false,
        expires_at: details.expires_at,
        next_fire_at: new Date(Date.now() + 300_000).toISOString(),
      },
    ]);
    vi.advanceTimersByTime(1000);
    expect(reopened.sent).toEqual([]);
    expect(reopened.entries).toHaveLength(1);
  });

  it("uses latest updates and deletes across session-wide entries, including empty snapshots", async () => {
    const original = fakePi();
    await start(original);
    const { details } = await create(original, { prompt: "old", interval: "5m" });
    await create(original, { id: details.id, prompt: "updated", interval: "10m" });
    const reopened = fakePi("original", original.entries);
    await start(reopened, "reload");
    expect(await list(reopened)).toMatchObject([
      { id: details.id, interval: "10m", prompt_preview: "updated" },
    ]);
    await reopened.tools
      .get("scheduler_delete")!
      .execute("test" as never, { id: details.id } as never);
    expect(original.entries.at(-1)?.data).toEqual({ version: 1, sessionId: "original", tasks: [] });
    await start(reopened, "resume");
    expect(await list(reopened)).toEqual([]);
    expect(original.entries).toHaveLength(3);
  });

  it("starts new and fork sessions empty and rejects copied ownership on cold forks", async () => {
    const original = fakePi();
    await start(original);
    await create(original, { prompt: "original only", interval: "5m" });
    for (const reason of ["new", "fork", "startup"]) {
      const fork = fakePi("fork-id", [...original.entries]);
      await start(fork, reason);
      expect(await list(fork)).toEqual([]);
      const { details } = await create(fork, { prompt: "fork own task", interval: "10m" });
      const resumedFork = fakePi("fork-id", fork.entries);
      await start(resumedFork);
      expect(await list(resumedFork)).toMatchObject([
        { id: details.id, prompt_preview: "fork own task" },
      ]);
    }
    const resumedOriginal = fakePi("original", original.entries);
    await start(resumedOriginal, "resume");
    expect(await list(resumedOriginal)).toMatchObject([{ prompt_preview: "original only" }]);
  });

  it("writes only changed recoverable definitions, including pause/restart and final deletion", async () => {
    const pi = fakePi();
    await start(pi);
    const { details } = await create(pi, { prompt: "watch", interval: "5m" });
    await create(pi, { id: details.id, prompt: "watch", interval: "5m" });
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    await start(pi, "reload");
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    await create(pi, { id: details.id, prompt: "watch", interval: "5m" });
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
    await create(pi, { id: details.id, prompt: "watch", interval: "5m" });
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
    let action: string | null = null;
    const ctx = {
      ...context(),
      hasUI: true,
      ui: {
        notify: () => undefined,
        setWidget: () => undefined,
        custom: async () => {
          const current = action;
          action = null;
          return current ? { action: current, id: details.id } : { action: "close" };
        },
      },
    };
    await pi.events.get("session_start")!({ reason: "reload" } as never, ctx as never);
    for (const [next, expected] of [
      ["restart", 3],
      ["stop", 4],
      ["stop", 4],
      ["restart", 5],
      ["restart", 5],
      ["remove", 6],
    ] as const) {
      action = next;
      await pi.commands.get("loops")!.handler("" as never, ctx as never);
      expect(pi.appendEntry).toHaveBeenCalledTimes(expected);
    }
    expect(pi.entries.at(-1)?.data).toEqual({ version: 1, sessionId: "original", tasks: [] });
    await start(pi, "resume");
    expect(await list(pi)).toEqual([]);
  });

  it("reports append failures as applied in memory with IDs and does not deduplicate unsaved changes", async () => {
    const pi = fakePi();
    const notices: string[] = [];
    const ctx = {
      ...context(),
      hasUI: true,
      ui: {
        notify: (message: string) => notices.push(message),
        setWidget: () => undefined,
      },
    };
    await pi.events.get("session_start")!({ reason: "startup" } as never, ctx as never);
    const failAppend = () =>
      pi.appendEntry.mockImplementationOnce((customType, data) => {
        // Pi adds the entry to session memory before a filesystem write can fail.
        pi.entries.push({ type: "custom", customType, data });
        throw new Error("EISDIR");
      });
    failAppend();
    const created = await create(pi, { prompt: "watch", interval: "5m", fire_immediately: true });
    const id = created.details.id;
    expect(created.content[0]!.text).toContain(id);
    expect(created.content[0]!.text).toContain(
      "applied in memory but could not be saved for restart",
    );
    expect(notices.at(-1)).toContain("applied in memory but could not be saved for restart");
    expect(await list(pi)).toMatchObject([{ id }]);
    vi.advanceTimersByTime(1000);
    expect(pi.sent).toHaveLength(1);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    const saved = await create(pi, { id, prompt: "watch" });
    expect(saved.content[0]!.text).not.toContain("could not be saved");
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
    await create(pi, { id, prompt: "watch" });
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
    failAppend();
    const updated = await create(pi, { id, prompt: "changed" });
    expect(updated.content[0]!.text).toContain(id);
    expect(updated.content[0]!.text).toContain("could not be saved for restart");
    await create(pi, { id, prompt: "watch" });
    expect(pi.appendEntry).toHaveBeenCalledTimes(4);
    failAppend();
    const removed = (await pi.tools
      .get("scheduler_delete")!
      .execute("test" as never, { id } as never)) as { content: { text: string }[] };
    expect(removed.content[0]!.text).toContain(id);
    expect(removed.content[0]!.text).toContain("could not be saved for restart");
    expect(await list(pi)).toEqual([]);
    const replacement = await create(pi, { prompt: "replacement", interval: "5m" });
    await pi.tools
      .get("scheduler_delete")!
      .execute("test" as never, { id: replacement.details.id } as never);
    expect(pi.entries.at(-1)?.data).toEqual({ version: 1, sessionId: "original", tasks: [] });
    await start(pi, "resume");
    expect(await list(pi)).toEqual([]);
  });

  it("ignores unsupported or malformed owned state without resurrecting earlier tasks", async () => {
    const pi = fakePi();
    await start(pi);
    await create(pi, { prompt: "old", interval: "5m" });
    pi.entries.push({
      type: "custom",
      customType: LOOP_STATE_CUSTOM_TYPE,
      data: { version: 2, sessionId: "original", tasks: [] },
    });
    await start(pi);
    expect(await list(pi)).toEqual([]);
  });
});
