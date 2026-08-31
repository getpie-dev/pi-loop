import { describe, expect, it } from "vitest";
import {
  formatDue,
  formatLoopLine,
  formatLoopList,
  formatWidgetLines,
  isLoopListQuery,
} from "../extensions/format.ts";
import type { SchedulerListItem } from "../extensions/scheduler.ts";

const now = Date.parse("2026-08-31T03:00:00.000Z");

function item(
  partial: Partial<SchedulerListItem> & Pick<SchedulerListItem, "id">,
): SchedulerListItem {
  return {
    prompt_preview: "check deploy",
    interval: "5m",
    next_fire_at: new Date(now + 4 * 60_000).toISOString(),
    expires_at: new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
    pending: false,
    running: false,
    ...partial,
  };
}

describe("format", () => {
  it("treats list and ls as query args and nothing else", () => {
    expect(isLoopListQuery("list")).toBe(true);
    expect(isLoopListQuery(" ls ")).toBe(true);
    expect(isLoopListQuery("list extra")).toBe(true);
    expect(isLoopListQuery("")).toBe(false);
    expect(isLoopListQuery("5m check CI")).toBe(false);
  });

  it("formats due times as compact remaining units", () => {
    expect(formatDue(new Date(now + 12_000).toISOString(), now)).toBe("12s");
    expect(formatDue(new Date(now + 4 * 60_000).toISOString(), now)).toBe("4m");
    expect(formatDue(new Date(now).toISOString(), now)).toBe("due");
    expect(formatDue(null, now)).toBe("done");
  });

  it("renders widget rows and overflow", () => {
    const items = [
      item({ id: "a", running: true }),
      item({ id: "b", pending: true }),
      item({ id: "c" }),
      item({ id: "d" }),
      item({ id: "e" }),
    ];
    expect(formatWidgetLines([], now)).toEqual([]);
    expect(formatWidgetLines(items.slice(0, 1), now)).toEqual(["[loop] running · check deploy"]);
    const lines = formatWidgetLines(items, now);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("… +2 more · /loops");
    expect(lines.join("\n")).not.toContain("a  5m");
  });

  it("formats a full query list without ids", () => {
    const items = [item({ id: "ab12", interval: "10m" })];
    expect(formatLoopLine(items[0]!, now)).toBe("[loop] next 4m · check deploy");
    expect(formatLoopList([], now)).toBe("No session loops.");
    expect(formatLoopList(items, now)).toBe("[loop] next 4m · check deploy");
    expect(formatLoopList(items, now)).not.toContain("ab12");
  });
});
