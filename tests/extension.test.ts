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
    expect([...commands.keys()]).toEqual(["loop"]);
    expect([...tools.keys()]).toEqual(["scheduler_create", "scheduler_list", "scheduler_delete"]);
    expect(events.has("session_start")).toBe(true);
    expect(events.has("agent_start")).toBe(true);
    expect(events.has("agent_settled")).toBe(true);
    expect(events.has("session_shutdown")).toBe(true);
    expect(events.has("agent_end")).toBe(false);
    expect(events.has("before_agent_start")).toBe(false);
    expect(commands.get("loop")!.description).toContain("Ask the model");
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
});
