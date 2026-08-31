import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import piLoopExtension from "../extensions/index.ts";
import { LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE } from "../extensions/types.ts";

type Handler = (...args: never[]) => unknown;

function fakePi() {
  const commands = new Map<string, { description?: string; handler: Handler }>();
  const tools = new Map<string, { description: string; parameters: unknown; execute: Handler }>();
  const events = new Map<string, Handler>();
  const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      events.set(event, handler);
    },
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
  return { commands, tools, events, sent };
}

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
    expect(tools.get("scheduler_create")!.description).toContain("one-off");
    expect(tools.get("scheduler_delete")!.description).toContain("stop condition");
  });

  it("uses snake_case create/update variants and rejects extra properties", () => {
    const { tools } = fakePi();
    const schema = tools.get("scheduler_create")!.parameters as {
      anyOf?: Array<{ additionalProperties?: boolean; properties?: Record<string, unknown> }>;
    };
    expect(schema.anyOf).toHaveLength(2);
    const [createSchema, updateSchema] = schema.anyOf ?? [];
    expect(createSchema?.additionalProperties).toBe(false);
    expect(createSchema?.properties).toHaveProperty("interval");
    expect(createSchema?.properties).toHaveProperty("fire_immediately");
    expect(createSchema?.properties).not.toHaveProperty("id");
    expect(updateSchema?.properties).toHaveProperty("id");
    expect(updateSchema?.properties).not.toHaveProperty("fire_immediately");
    expect(createSchema?.properties).not.toHaveProperty("cron");
    expect(createSchema?.properties).not.toHaveProperty("run_at");
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
    const createdRaw = await tools
      .get("scheduler_create")!
      .execute(undefined as never, { prompt: "check deploy", interval: "30s" } as never);
    const created = JSON.parse(
      (createdRaw as { content: Array<{ text: string }> }).content[0]!.text,
    );
    expect(created.interval).toBe("60s");
    expect(created.raised).toBe(true);
    expect(created.updated).toBe(false);

    const updatedRaw = await tools
      .get("scheduler_create")!
      .execute(undefined as never, { id: created.id, interval: "10m" } as never);
    const updated = JSON.parse(
      (updatedRaw as { content: Array<{ text: string }> }).content[0]!.text,
    );
    expect(updated.id).toBe(created.id);
    expect(updated.interval).toBe("10m");
    expect(updated.updated).toBe(true);

    await expect(
      tools.get("scheduler_create")!.execute(undefined as never, { id: created.id } as never),
    ).rejects.toThrow(/NOTHING_TO_UPDATE/);
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
    const createdRaw = await tools
      .get("scheduler_create")!
      .execute(undefined as never, { prompt: "check deploy", interval: "5m" } as never);
    createdId = JSON.parse(
      (createdRaw as { content: Array<{ text: string }> }).content[0]!.text,
    ).id;
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
    expect(notices).toContain("Stopped loop.");
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
    const createdRaw = await tools
      .get("scheduler_create")!
      .execute(undefined as never, { prompt: "check deploy", interval: "5m" } as never);
    createdId = JSON.parse(
      (createdRaw as { content: Array<{ text: string }> }).content[0]!.text,
    ).id;

    await commands.get("loops")!.handler("" as never, ctx as never);
    expect(notices).toContain("Restarted loop.");
    expect(notices).toContain("Removed loop.");
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
