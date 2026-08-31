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
}

export interface SchedulerHost {
  clock: LoopClock;
  dispatch: LoopDispatch;
  onChange?: () => void;
}

export class SessionLoopScheduler {
  private tasks = new Map<string, LoopTask>();
  private inFlight: InFlight | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = true;

  constructor(private readonly host: SchedulerHost) {}

  startSession(): void {
    this.stopTimer();
    this.tasks.clear();
    this.inFlight = null;
    this.disposed = false;
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
    this.notify();
  }

  handleSettled(): void {
    if (this.stale()) return;
    const flight = this.inFlight;
    if (flight?.started) this.finishFlight(flight);
    else if (flight) this.releaseUnstarted(flight);
    this.notify();
    setTimeout(() => {
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
      this.releaseUnstarted(this.inFlight);
    }
    this.markDue(now);
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
      nextFireAt: now + parsed.ms,
      pendingSince: fireImmediately ? now : null,
      stopped: false,
    };
    this.add(task);
    this.notify();
    return this.toCreateResult(task, { updated: false, raised: parsed.raised });
  }

  update(input: UpdateInput): CreateResult {
    this.assertActive();
    const task = this.tasks.get(input.id);
    if (!task) throw new LoopError("TASK_NOT_FOUND", `no scheduled loop with id ${input.id}`);
    if (input.prompt != null) {
      this.assertPrompt(input.prompt);
      task.prompt = input.prompt;
    }
    let raised = false;
    if (input.interval != null) {
      const parsed = parseInterval(input.interval);
      task.interval = parsed.compact;
      task.intervalMs = parsed.ms;
      raised = parsed.raised;
    }
    this.notify();
    return this.toCreateResult(task, { updated: true, raised });
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
    this.notify();
    return this.inFlight?.taskId === id ? "stopped_current_running" : "stopped";
  }

  restart(id: string): CreateResult {
    this.assertActive();
    const task = this.tasks.get(id);
    if (!task) throw new LoopError("TASK_NOT_FOUND", `no scheduled loop with id ${id}`);
    const now = this.host.clock.now();
    task.stopped = false;
    task.pendingSince = now;
    const next = now + task.intervalMs;
    task.nextFireAt = next > task.expiresAt ? null : next;
    this.notify();
    this.dispatchPending();
    return this.toCreateResult(task, { updated: true, raised: false });
  }

  delete(id: string): "deleted_before_dispatch" | "future_deleted_current_running" | "not_found" {
    const task = this.tasks.get(id);
    if (!task) return "not_found";
    const running = this.inFlight?.taskId === id;
    this.remove(task);
    this.notify();
    return running ? "future_deleted_current_running" : "deleted_before_dispatch";
  }

  private markDue(now: number): void {
    const due = [...this.tasks.values()]
      .filter((task) => !task.stopped && task.nextFireAt != null && task.nextFireAt <= now)
      .sort(compareDue);
    for (const task of due) {
      const next = now + task.intervalMs;
      task.nextFireAt = next > task.expiresAt ? null : next;
      if (task.pendingSince == null) task.pendingSince = now;
    }
    for (const task of [...this.tasks.values()]) {
      if (task.pendingSince != null || this.inFlight?.taskId === task.id) continue;
      if (now >= task.expiresAt) this.remove(task);
    }
  }

  private drain(): void {
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
    if (task.stopped) return false;
    if (this.stale() || this.inFlight) {
      task.pendingSince ??= this.host.clock.now();
      return false;
    }
    if (!this.canDispatchNow()) {
      task.pendingSince ??= this.host.clock.now();
      return false;
    }
    const now = this.host.clock.now();
    this.inFlight = { taskId: task.id, started: false, dispatchedAt: now };
    task.pendingSince = null;
    this.host.dispatch.sendScheduled({
      content: buildScheduledContent(task.prompt, task.id),
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
    this.inFlight = null;
    if (!task) return;
    if (this.host.clock.now() >= task.expiresAt) this.remove(task);
  }

  private releaseUnstarted(flight: InFlight): void {
    const task = this.tasks.get(flight.taskId);
    this.inFlight = null;
    if (!task) return;
    task.pendingSince = null;
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
    if (this.tasks.size === 0) this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.tickTimer || this.disposed) return;
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  private stopTimer(): void {
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
      next_fire_at: iso(task.nextFireAt),
      expires_at: iso(task.expiresAt),
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
      pending: !task.stopped && task.pendingSince != null,
      running: this.inFlight?.taskId === task.id,
      stopped: task.stopped,
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
