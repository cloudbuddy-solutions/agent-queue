// End-to-end smoke test: drives the CLI through init, add, the handoff gate,
// claim, complete, and status in a throwaway temp directory. Run with `npm test`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const bin = path.join(repo, "bin", "agent-queue.mjs");
const tmp = mkdtempSync(path.join(tmpdir(), "agent-queue-"));

function run(args, opts = {}) {
  return execFileSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: "utf8", ...opts });
}

const validTask = {
  schema_version: "1.0",
  task_id: "task-20260116-090000-aa01",
  created_at: "2026-01-16T09:00:00.000Z",
  created_by: "planner",
  title: "Smoke task",
  target: "demo",
  lane: "autonomous",
  priority: 2,
  context: "A".repeat(220),
  spec: "B".repeat(140),
  source_references: [{ path: "src/file.js", note: "The function the worker must change goes here." }],
  files_likely_touched: ["src/file.js"],
  acceptance_criteria: ["The behavior described in the spec is implemented and tested."],
  verification: [{ check: "npm test", expected: "all tests pass including the new case" }],
  out_of_scope: ["Do not touch unrelated modules."],
  risk: { level: "low", reasons: ["Isolated change"] },
  sensitivity: "public",
  status: "queued"
};

try {
  // init scaffolds the queue and a config file
  run(["init"]);
  assert.ok(existsSync(path.join(tmp, ".agent-queue", "tasks")), "tasks dir created");
  assert.ok(existsSync(path.join(tmp, "agent-queue.config.json")), "config written");

  // a clean task enqueues
  const goodPath = path.join(tmp, "good.json");
  writeFileSync(goodPath, JSON.stringify(validTask));
  assert.match(run(["add", "--file", goodPath]), /Queued task-/, "valid task queued");

  // the handoff gate rejects a vague verification outcome
  const dirty = structuredClone(validTask);
  dirty.task_id = "task-20260116-091000-bb02";
  dirty.verification = [{ check: "run it", expected: "works" }];
  const dirtyPath = path.join(tmp, "dirty.json");
  writeFileSync(dirtyPath, JSON.stringify(dirty));
  let rejected = false;
  try {
    run(["add", "--file", dirtyPath]);
  } catch (error) {
    rejected = true;
    assert.match(String(error.stderr || error.stdout || ""), /handoff/i, "rejection explains the handoff bar");
  }
  assert.ok(rejected, "dirty task rejected by the gate");

  // a worker claims the next eligible task
  const claimed = JSON.parse(run(["next", "--by", "worker"]));
  assert.equal(claimed.status, "claimed", "task is claimed");
  assert.equal(claimed.claimed_by, "worker", "claimed by the worker role");

  // complete requires evidence
  let blockedNoProof = false;
  try {
    run(["complete", claimed.task_id, "--summary", "Done."]);
  } catch {
    blockedNoProof = true;
  }
  assert.ok(blockedNoProof, "complete without evidence is refused");

  // complete with evidence lands done
  assert.match(
    run(["complete", claimed.task_id, "--summary", "Implemented and tested the change.", "--evidence", "npm test => 12 passing"]),
    /Completed/,
    "task completed with evidence"
  );

  assert.match(run(["status"]), /done: 1/, "status shows one done task");

  // pending: the human inbox surfaces awaiting-approval and blocked work
  const ownerTask = structuredClone(validTask);
  ownerTask.task_id = "task-20260116-092000-cc03";
  ownerTask.lane = "needs_owner";
  ownerTask.target = "billing";
  writeFileSync(path.join(tmp, "owner.json"), JSON.stringify(ownerTask));
  run(["add", "--file", path.join(tmp, "owner.json")]);

  const blockTask = structuredClone(validTask);
  blockTask.task_id = "task-20260116-092100-dd04";
  blockTask.target = "demo2";
  writeFileSync(path.join(tmp, "block.json"), JSON.stringify(blockTask));
  run(["add", "--file", path.join(tmp, "block.json")]);
  run(["claim", blockTask.task_id, "--by", "worker"]);
  run(["block", blockTask.task_id, "--reason", "waiting on access"]);

  const pending = run(["pending"]);
  assert.match(pending, /Awaiting approval \(1\)/, "pending shows awaiting approval");
  assert.match(pending, new RegExp(ownerTask.task_id), "pending lists the needs_owner task");
  assert.match(pending, /agent-queue approve/, "pending gives the approve command");
  assert.match(pending, /Blocked, needs intervention \(1\)/, "pending shows blocked work");
  assert.match(pending, new RegExp(blockTask.task_id), "pending lists the blocked task");
  assert.match(pending, /agent-queue release/, "pending gives the release command");

  console.log("smoke test passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
