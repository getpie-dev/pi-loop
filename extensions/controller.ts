import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
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
  type CreateInput,
  type CreateResult,
  type MutationOutcome,
  SessionLoopScheduler,
  type TaskDefinition,
  type UpdateInput,
} from "./scheduler.js";
import {
  LOOP_CUSTOM_TYPE,
  LOOP_SCHEDULE_INSTRUCTION_CUSTOM_TYPE,
  LOOP_STATE_CUSTOM_TYPE,
} from "./types.js";

interface CreateToolInput {
  id?: string;
  prompt?: string;
  interval?: string;
  fire_immediately?: boolean;
}

export class LoopController {
  private ctx: ExtensionContext | null = null;
  private lastWidget = "";
  private lastSavedDefinitions: string | null = null;
  private readonly scheduler: SessionLoopScheduler;

  constructor(private readonly pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">) {
    this.scheduler = new SessionLoopScheduler({
      clock: { now: () => Date.now() },
      dispatch: {
        isIdle: () => this.ctx?.isIdle() ?? false,
        hasPendingMessages: () => this.ctx?.hasPendingMessages() ?? true,
        sendScheduled: (payload) => {
          this.pi.sendMessage(
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
      onChange: () => this.refreshWidget(),
      onMutation: (definitions) => this.checkpoint(definitions),
      onWarning: (message) => this.ctx?.ui.notify(message, "warning"),
    });
  }

  recover(ctx: ExtensionContext, reason: SessionStartEvent["reason"]): void {
    this.ctx = ctx;
    this.lastWidget = "";
    this.lastSavedDefinitions = null;
    let definitions: unknown[] = [];
    if (reason !== "new" && reason !== "fork") {
      const sessionId = ctx.sessionManager.getSessionId();
      // Task management is session-wide, independent of conversation tree navigation.
      for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
        if (entry.type !== "custom" || entry.customType !== LOOP_STATE_CUSTOM_TYPE) continue;
        const state = entry.data as {
          version?: unknown;
          sessionId?: unknown;
          tasks?: unknown;
        } | null;
        if (state?.sessionId !== sessionId) continue;
        if (state.version === 1 && Array.isArray(state.tasks)) definitions = state.tasks;
        break;
      }
    }
    this.scheduler.startSession(definitions);
    // Reload may restore entries retained in memory after a failed append.
    if (reason !== "reload")
      this.lastSavedDefinitions = JSON.stringify(this.scheduler.definitions());
  }

  agentStarted(): void {
    this.scheduler.markStarted();
  }

  agentSettled(ctx: ExtensionContext): void {
    if (!this.ctx) return;
    this.ctx = ctx;
    this.scheduler.handleSettled();
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.lastWidget = "";
    this.lastSavedDefinitions = null;
    this.scheduler.dispose();
    if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
  }

  create(input: CreateInput): MutationOutcome<CreateResult> {
    return this.scheduler.create(input);
  }

  update(input: UpdateInput): MutationOutcome<CreateResult> {
    return this.scheduler.update(input);
  }

  pause(id: string) {
    return this.scheduler.stop(id);
  }

  resume(id: string): MutationOutcome<CreateResult> {
    return this.scheduler.restart(id);
  }

  remove(id: string) {
    return this.scheduler.delete(id);
  }

  list() {
    return this.scheduler.list();
  }

  createTool(params: CreateToolInput) {
    const outcome = hasSchedulerId(params.id)
      ? this.update(
          toUpdateInput({ id: params.id, prompt: params.prompt, interval: params.interval }),
        )
      : this.create({
          prompt: requireCreateField(params.prompt, "prompt"),
          interval: requireCreateField(params.interval, "interval"),
          fireImmediately: params.fire_immediately === true,
        });
    return this.mutationResult(describeCreateResult(outcome.value), outcome, outcome.value);
  }

  listTool() {
    return textResult(JSON.stringify(this.list()));
  }

  deleteTool(id: string) {
    const outcome = this.remove(id);
    if (outcome.value === "not_found") throw new LoopError("TASK_NOT_FOUND", `id ${id} not found`);
    const suffix = "Already dispatched work, if any, was not cancelled.";
    return this.mutationResult(
      `Loop ${id} removed. Future and locally pending fires were removed. ${suffix}\n${outcome.value}`,
      outcome,
    );
  }

  async handleLoopCommand(args: string, ctx: ExtensionContext): Promise<void> {
    if (!this.ctx) return;
    this.ctx = ctx;
    if (isLoopListQuery(args)) {
      await this.showLoops(ctx);
      return;
    }
    this.pi.sendMessage(
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
  }

  async showLoops(ctx: ExtensionContext): Promise<void> {
    if (!this.ctx) return;
    this.ctx = ctx;
    while (true) {
      const items = this.list();
      const now = Date.now();
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
      if (!this.ctx) return;
      if (result?.action === "stop") {
        this.notifyMutation(
          ctx,
          "Paused loop. Already dispatched work was not cancelled.",
          this.pause(result.id),
        );
        continue;
      }
      if (result?.action === "restart") {
        try {
          this.notifyMutation(ctx, "Restarted loop; queued until idle.", this.resume(result.id));
        } catch (error) {
          if (!(error instanceof LoopError)) throw error;
          ctx.ui.notify(error.message, "warning");
        }
        continue;
      }
      if (result?.action === "remove") {
        this.notifyMutation(
          ctx,
          "Removed loop. Already dispatched work was not cancelled.",
          this.remove(result.id),
        );
        continue;
      }
      return;
    }
  }

  private checkpoint(tasks: TaskDefinition[]): string | undefined {
    const ctx = this.ctx;
    if (!ctx) return;
    const serialized = JSON.stringify(tasks);
    if (serialized === this.lastSavedDefinitions) return;
    try {
      this.pi.appendEntry(LOOP_STATE_CUSTOM_TYPE, {
        version: 1,
        sessionId: ctx.sessionManager.getSessionId(),
        tasks,
      });
      this.lastSavedDefinitions = serialized;
    } catch {
      // Pi may retain the failed entry in memory; a later explicit operation must save again.
      this.lastSavedDefinitions = null;
      return "Loop change applied in memory but could not be saved for restart.";
    }
  }

  private refreshWidget(): void {
    const ctx = this.ctx;
    if (!ctx?.hasUI) return;
    const lines = formatWidgetLines(this.list(), Date.now());
    const key = lines.join("\n");
    if (key === this.lastWidget) return;
    this.lastWidget = key;
    ctx.ui.setWidget(WIDGET_ID, lines.length > 0 ? lines : undefined);
  }

  private notifyMutation(
    ctx: ExtensionContext,
    message: string,
    outcome: MutationOutcome<unknown>,
  ): void {
    ctx.ui.notify(
      persistenceFeedback(message, outcome.warning),
      outcome.warning ? "warning" : "info",
    );
  }

  private mutationResult(
    message: string,
    outcome: MutationOutcome<unknown>,
    details: CreateResult | Record<string, never> = {},
  ) {
    if (outcome.warning && this.ctx?.hasUI) this.ctx.ui.notify(outcome.warning, "warning");
    return textResult(persistenceFeedback(message, outcome.warning), details);
  }
}

function persistenceFeedback(message: string, warning?: string): string {
  return warning ? `${message} Warning: ${warning}` : message;
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
      ? `${head}, next interval fire at ${result.next_fire_at}.`
      : `${head}, ${result.stopped ? "paused" : "no interval fire before expiry"}.`,
  ];
  parts.push(`Expires at ${result.expires_at}.`);
  if (result.raised) parts.push("Interval was raised to the 60s minimum.");
  if (result.pending)
    parts.push("A fire is queued until the session is idle with no pending messages.");
  return parts.join(" ");
}
