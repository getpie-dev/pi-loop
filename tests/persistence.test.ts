import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const run = (phase: string, directory: string, path = "") =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ["tests/fixtures/persistent-session.mjs", phase, directory, path],
      { encoding: "utf8", timeout: 20_000 },
    ).trim(),
  );

it("reloads and resumes actual Pi 1.4.0 disk-backed state across process exits, offline", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-loop-smoke-"));
  try {
    const created = run("create", directory);
    const resumed = run("resume", directory, created.path);
    const empty = run("empty", directory, created.path);
    expect(created.version).toBe("1.4.0");
    expect(resumed.sessionId).toBe(created.sessionId);
    expect(empty.sessionId).toBe(created.sessionId);
    expect([created.snapshots, resumed.snapshots, empty.snapshots]).toEqual([2, 4, 4]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

it("checkpoints an identical explicit retry after a failed save and reload, then reopens from disk", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-loop-reload-retry-"));
  try {
    const retried = run("failed-reload", directory);
    const disk = readFileSync(retried.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const snapshots = disk.filter(
      (entry) => entry.type === "custom" && entry.customType === "@getpie/pi-loop/state",
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1).data.tasks[0].prompt).toBe("Recovered offline standing order");
    const reopened = run("recovered", directory, retried.path);
    expect(reopened.sessionId).toBe(retried.sessionId);
    expect(reopened.prompt).toBe("Recovered offline standing order");
    expect(reopened.diskSnapshots).toBe(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
