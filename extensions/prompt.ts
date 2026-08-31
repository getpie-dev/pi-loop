import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_INTERVAL, LoopError } from "./interval.js";

export const PROMPT_MAX_BYTES = 25_000;

export const BUILTIN_MAINTENANCE_PROMPT = [
  "Continue unfinished work in the current session.",
  "Check CI, review comments, merge conflicts, and tests for the current branch.",
  "If nothing is pending, do a limited bug hunt, simplification, or cleanup.",
  "Do not start a new project unrelated to this session.",
  "Do not expand permissions or available tools.",
  "Do not push, delete, or take irreversible actions unless this transcript already authorized them.",
  "If there is no useful work, say so in one line.",
].join("\n");

export interface LoopMessageDetails {
  taskId: string;
  prompt: string;
}

export function loopScheduleInstruction(args: string, maintenancePrompt: string): string {
  const input = args.trim() || "(none — use the default maintenance prompt)";
  return [
    "# /loop — schedule a recurring prompt",
    "",
    "Turn the input below into a scheduler_create call. Each fire arrives as a new turn in this conversation. The stored prompt is re-sent verbatim every time, so write a standing order, not a one-off request.",
    "",
    "## Writing the stored prompt",
    '- Name paths, job/PR/branch ids, the check to run, and what "done" looks like.',
    "- Say what one fire does and when it bails. A fire must not poll inline.",
    "- Give a stop condition: when it holds, report it and call scheduler_delete with the id.",
    "- If the user did not give a prompt, use the default maintenance prompt below.",
    "",
    "## Interval",
    "- Convert the user cadence — however phrased — into compact `<number><unit>` (`s`/`m`/`h`/`d`). Minimum 60 seconds; say so if you raise it.",
    `- If no cadence is given, choose one that fits the task. Default to ${DEFAULT_INTERVAL}. Tell the user what you picked. Do not ask. Do not self-pace or change the interval every fire.`,
    "",
    "## Action",
    "Do not explore the workspace or run the prompt before scheduling; the first fire does that.",
    "1. Call scheduler_create with interval, prompt, and fire_immediately: true.",
    "2. Confirm the cadence, stop condition, 7-day expiry, and the id for scheduler_delete.",
    "3. Do NOT execute the prompt inline.",
    "",
    "## Wrong tool",
    "- Clock-time or weekday jobs → an external scheduler (cron, systemd, GitHub Actions), not this tool.",
    '- "Tell me when X finishes" → wait on the event, not a timer loop.',
    '- "Do X once in N minutes" → not a recurring loop.',
    "",
    "## Changing a loop",
    "Call scheduler_create with its id and only the changed fields. Do not delete and recreate.",
    "",
    "## Default maintenance prompt",
    maintenancePrompt,
    "",
    "## Input",
    input,
  ].join("\n");
}

export function buildScheduledContent(prompt: string, id: string): string {
  return [
    `Scheduled loop iteration (id: ${id}). Run only this standing order, then stop.`,
    "",
    prompt,
    "",
    "If earlier fires of this loop are above, continue from them. Do not poll inline. When the work is done, call scheduler_delete with this id.",
  ].join("\n");
}

export function resolveMaintenancePrompt(options: {
  cwd: string;
  isProjectTrusted: () => boolean;
}): string {
  if (options.isProjectTrusted()) {
    const project = readLoopMd(join(options.cwd, CONFIG_DIR_NAME, "loop.md"));
    if (project) return project;
  }
  const user = readLoopMd(join(getAgentDir(), "loop.md"));
  return user ?? BUILTIN_MAINTENANCE_PROMPT;
}

export function assertPromptSize(prompt: string): void {
  if (Buffer.byteLength(prompt, "utf8") > PROMPT_MAX_BYTES) {
    throw new LoopError("PROMPT_TOO_LARGE", "prompt exceeds 25,000 bytes");
  }
}

export function previewPrompt(prompt: string, max = 80): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, max);
}

function readLoopMd(path: string): string | null {
  try {
    const raw = readFileSync(path);
    if (raw.byteLength > PROMPT_MAX_BYTES) {
      return raw.subarray(0, PROMPT_MAX_BYTES).toString("utf8");
    }
    const text = raw.toString("utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
