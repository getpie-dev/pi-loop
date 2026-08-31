import type { SchedulerListItem } from "./scheduler.js";

export const WIDGET_ID = "pi-loop";
export const WIDGET_MAX_ROWS = 4;

export function isLoopListQuery(args: string): boolean {
  const first = args.trim().split(/\s+/)[0]?.toLowerCase();
  return first === "list" || first === "ls";
}

export function formatDue(nextFireAt: string | null, now: number): string {
  if (nextFireAt == null) return "done";
  const ms = Date.parse(nextFireAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "due";
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.ceil(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.ceil(hr / 24)}d`;
}

export function formatLoopState(item: SchedulerListItem, now: number): string {
  if (item.running) return "running";
  if (item.pending) return "pending";
  return `next ${formatDue(item.next_fire_at, now)}`;
}

export function formatLoopLine(item: SchedulerListItem, now: number): string {
  return `${item.id}  ${item.interval}  ${formatLoopState(item, now)}  ${item.prompt_preview}`;
}

export function formatWidgetLines(items: SchedulerListItem[], now: number): string[] {
  if (items.length === 0) return [];
  const visible = items.length > WIDGET_MAX_ROWS ? WIDGET_MAX_ROWS - 1 : items.length;
  const lines = items.slice(0, visible).map((item) => formatLoopLine(item, now));
  if (items.length > visible) {
    lines.push(`… +${items.length - visible} more · /loops`);
  }
  return lines;
}

export function formatLoopList(items: SchedulerListItem[], now: number): string {
  if (items.length === 0) return "No session loops.";
  return items.map((item) => formatLoopLine(item, now)).join("\n");
}
