import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piLoopExtension from "../extensions/index.ts";
import { LoopIntegration } from "../extensions/integration.ts";
import { LOOP_CUSTOM_TYPE, LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE } from "../extensions/types.ts";

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
  vi.restoreAllMocks();
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

  it("forwards lifecycle, commands and tools to its Pi integration", async () => {
    const recover = vi.spyOn(LoopIntegration.prototype, "recover").mockImplementation(() => {});
    const started = vi
      .spyOn(LoopIntegration.prototype, "agentStarted")
      .mockImplementation(() => {});
    const settled = vi
      .spyOn(LoopIntegration.prototype, "agentSettled")
      .mockImplementation(() => {});
    const dispose = vi.spyOn(LoopIntegration.prototype, "dispose").mockImplementation(() => {});
    const command = vi
      .spyOn(LoopIntegration.prototype, "handleLoopCommand")
      .mockResolvedValue(undefined);
    const show = vi.spyOn(LoopIntegration.prototype, "showLoops").mockResolvedValue(undefined);
    const response = { content: [{ type: "text" as const, text: "forwarded" }], details: {} };
    const create = vi.spyOn(LoopIntegration.prototype, "createTool").mockReturnValue(response);
    const list = vi.spyOn(LoopIntegration.prototype, "listTool").mockReturnValue(response);
    const remove = vi.spyOn(LoopIntegration.prototype, "deleteTool").mockReturnValue(response);
    const { events, commands, tools } = fakePi();
    const ctx = {} as never;
    await events.get("session_start")!({ reason: "reload" } as never, ctx);
    await events.get("agent_start")!();
    await events.get("agent_settled")!(undefined as never, ctx);
    await commands.get("loop")!.handler("check CI" as never, ctx);
    await commands.get("loops")!.handler("" as never, ctx);
    const params = { prompt: "watch", interval: "5m" };
    expect(await tools.get("scheduler_create")!.execute("test" as never, params as never)).toBe(
      response,
    );
    expect(await tools.get("scheduler_list")!.execute()).toBe(response);
    expect(
      await tools.get("scheduler_delete")!.execute("test" as never, { id: "deadbeef" } as never),
    ).toBe(response);
    await events.get("session_shutdown")!(undefined as never, ctx);
    expect(recover).toHaveBeenCalledExactlyOnceWith(ctx, "reload");
    expect(started).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(command).toHaveBeenCalledExactlyOnceWith("check CI", ctx);
    expect(show).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(create).toHaveBeenCalledExactlyOnceWith(params);
    expect(list).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledExactlyOnceWith("deadbeef");
    expect(dispose).toHaveBeenCalledOnce();
    expect(
      new Set(
        [recover, started, settled, command, show, create, list, remove, dispose].map(
          (spy) => spy.mock.instances[0],
        ),
      ).size,
    ).toBe(1);
  });

  it("preserves hidden instruction and scheduled custom-message envelopes through the factory", async () => {
    const { events, commands, tools, sent } = fakePi();
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => false,
      ui: { notify: () => undefined },
    };
    await events.get("session_start")!(undefined as never, ctx as never);
    await commands.get("loop")!.handler("check CI" as never, ctx as never);
    await tools
      .get("scheduler_create")!
      .execute(
        "test" as never,
        { prompt: "watch", interval: "5m", fire_immediately: true } as never,
      );
    vi.advanceTimersByTime(1000);
    expect(sent).toMatchObject([
      {
        message: { customType: LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE, display: false },
        options: { triggerTurn: true },
      },
      { message: { customType: LOOP_CUSTOM_TYPE, display: true }, options: { triggerTurn: true } },
    ]);
    await events.get("session_shutdown")!(undefined as never, ctx as never);
    expect(vi.getTimerCount()).toBe(0);
  });
});
