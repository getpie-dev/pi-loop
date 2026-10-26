import { randomBytes } from "node:crypto";
import { LoopError, parseInterval } from "./interval.js";
import {
  assertPromptSize,
  buildScheduledContent,
  type LoopMessageDetails,
  previewPrompt,
} from "./prompt.js";

export const MAX_TASKS = 50;
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DISPATCH_CONFIRM_MS = 30_000;

export interface LoopClock {
  now(): number;
}

export interface LoopDispatch {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  sendScheduled(payload: { content: string; details: LoopMessageDetails }): void;
}

export interface LoopTask {
  id: string;
  prompt: string;
  interval: string;
  intervalMs: number;
  createdAt: number;
  expiresAt: number;
  nextFireAt: number | null;
  pendingSince: number | null;
  stopped: boolean;
  lastDispatch?: DispatchFact;
}

export type TaskDefinition = Pick<
  LoopTask,
  "id" | "prompt" | "interval" | "createdAt" | "expiresAt" | "stopped"
>;

export interface DispatchFact {
  status: "dispatched" | "started" | "settled" | "unconfirmed" | "unconfirmed_timeout";
  at: string;
}

export interface InFlight {
  taskId: string;
  started: boolean;
  dispatchedAt: number;
}

export interface CreateInput {
  prompt: string;
  interval: string;
  fireImmediately?: boolean;
}

export type UpdateInput =
  | { id: string; prompt: string; interval?: string }
  | { id: string; interval: string; prompt?: string };

export interface CreateResult {
  id: string;
  interval: string;
  next_fire_at: string | null;
  expires_at: string | null;
  pending: boolean;
  updated: boolean;
  raised: boolean;
  stopped: boolean;
}

export interface SchedulerListItem {
  id: string;
  prompt_preview: string;
  interval: string;
  next_fire_at: string | null;
  expires_at: string | null;
  pending: boolean;
  running: boolean;
  stopped: boolean;
  last_dispatch?: DispatchFact;
}

export interface SchedulerHost {
  clock: LoopClock;
  dispatch: LoopDispatch;
  onChange?: () => void;
  onMutation?: () => void;
  onWarning?: (message: string) => void;
}

