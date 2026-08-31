import { describe, expect, it } from "vitest";
import { LoopError, parseInterval } from "../extensions/interval.ts";

describe("interval", () => {
  it("keeps exact intervals and raises sub-minute values to 60s", () => {
    expect(parseInterval("5m")).toEqual({ compact: "5m", ms: 5 * 60_000, raised: false });
    expect(parseInterval("90m")).toEqual({ compact: "90m", ms: 90 * 60_000, raised: false });
    expect(parseInterval("2h")).toEqual({ compact: "2h", ms: 2 * 3_600_000, raised: false });
    expect(parseInterval("30s")).toEqual({ compact: "60s", ms: 60_000, raised: true });
  });

  it("rejects unknown units, zero, and intervals longer than the 7-day TTL", () => {
    expect(() => parseInterval("0m")).toThrow(LoopError);
    expect(() => parseInterval("5x")).toThrow(LoopError);
    expect(() => parseInterval("8d")).toThrow(/INVALID_INTERVAL/);
  });
});
