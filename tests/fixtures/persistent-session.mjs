import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";

// Offline SDK smoke: seed a real conversation record without contacting a provider.
const [phase, directory, sessionPath] = process.argv.slice(2);
assert.equal(VERSION, "1.4.0");
const cwd = process.cwd();
const agentDir = join(directory, "agent");
const settingsManager = SettingsManager.inMemory();
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  additionalExtensionPaths: [resolve("extensions/index.ts")],
});
await resourceLoader.reload();
const sessionManager =
  phase === "create" || phase === "failed-reload"
    ? SessionManager.create(cwd, directory)
    : SessionManager.open(sessionPath);
const { session } = await createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  resourceLoader,
  sessionManager,
  tools: ["scheduler_*"],
});
await session.bindExtensions({
  onError: (error) => {
    throw new Error(error.message);
  },
});
const call = (name, params = {}) =>
  session.getToolDefinition(name).execute("offline-smoke", params);
const list = async () => JSON.parse((await call("scheduler_list")).content[0].text);
const snapshots = () =>
  sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "@getpie/pi-loop/state");

const diskSnapshots = () =>
  readFileSync(sessionManager.getSessionFile(), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((entry) => entry.type === "custom" && entry.customType === "@getpie/pi-loop/state");

try {
  if (phase === "failed-reload") {
    sessionManager.appendMessage({
      role: "user",
      content: "Offline failed-save reload smoke.",
      timestamp: Date.now(),
    });
    const { details } = await call("scheduler_create", {
      prompt: "Old offline standing order",
      interval: "5m",
    });
    const file = sessionManager.getSessionFile();
    renameSync(file, `${file}.backup`);
    mkdirSync(file);
    const failed = await call("scheduler_create", {
      id: details.id,
      prompt: "Recovered offline standing order",
    });
    assert(failed.content[0].text.includes("could not be saved for restart"));
    const beforeReload = snapshots().length;
    await session.reload();
    assert.equal(snapshots().length, beforeReload);
    assert.equal((await list())[0].prompt_preview, "Recovered offline standing order");
    rmdirSync(file);
    renameSync(`${file}.backup`, file);
    assert.equal(diskSnapshots().at(-1).data.tasks[0].prompt, "Old offline standing order");
    const retried = await call("scheduler_create", {
      id: details.id,
      prompt: "Recovered offline standing order",
    });
    assert(!retried.content[0].text.includes("could not be saved"));
    assert.equal(diskSnapshots().at(-1).data.tasks[0].prompt, "Recovered offline standing order");
    assert.equal(diskSnapshots().length, 2);
    await call("scheduler_create", { id: details.id, prompt: "Recovered offline standing order" });
    assert.equal(diskSnapshots().length, 2);
    assert.equal(snapshots().length, beforeReload + 1);
  } else if (phase === "recovered") {
    const [restored] = await list();
    assert.equal(restored.prompt_preview, "Recovered offline standing order");
    const count = snapshots().length;
    await call("scheduler_create", { id: restored.id, prompt: "Recovered offline standing order" });
    assert.equal(snapshots().length, count);
  } else if (phase === "create") {
    sessionManager.appendMessage({
      role: "user",
      content: "Offline scheduler persistence smoke.",
      timestamp: Date.now(),
    });
    const { details } = await call("scheduler_create", {
      prompt: "Offline standing order",
      interval: "5m",
    });
    const beforeReload = snapshots().length;
    await call("scheduler_create", {
      id: details.id,
      prompt: "Offline standing order",
      interval: "5m",
    });
    assert.equal(snapshots().length, beforeReload);
    const sessionId = sessionManager.getSessionId();
    const realNow = Date.now;
    // Simulate elapsed time so resetting the deadline cannot pass unnoticed.
    Date.now = () => realNow() + 90_000;
    try {
      await session.reload();
      assert.equal(sessionManager.getSessionId(), sessionId);
      assert.equal((await list())[0].next_fire_at, details.next_fire_at);
    } finally {
      Date.now = realNow;
    }
    assert.equal(snapshots().length, beforeReload);
    // Reload can restore an unsaved in-memory entry, so one explicit checkpoint is required.
    await call("scheduler_create", {
      id: details.id,
      prompt: "Offline standing order",
      interval: "5m",
    });
    assert.equal(snapshots().length, beforeReload + 1);
    await call("scheduler_create", { id: details.id, prompt: "Offline standing order" });
    assert.equal(snapshots().length, beforeReload + 1);
    assert.equal((await list())[0].id, details.id);
    assert.equal((await list())[0].expires_at, details.expires_at);
    assert.equal((await list())[0].pending, false);
    assert.equal((await list())[0].running, false);
  } else if (phase === "resume") {
    const [restored] = await list();
    const stored = snapshots().at(-1).data.tasks[0];
    assert.equal(restored.id, stored.id);
    assert.equal(restored.expires_at, new Date(stored.expiresAt).toISOString());
    assert.equal(restored.pending, false);
    assert.equal(restored.running, false);
    assert.equal(restored.next_fire_at, new Date(stored.anchorAt).toISOString());
    const count = snapshots().length;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(snapshots().length, count);
    await call("scheduler_create", {
      id: restored.id,
      prompt: "Updated offline standing order",
      interval: "10m",
    });
    await session.reload();
    assert.equal((await list())[0].prompt_preview, "Updated offline standing order");
    await call("scheduler_delete", { id: restored.id });
    assert.deepEqual(snapshots().at(-1).data.tasks, []);
  } else {
    assert.equal(phase, "empty");
    assert.deepEqual(await list(), []);
    assert.deepEqual(snapshots().at(-1).data.tasks, []);
  }
  const prompt = (await list())[0]?.prompt_preview;
  const count = snapshots().length;
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(snapshots().length, count);
  const diskCount = diskSnapshots().length;
  // The failed append remains in Pi memory but never reached disk.
  assert.equal(diskCount, phase === "failed-reload" ? count - 1 : count);
  console.log(
    JSON.stringify({
      phase,
      version: VERSION,
      sessionId: sessionManager.getSessionId(),
      path: sessionManager.getSessionFile(),
      snapshots: count,
      diskSnapshots: diskCount,
      prompt,
    }),
  );
} finally {
  session.dispose();
}