export class SessionLoopScheduler {
  private tasks = new Map<string, LoopTask>();
  private inFlight: InFlight | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = true;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: SchedulerHost) {}

  startSession(definitions: unknown[] = []): void {
    this.stopTimer();
    this.tasks.clear();
    this.inFlight = null;
    this.disposed = false;
    const now = this.host.clock.now();
    for (const definition of definitions.slice(0, MAX_TASKS)) {
      const task = this.restoreDefinition(definition, now);
      if (task && !this.tasks.has(task.id)) this.add(task);
    }
    this.notify();
  }

  dispose(): void {
    this.stopTimer();
    this.tasks.clear();
    this.inFlight = null;
    this.disposed = true;
    this.notify();
  }

  markStarted(): void {
    if (this.stale() || !this.inFlight) return;
    this.inFlight.started = true;
    this.recordDispatch(this.inFlight.taskId, "started");
    this.notify();
  }

  handleSettled(): void {
    if (this.stale()) return;
    const flight = this.inFlight;
    if (flight?.started) this.finishFlight(flight);
    else if (flight) this.releaseUnstarted(flight);
    this.notify();
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (this.stale()) return;
      this.drain();
      this.notify();
    }, 0);
  }

  tick(): void {
    if (this.stale()) return;
    const now = this.host.clock.now();
    if (
      this.inFlight &&
      !this.inFlight.started &&
      now - this.inFlight.dispatchedAt > DISPATCH_CONFIRM_MS
    ) {
      this.releaseUnstarted(this.inFlight, true);
    }
    this.drain();
    this.notify();
  }

  dispatchPending(): void {
    this.drain();
    this.notify();
  }

  create(input: CreateInput): CreateResult {
    this.assertActive();
    this.assertPrompt(input.prompt);
    this.assertCapacity();
    const parsed = parseInterval(input.interval);
    const now = this.host.clock.now();
    const id = this.allocId();
    const fireImmediately = input.fireImmediately === true;
    const task: LoopTask = {
      id,
      prompt: input.prompt,
      interval: parsed.compact,
      intervalMs: parsed.ms,
      createdAt: now,
      expiresAt: now + TTL_MS,
      nextFireAt: now + parsed.ms < now + TTL_MS ? now + parsed.ms : null,
      pendingSince: fireImmediately ? now : null,
      stopped: false,
    };
    this.add(task);
    this.mutated();
    return this.toCreateResult(task, { updated: false, raised: parsed.raised });
  }

  update(input: UpdateInput): CreateResult {
    this.assertActive();
    const task = this.tasks.get(input.id);
    if (!task) throw new LoopError("TASK_NOT_FOUND", `no scheduled loop with id ${input.id}`);
    if (input.prompt != null) this.assertPrompt(input.prompt);
    const parsed = input.interval != null ? parseInterval(input.interval) : undefined;
    if (input.prompt != null) task.prompt = input.prompt;
    if (parsed) {
      task.interval = parsed.compact;
      task.intervalMs = parsed.ms;
    }
    this.mutated();
    return this.toCreateResult(task, { updated: true, raised: parsed?.raised ?? false });
  }

  list(): SchedulerListItem[] {
    return [...this.tasks.values()]
      .sort((a, b) => {
        if (a.stopped !== b.stopped) return a.stopped ? 1 : -1;
        const an = a.nextFireAt ?? Number.POSITIVE_INFINITY;
        const bn = b.nextFireAt ?? Number.POSITIVE_INFINITY;
        if (an !== bn) return an - bn;
        return a.id.localeCompare(b.id);
      })
      .map((task) => this.toListItem(task));
  }

  stop(id: string): "stopped" | "stopped_current_running" | "not_found" {
    const task = this.tasks.get(id);
    if (!task) return "not_found";
    task.stopped = true;
    task.pendingSince = null;
    this.mutated();
    return this.inFlight?.taskId === id ? "stopped_current_running" : "stopped";
  }

  restart(id: string): CreateResult {
    this.assertActive();
    const task = this.tasks.get(id);
    if (!task) throw new LoopError("TASK_NOT_FOUND", `no scheduled loop with id ${id}`);
    const now = this.host.clock.now();
    if (now >= task.expiresAt) throw new LoopError("TASK_EXPIRED", `loop ${id} has expired`);
    task.stopped = false;
    task.pendingSince = now;
    const next = now + task.intervalMs;
    task.nextFireAt = next >= task.expiresAt ? null : next;
    this.mutated();
    this.dispatchPending();
    return this.toCreateResult(task, { updated: true, raised: false });
  }

  delete(id: string): "deleted_before_dispatch" | "future_deleted_current_running" | "not_found" {
    const task = this.tasks.get(id);
    if (!task) return "not_found";
    const running = this.inFlight?.taskId === id;
    this.remove(task);
    this.mutated();
    return running ? "future_deleted_current_running" : "deleted_before_dispatch";
  }

  private markDue(now: number): void {
    const due = [...this.tasks.values()]
      .filter(
        (task) =>
          !task.stopped &&
          now < task.expiresAt &&
          task.nextFireAt != null &&
          task.nextFireAt <= now,
      )
      .sort(compareDue);
    for (const task of due) {
      const next = now + task.intervalMs;
      task.nextFireAt = next >= task.expiresAt ? null : next;
      if (task.pendingSince == null) task.pendingSince = now;
    }
    for (const task of [...this.tasks.values()]) {
      if (now < task.expiresAt) continue;
      task.pendingSince = null;
      task.nextFireAt = null;
      if (this.inFlight?.taskId !== task.id) this.remove(task);
    }
  }

  private drain(): void {
    if (this.stale()) return;
    this.markDue(this.host.clock.now());
    if (this.inFlight) return;
    const pending = [...this.tasks.values()]
      .filter((task) => !task.stopped && task.pendingSince != null)
      .sort((a, b) => {
        const dt = (a.pendingSince ?? 0) - (b.pendingSince ?? 0);
        return dt !== 0 ? dt : a.id.localeCompare(b.id);
      });
    const next = pending[0];
    if (next) this.tryDispatch(next);
  }

  private tryDispatch(task: LoopTask): boolean {
    if (task.stopped || this.host.clock.now() >= task.expiresAt) return false;
    if (this.stale() || this.inFlight) {
      task.pendingSince ??= this.host.clock.now();
      return false;
    }
    if (!this.canDispatchNow()) {
      task.pendingSince ??= this.host.clock.now();
      return false;
    }
    const now = this.host.clock.now();
    if (now >= task.expiresAt) return false;
    this.inFlight = { taskId: task.id, started: false, dispatchedAt: now };
    this.recordDispatch(task.id, "dispatched");
    task.pendingSince = null;
    this.host.dispatch.sendScheduled({
      content: buildScheduledContent(task.prompt, task.id, task.interval),
      details: { taskId: task.id, prompt: task.prompt },
    });
    return true;
  }

  private canDispatchNow(): boolean {
    if (this.stale() || this.inFlight) return false;
    try {
      return this.host.dispatch.isIdle() && !this.host.dispatch.hasPendingMessages();
    } catch {
      return false;
    }
  }

  private finishFlight(flight: InFlight): void {
    const task = this.tasks.get(flight.taskId);
    this.recordDispatch(flight.taskId, "settled");
    this.inFlight = null;
    if (task && this.host.clock.now() >= task.expiresAt) this.remove(task);
    if (this.tasks.size === 0) this.stopTimer();
  }

  private releaseUnstarted(flight: InFlight, timedOut = false): void {
    this.recordDispatch(flight.taskId, timedOut ? "unconfirmed_timeout" : "unconfirmed");
    const reason = timedOut ? "start confirmation timed out" : "dispatch was not confirmed started";
    this.host.onWarning?.(
      `Loop ${flight.taskId}: ${reason}; no retry was queued. Already dispatched work was not cancelled.`,
    );
    const task = this.tasks.get(flight.taskId);
    this.inFlight = null;
    if (task) task.pendingSince = null;
    if (this.tasks.size === 0) this.stopTimer();
  }

  definitions(): TaskDefinition[] {
    return [...this.tasks.values()].map(
      ({ id, prompt, interval, createdAt, expiresAt, stopped }) => ({
        id,
        prompt,
        interval,
        createdAt,
        expiresAt,
        stopped,
      }),
    );
  }

  private restoreDefinition(value: unknown, now: number): LoopTask | null {
    if (!value || typeof value !== "object") return null;
    const task = value as TaskDefinition;
    if (
      typeof task.id !== "string" ||
      !/^[a-f0-9]{8}$/.test(task.id) ||
      typeof task.prompt !== "string" ||
      typeof task.interval !== "string" ||
      typeof task.stopped !== "boolean" ||
      !Number.isSafeInteger(task.createdAt) ||
      !Number.isSafeInteger(task.expiresAt) ||
      task.createdAt < 0 ||
      task.expiresAt <= task.createdAt ||
      task.expiresAt - task.createdAt > TTL_MS ||
      task.expiresAt <= now ||
      task.expiresAt > 8.64e15
    )
      return null;
    try {
      this.assertPrompt(task.prompt);
      const parsed = parseInterval(task.interval);
      const next = now + parsed.ms;
      return {
        id: task.id,
        prompt: task.prompt,
        interval: parsed.compact,
        createdAt: task.createdAt,
        expiresAt: task.expiresAt,
        stopped: task.stopped,
        intervalMs: parsed.ms,
        pendingSince: null,
        nextFireAt: next < task.expiresAt ? next : null,
      };
    } catch {
      return null;
    }
  }

  private recordDispatch(id: string, status: DispatchFact["status"]): void {
    const task = this.tasks.get(id);
    if (task) task.lastDispatch = { status, at: new Date(this.host.clock.now()).toISOString() };
  }

  private mutated(): void {
    this.host.onMutation?.();
    this.notify();
  }

  private notify(): void {
    this.host.onChange?.();
  }

  private add(task: LoopTask): void {
    this.tasks.set(task.id, task);
    this.ensureTimer();
  }

  private remove(task: LoopTask): void {
    this.tasks.delete(task.id);
    if (this.tasks.size === 0 && !this.inFlight) this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.tickTimer || this.disposed) return;
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  private stopTimer(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private stale(): boolean {
    return this.disposed;
  }

  private assertActive(): void {
    if (this.disposed) throw new LoopError("TASK_NOT_FOUND", "session is not active");
  }

  private assertCapacity(): void {
    if (this.tasks.size >= MAX_TASKS) {
      throw new LoopError("LOOP_LIMIT_REACHED", "current session already has 50 active loops");
    }
  }

  private assertPrompt(prompt: string): void {
    if (!prompt.trim()) throw new LoopError("EMPTY_PROMPT", "prompt is empty");
    assertPromptSize(prompt);
  }

  private allocId(): string {
    for (let i = 0; i < 8; i += 1) {
      const id = toHex(randomBytes(4));
      if (!this.tasks.has(id)) return id;
    }
    throw new LoopError("LOOP_LIMIT_REACHED", "could not allocate task id");
  }

  private toCreateResult(
    task: LoopTask,
    flags: { updated: boolean; raised: boolean },
  ): CreateResult {
    return {
      id: task.id,
      interval: task.interval,
      next_fire_at: task.stopped ? null : iso(task.nextFireAt),
      expires_at: iso(task.expiresAt),
      stopped: task.stopped,
      pending: !task.stopped && task.pendingSince != null && this.inFlight?.taskId !== task.id,
      updated: flags.updated,
      raised: flags.raised,
    };
  }

  private toListItem(task: LoopTask): SchedulerListItem {
    return {
      id: task.id,
      prompt_preview: previewPrompt(task.prompt),
      interval: task.interval,
      next_fire_at: iso(task.nextFireAt),
      expires_at: iso(task.expiresAt),
      pending:
        !task.stopped &&
        (task.pendingSince != null ||
          (this.inFlight?.taskId === task.id && !this.inFlight.started)),
      running: this.inFlight?.taskId === task.id && this.inFlight.started,
      stopped: task.stopped,
      ...(task.lastDispatch ? { last_dispatch: task.lastDispatch } : {}),
    };
  }
}

function compareDue(a: LoopTask, b: LoopTask): number {
  const dt = (a.nextFireAt ?? 0) - (b.nextFireAt ?? 0);
  if (dt !== 0) return dt;
  const created = a.createdAt - b.createdAt;
  if (created !== 0) return created;
  return a.id.localeCompare(b.id);
}

function iso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
