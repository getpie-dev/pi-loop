import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatLoopLine,
  formatLoopList,
  formatWidgetLines,
  isLoopListQuery,
  WIDGET_ID,
} from "./format.js";
import { LoopError } from "./interval.js";
import { loopScheduleInstruction, resolveMaintenancePrompt } from "./prompt.js";
import { type SchedulerHost, SessionLoopScheduler, type UpdateInput } from "./scheduler.js";
import { LOOP_CUSTOM_TYPE, LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE } from "./types.js";

const SchedulerCreateNewParams = Type.Object(
  {
    prompt: Type.String({ description: "Prompt to run on each fire" }),
    interval: Type.String({ description: "Interval such as 5m, 2h, or 60s" }),
    fire_immediately: Type.Optional(
      Type.Boolean({ description: "Fire once on create in addition to the interval" }),
    ),
  },
  { additionalProperties: false },
);

const SchedulerUpdateParams = Type.Object(
  {
    id: Type.String({
      description:
        "Existing scheduler id. Omitted fields stay unchanged and the next fire keeps its phase",
    }),
    prompt: Type.Optional(Type.String({ description: "Replacement standing-order prompt" })),
    interval: Type.Optional(
      Type.String({ description: "Replacement interval such as 5m, 2h, or 60s" }),
    ),
  },
  { additionalProperties: false },
);

const SchedulerCreateParams = Type.Union([SchedulerCreateNewParams, SchedulerUpdateParams]);

const SchedulerDeleteParams = Type.Object(
  { id: Type.String({ description: "Id from scheduler_list or scheduler_create" }) },
  { additionalProperties: false },
);

const SchedulerListParams = Type.Object({}, { additionalProperties: false });

export default function piLoopExtension(pi: ExtensionAPI): void {
  let ctxRef: ExtensionContext | null = null;
  let lastWidget = "";
  const host: SchedulerHost = {
    clock: { now: () => Date.now() },
    dispatch: {
      isIdle: () => {
        if (!ctxRef) return false;
        return ctxRef.isIdle();
      },
      hasPendingMessages: () => {
        if (!ctxRef) return true;
        return ctxRef.hasPendingMessages();
      },
      sendScheduled: (payload) => {
        pi.sendMessage(
          {
            customType: LOOP_CUSTOM_TYPE,
            content: payload.content,
            display: true,
            details: payload.details,
          },
          { triggerTurn: true },
        );
      },
    },
    onChange: refreshWidget,
  };
  const scheduler = new SessionLoopScheduler(host);

  function refreshWidget(): void {
    const ctx = ctxRef;
    if (!ctx?.hasUI) return;
    const lines = formatWidgetLines(scheduler.list(), host.clock.now());
    const key = lines.join("\n");
    if (key === lastWidget) return;
    lastWidget = key;
    ctx.ui.setWidget(WIDGET_ID, lines.length > 0 ? lines : undefined);
  }

  async function showLoops(ctx: ExtensionContext): Promise<void> {
    ctxRef = ctx;
    const items = scheduler.list();
    const now = host.clock.now();
    if (items.length === 0) {
      ctx.ui.notify("No session loops. Use /loop [interval] [prompt] to create one.", "info");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(formatLoopList(items, now), "info");
      return;
    }
    await ctx.ui.select(
      "Session loops",
      items.map((item) => formatLoopLine(item, now)),
    );
  }

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    lastWidget = "";
    scheduler.startSession();
  });
  pi.on("agent_start", () => {
    scheduler.markStarted();
  });
  pi.on("agent_settled", (_event, ctx) => {
    ctxRef = ctx;
    scheduler.handleSettled();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    scheduler.dispose();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
    lastWidget = "";
    ctxRef = null;
  });

  pi.registerCommand("loop", {
    description:
      "Ask the model to create a session loop. Usage: /loop [interval] [prompt]. /loop list shows active loops.",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "list", label: "list", description: "Show session loops" },
        { value: "ls", label: "ls", description: "Show session loops" },
      ];
      const trimmed = prefix.trim().toLowerCase();
      if (!trimmed) return null;
      const filtered = items.filter((item) => item.value.startsWith(trimmed));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      ctxRef = ctx;
      if (isLoopListQuery(args)) {
        await showLoops(ctx);
        return;
      }
      pi.sendMessage(
        {
          customType: LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE,
          content: loopScheduleInstruction(
            args,
            resolveMaintenancePrompt({
              cwd: ctx.cwd,
              isProjectTrusted: () => ctx.isProjectTrusted(),
            }),
          ),
          display: false,
        },
        { triggerTurn: true },
      );
    },
  });

  pi.registerCommand("loops", {
    description: "List session loops. Does not create or start a turn.",
    handler: async (_args, ctx) => {
      await showLoops(ctx);
    },
  });

  pi.registerTool({
    name: "scheduler_create",
    label: "Scheduler create",
    description:
      'Create a recurring interval prompt in the current Session, or update an existing one in place. Interval: 5m, 2h, 1d, 60s (minimum 60 seconds). fire_immediately also fires once on create; default waits for the first interval. To change a loop, pass id; provided fields replace old values, omitted ones stay unchanged, and the next fire keeps its phase. Do not use this for one-off delays or "tell me when X finishes". Do not use this for clock-time or weekday schedules — those belong to an external scheduler (cron, systemd, GitHub Actions). Max 50. Expires after 7 days.',
    parameters: SchedulerCreateParams,
    async execute(_id, params) {
      const result =
        "id" in params
          ? scheduler.update(toUpdateInput(params))
          : scheduler.create({
              prompt: params.prompt,
              interval: params.interval,
              fireImmediately: params.fire_immediately === true,
            });
      return textResult(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "scheduler_list",
    label: "Scheduler list",
    description:
      "List active scheduled loops in the current Session only. Use before updating or deleting.",
    parameters: SchedulerListParams,
    async execute() {
      return textResult(JSON.stringify(scheduler.list()));
    },
  });

  pi.registerTool({
    name: "scheduler_delete",
    label: "Scheduler delete",
    description:
      "Stop a session loop by id from scheduler_list or scheduler_create. Removes future and locally pending fires. Does not abort work already sent to the model. Call this when the loop's stop condition holds or the user asks to cancel.",
    parameters: SchedulerDeleteParams,
    async execute(_id, params) {
      const outcome = scheduler.delete(params.id);
      if (outcome === "not_found")
        throw new LoopError("TASK_NOT_FOUND", `id ${params.id} not found`);
      const suffix =
        outcome === "future_deleted_current_running"
          ? "Already dispatched work, if any, was not interrupted."
          : "No work was in flight.";
      return textResult(
        `Loop ${params.id} stopped. Future and locally pending fires were removed. ${suffix}\n${outcome}`,
      );
    },
  });
}

function toUpdateInput(params: { id: string; prompt?: string; interval?: string }): UpdateInput {
  if (params.prompt != null && params.interval != null) {
    return { id: params.id, prompt: params.prompt, interval: params.interval };
  }
  if (params.prompt != null) return { id: params.id, prompt: params.prompt };
  if (params.interval != null) return { id: params.id, interval: params.interval };
  throw new LoopError("NOTHING_TO_UPDATE", "nothing to update: provide interval and/or prompt");
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export { LoopError } from "./interval.js";
export { SessionLoopScheduler } from "./scheduler.js";
export {
  LOOP_CUSTOM_TYPE,
  LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE,
} from "./types.js";
