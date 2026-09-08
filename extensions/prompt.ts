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
    "# /loop -- schedule a recurring prompt",
    "",
    "Turn the input below into a scheduler_create call. Each fire arrives as a new turn in this conversation, and earlier results from the same task may still be above it. The stored prompt is re-sent verbatim every time, so write a standing order rather than a one-off request.",
    "",
    "## Writing a prompt that reads well on every fire",
    '- Name the state that must not be guessed: paths, job/PR/branch ids, the command that checks status, and what "healthy" looks like. This conversation is compacted as it grows, so do not rely on details staying visible.',
    "- Earlier fires may be above you: continue from them instead of restarting.",
    '- Say what one fire does and when it bails: "if still pending, report one line and stop." A fire must not poll inline.',
    '- Give it a stop condition and an exit: "when <condition> holds, report it and call scheduler_delete <id>." Without that the loop runs until it expires.',
    "- Keep it short and concrete -- the stored prompt is re-sent on every fire.",
    "- If the user did not give a prompt, use the default maintenance prompt below.",
    "",
    "## Deriving the interval",
    "Convert the user's cadence -- however phrased, at either end of the request -- into a compact `<number><unit>` string (`s`/`m`/`h`/`d`); the remaining text is the prompt.",
    "The minimum is 60 seconds and shorter values are raised, so say so when it applies.",
    `If no cadence is given, choose one that fits the task. Default to ${DEFAULT_INTERVAL}. Tell the user what you picked. Do not ask. Do not self-pace or change the interval every fire.`,
    "",
    "## Action",
    "Schedule from what the user already gave you — do not explore the workspace or run checks before scheduling; the first fire does that.",
    "1. Call scheduler_create with the interval, the prompt, and fire_immediately: true.",
    "   If the interval is rejected, fix the string rather than guessing.",
    "2. Confirm what's scheduled, the cadence, its stop condition, that it auto-expires after 7 days, and the id to cancel with scheduler_delete.",
    "3. Do NOT execute the prompt inline. The scheduler fires it immediately.",
    "",
    "## Changing an existing loop",
    "Call scheduler_create with its id and only the changed fields; do not delete and recreate.",
    "",
    "## Default maintenance prompt",
    maintenancePrompt,
    "",
    "## Input",
    input,
  ].join("\n");
}

export function buildScheduledContent(prompt: string, id: string, interval: string): string {
  return [
    `Scheduled task ${id} (every ${interval}, recurring).`,
    "Execute the prompt below. Previous results from earlier executions of this task may appear above.",
    "",
    prompt,
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
