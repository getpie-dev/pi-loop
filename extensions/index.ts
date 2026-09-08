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
import { pickLoopToManage } from "./list-ui.js";
import { loopScheduleInstruction, resolveMaintenancePrompt } from "./prompt.js";
import {
  type CreateResult,
  type SchedulerHost,
  SessionLoopScheduler,
  type UpdateInput,
} from "./scheduler.js";
import { LOOP_CUSTOM_TYPE, LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE } from "./types.js";

// Single object, not anyOf: Anthropic convertTools only copies top-level properties,
// so a Union schema arrives as an empty input_schema.
const SchedulerCreateParams = Type.Object(
  {
    prompt: Type.Optional(
      Type.String({
        description: "Prompt to run on each fire. Required to create; optional with id",
      }),
    ),
    interval: Type.Optional(
      Type.String({
        description: "Interval such as 5m, 2h, or 60s. Required to create; optional with id",
      }),
    ),
    fire_immediately: Type.Optional(
      Type.Boolean({
        description:
          "Fire once on create in addition to the interval. Ignored when updating with id",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description:
          "Existing scheduler id to update in place. Omitted fields stay unchanged and the next fire keeps its phase",
      }),
    ),
  },
  { additionalProperties: false },
);

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
    while (true) {
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
      const result = await pickLoopToManage(
        ctx,
        items.map((item) => ({
          value: item.id,
          label: formatLoopLine(item, now),
        })),
      );
      if (result?.action === "stop") {
        scheduler.stop(result.id);
        ctx.ui.notify("Stopped loop.", "info");
        continue;
      }
      if (result?.action === "restart") {
        scheduler.restart(result.id);
        ctx.ui.notify("Restarted loop.", "info");
        continue;
      }
      if (result?.action === "remove") {
        scheduler.delete(result.id);
        ctx.ui.notify("Removed loop.", "info");
        continue;
      }
      return;
    }
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
    description: "List session loops. d stop, r restart, x remove. Does not start a turn.",
    handler: async (_args, ctx) => {
      await showLoops(ctx);
    },
  });

  pi.registerTool({
    name: "scheduler_create",
    label: "Scheduler create",
    description:
      'Create a scheduled task that runs a prompt on a recurring interval, or update an existing one in place.\n\nUse this tool when a user asks you to loop, repeat, or schedule a prompt or a task.\n\nSet fire_immediately: true to also fire once on creation; by default the first run waits for the interval.\n\nTo change an existing task, pass its id: provided fields replace old values, omitted ones are unchanged, and the schedule keeps its phase. An unknown id errors.\n\nUsage notes:\n- Interval format: "5m" (minutes), "2h" (hours), "1d" (days), "60s" (seconds, min 60)\n- Maximum 50 scheduled tasks at once\n- Tasks auto-expire after 7 days',
    parameters: SchedulerCreateParams,
    async execute(_id, params) {
      const result = hasSchedulerId(params.id)
        ? scheduler.update(
            toUpdateInput({ id: params.id, prompt: params.prompt, interval: params.interval }),
          )
        : scheduler.create({
            prompt: requireCreateField(params.prompt, "prompt"),
            interval: requireCreateField(params.interval, "interval"),
            fireImmediately: params.fire_immediately === true,
          });
      return textResult(describeCreateResult(result), result);
    },
  });

  pi.registerTool({
    name: "scheduler_list",
    label: "Scheduler list",
    description:
      "List all active scheduled tasks with their IDs, prompts, intervals, and next fire times.",
    parameters: SchedulerListParams,
    async execute() {
      return textResult(JSON.stringify(scheduler.list()));
    },
  });

  pi.registerTool({
    name: "scheduler_delete",
    label: "Scheduler delete",
    description:
      "Cancel a scheduled task by ID from scheduler_list or scheduler_create. Removes future and locally pending fires. Does not abort work already sent to the model.",
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

function hasSchedulerId(id: string | undefined): id is string {
  return typeof id === "string" && id.length > 0;
}

function requireCreateField(value: string | undefined, name: "prompt" | "interval"): string {
  if (value == null || value.trim() === "") {
    throw new LoopError("INVALID_ARGUMENTS", `${name} is required when creating a task`);
  }
  return value;
}

function toUpdateInput(params: { id: string; prompt?: string; interval?: string }): UpdateInput {
  if (params.prompt != null && params.interval != null) {
    return { id: params.id, prompt: params.prompt, interval: params.interval };
  }
  if (params.prompt != null) return { id: params.id, prompt: params.prompt };
  if (params.interval != null) return { id: params.id, interval: params.interval };
  throw new LoopError("NOTHING_TO_UPDATE", "nothing to update: provide interval and/or prompt");
}

function textResult(text: string, details: CreateResult | Record<string, never> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

// Models handle a one-line confirmation with the id embedded better than raw JSON.
function describeCreateResult(result: CreateResult): string {
  const head = result.updated
    ? `Loop ${result.id} updated, every ${result.interval}`
    : `Loop ${result.id} created, every ${result.interval}`;
  const parts = [
    result.next_fire_at
      ? `${head}, next fire at ${result.next_fire_at}.`
      : `${head}, no future fire (expired).`,
  ];
  if (result.raised) parts.push("Interval was raised to the 60s minimum.");
  if (!result.updated && result.pending) parts.push("First fire runs immediately.");
  return parts.join(" ");
}

export { LoopError } from "./interval.js";
export { SessionLoopScheduler } from "./scheduler.js";
export {
  LOOP_CUSTOM_TYPE,
  LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE,
} from "./types.js";
