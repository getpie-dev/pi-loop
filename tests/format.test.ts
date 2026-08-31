import { describe, expect, it } from "vitest";
import {
  formatDue,
  formatLoopLine,
  formatLoopList,
  formatWidgetLines,
  isLoopListQuery,
} from "../extensions/format.ts";
import { isLoopRemoveKey, isLoopRestartKey, isLoopStopKey } from "../extensions/list-ui.ts";
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
    stopped: false,
    ...partial,
  };
}

describe("format", () => {
  it("maps d to stop, r to restart, and x/backspace to remove", () => {
    expect(isLoopStopKey("d")).toBe(true);
    expect(isLoopRestartKey("r")).toBe(true);
    expect(isLoopRemoveKey("x")).toBe(true);
    expect(isLoopRemoveKey("\x7f")).toBe(true);
    expect(isLoopStopKey("x")).toBe(false);
    expect(isLoopRestartKey("d")).toBe(false);
    expect(isLoopRemoveKey("d")).toBe(false);
  });

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

  it("renders the widget as a single line", () => {
    const items = [
      item({ id: "a", running: true }),
      item({ id: "b", pending: true }),
      item({ id: "c" }),
    ];
    expect(formatWidgetLines([], now)).toEqual([]);
    expect(formatWidgetLines(items.slice(0, 1), now)).toEqual(["[loop] running · check deploy"]);
    expect(formatWidgetLines(items, now)).toEqual(["[loop] running · check deploy · +2"]);
    expect(formatWidgetLines([item({ id: "s", stopped: true }), ...items], now)).toEqual([
      "[loop] running · check deploy · +3",
    ]);
    expect(formatLoopLine(item({ id: "s", stopped: true }), now)).toBe(
      "[loop] stopped · check deploy",
    );
  });

  it("formats a full query list without ids", () => {
    const items = [item({ id: "ab12", interval: "10m" })];
    expect(formatLoopLine(items[0]!, now)).toBe("[loop] next 4m · check deploy");
    expect(formatLoopList([], now)).toBe("No session loops.");
    expect(formatLoopList(items, now)).toBe("[loop] next 4m · check deploy");
    expect(formatLoopList(items, now)).not.toContain("ab12");
  });
});
