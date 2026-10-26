import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LoopController } from "./controller.js";

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
  const version = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(VERSION);
  const major = Number(version?.[1]);
  const minor = Number(version?.[2]);
  const patch = Number(version?.[3]);
  const supported =
    major > 1 ||
    (major === 1 && (minor > 4 || (minor === 4 && (patch > 0 || (patch === 0 && !version?.[4])))));
  if (!supported) {
    throw new Error(
      `@getpie/pi-loop requires Pi >= 1.4.0 (running ${VERSION}). Upgrade Pi and reload the extension.`,
    );
  }

  const loop = new LoopController(pi);
  pi.on("session_start", (event, ctx) => loop.recover(ctx, event.reason));
  pi.on("agent_start", () => loop.agentStarted());
  pi.on("agent_settled", (_event, ctx) => loop.agentSettled(ctx));
  pi.on("session_shutdown", () => loop.dispose());

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
    handler: (args, ctx) => loop.handleLoopCommand(args, ctx),
  });

  pi.registerCommand("loops", {
    description: "List session loops. d stop, r restart, x remove. Does not start a turn.",
    handler: (_args, ctx) => loop.showLoops(ctx),
  });

  pi.registerTool({
    name: "scheduler_create",
    label: "Scheduler create",
    description:
      'Create a scheduled task that runs a prompt on a recurring interval, or update an existing one in place.\n\nUse this tool when a user asks you to loop, repeat, or schedule a prompt or a task.\n\nSet fire_immediately: true to also fire once on creation; by default the first run waits for the interval.\n\nTo change an existing task, pass its id: provided fields replace old values, omitted ones are unchanged, and the schedule keeps its phase. An unknown id errors.\n\nUsage notes:\n- Interval format: "5m" (minutes), "2h" (hours), "1d" (days), "60s" (seconds, min 60)\n- Maximum 50 scheduled tasks at once\n- Tasks auto-expire after 7 days',
    parameters: SchedulerCreateParams,
    async execute(_id, params) {
      return loop.createTool(params);
    },
  });

  pi.registerTool({
    name: "scheduler_list",
    label: "Scheduler list",
    description:
      "List all active scheduled tasks with their IDs, prompts, intervals, and next fire times.",
    parameters: SchedulerListParams,
    async execute() {
      return loop.listTool();
    },
  });

  pi.registerTool({
    name: "scheduler_delete",
    label: "Scheduler delete",
    description:
      "Cancel a scheduled task by ID from scheduler_list or scheduler_create. Removes future and locally pending fires. Does not abort work already sent to the model.",
    parameters: SchedulerDeleteParams,
    async execute(_id, params) {
      return loop.deleteTool(params.id);
    },
  });
}

export { LoopError } from "./interval.js";
export { SessionLoopScheduler } from "./scheduler.js";
export {
  LOOP_CUSTOM_TYPE,
  LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE,
} from "./types.js";
