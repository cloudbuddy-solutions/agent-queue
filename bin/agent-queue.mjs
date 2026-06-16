#!/usr/bin/env node
// agent-queue: a tiny file-based work queue for AI agents.
//
// A planner writes decision-ready tasks (each carries its own context, one
// allowed action, and a verification plan). A worker claims one task at a time,
// completes it with evidence, and every move is appended to a run log. The queue
// permits at most one claimed task per target so unrelated targets run in
// parallel. No database, no server: tasks are JSON files on disk.
//
// Usage:
//   agent-queue init [--queue <dir>]                            scaffold a queue
//   agent-queue add --file <task.json>      (or pipe JSON on stdin)
//   agent-queue list [--status s] [--lane l]
//   agent-queue show <task-id>
//   agent-queue next [--by worker]                              claim next eligible task
//   agent-queue claim <task-id> [--by worker]
//   agent-queue complete <task-id> --summary "..." --evidence "check => outcome" [--evidence ...] [--file-changed p] [--commit sha] [--follow-up "..."]
//   agent-queue fail <task-id> --reason "..."
//   agent-queue block <task-id> --reason "..."
//   agent-queue release <task-id>                               claimed/blocked -> queued
//   agent-queue cancel <task-id> --reason "..."
//   agent-queue approve <task-id> [--by owner] [--note "..."]
//   agent-queue pending                                        list everything waiting on a person
//   agent-queue status
//   agent-queue archive [<task-id>] [--days 14]                 move terminal tasks to archive/YYYY-MM/
//
// Queue location precedence: --queue flag > AGENT_QUEUE_DIR env >
// agent-queue.config.json "queueDir" > ./.agent-queue
//
// License: CC BY 4.0. Copyright (c) 2026 CloudBuddy Solutions.

import { readFile, writeFile, mkdir, readdir, rename, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledSchemaPath = path.join(pkgDir, "schema", "task.schema.json");

const TERMINAL = new Set(["done", "failed", "cancelled"]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        if (args[key] === undefined) args[key] = next;
        else if (Array.isArray(args[key])) args[key].push(next);
        else args[key] = [args[key], next];
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// Resolve where the queue lives and which schema validates it. Config file is
// optional; flags and env override it; everything falls back to sensible
// cwd-relative defaults so `agent-queue init` works with zero setup.
function resolveConfig(args) {
  const cwd = process.cwd();
  let fileCfg = {};
  const cfgPath = path.join(cwd, "agent-queue.config.json");
  if (existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch (error) {
      throw new Error(`Could not parse agent-queue.config.json: ${error.message}`);
    }
  }
  const queueDir = path.resolve(
    cwd,
    args.queue ?? process.env.AGENT_QUEUE_DIR ?? fileCfg.queueDir ?? ".agent-queue"
  );
  const schemaPath = fileCfg.schema
    ? path.resolve(cwd, fileCfg.schema)
    : bundledSchemaPath;
  return {
    cwd,
    queueDir,
    tasksDir: path.join(queueDir, "tasks"),
    archiveDir: path.join(queueDir, "archive"),
    indexPath: path.join(queueDir, "index.json"),
    logPath: path.join(queueDir, "log.md"),
    schemaPath,
    roles: {
      planner: fileCfg.plannerName ?? "planner",
      worker: fileCfg.workerName ?? "worker",
      owner: fileCfg.ownerName ?? "owner"
    }
  };
}

async function ensureDirs(cfg) {
  await mkdir(cfg.tasksDir, { recursive: true });
  await mkdir(cfg.archiveDir, { recursive: true });
}

async function getValidator(cfg) {
  const schema = JSON.parse(await readFile(cfg.schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true });
  return ajv.compile(schema);
}

async function loadTasks(cfg) {
  let files = [];
  try {
    files = (await readdir(cfg.tasksDir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const tasks = [];
  for (const name of files) {
    tasks.push(JSON.parse(await readFile(path.join(cfg.tasksDir, name), "utf8")));
  }
  return tasks;
}

async function findTask(cfg, taskId) {
  const filePath = path.join(cfg.tasksDir, `${taskId}.json`);
  try {
    return { task: JSON.parse(await readFile(filePath, "utf8")), filePath };
  } catch {
    throw new Error(`No task found for ${taskId} in ${path.relative(cfg.cwd, cfg.tasksDir)}.`);
  }
}

async function saveTask(cfg, task, validate) {
  if (!validate(task)) {
    const details = validate.errors.map((e) => `  - ${e.instancePath || "/"} ${e.message}`).join("\n");
    throw new Error(`Task ${task.task_id} failed schema validation:\n${details}`);
  }
  const filePath = path.join(cfg.tasksDir, `${task.task_id}.json`);
  await writeFile(filePath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  await rebuildIndex(cfg);
  return filePath;
}

async function rebuildIndex(cfg) {
  const tasks = await loadTasks(cfg);
  tasks.sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
  const index = {
    object_type: "agent_queue_index",
    generated_at: new Date().toISOString(),
    counts: countByStatus(tasks),
    tasks: tasks.map((t) => ({
      task_id: t.task_id,
      title: t.title,
      status: t.status,
      lane: t.lane,
      priority: t.priority,
      target: t.target ?? null,
      created_at: t.created_at,
      claimed_by: t.claimed_by ?? null
    }))
  };
  await writeFile(cfg.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function countByStatus(tasks) {
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

async function appendLog(cfg, action, task, detail = "") {
  const line = `- [${new Date().toISOString()}] ${action} ${task.task_id} | ${task.title}${detail ? ` | ${detail}` : ""}\n`;
  await appendFile(cfg.logPath, line, "utf8");
}

function newTaskId(now) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `task-${stamp}-${rand}`;
}

function eligibleForClaim(task) {
  if (task.status !== "queued") return false;
  if (task.lane === "autonomous") return true;
  return task.owner_approval?.approved === true;
}

// Targets are opaque labels (a project, a repo, a lane). Tasks that share a
// target run one-at-a-time; tasks with no target have no concurrency limit.
function targetKey(task) {
  const raw = String(task.target ?? "").trim();
  if (!raw) return "";
  return process.platform === "win32" ? raw.toLowerCase() : raw;
}

function shortLine(task) {
  const claim = task.claimed_by ? ` claimed_by=${task.claimed_by}` : "";
  const target = task.target ? ` ${task.target} ::` : "";
  return `[p${task.priority}] ${task.task_id} (${task.status}, ${task.lane})${target} ${task.title}${claim}`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Enqueue-time handoff gate. The worker starts cold; a task that hands over less
// than the planner's full analysis is a dirty handoff and gets rejected here,
// not discovered mid-claim.
const VAGUE_OUTCOMES = /^(it\s+)?(works|passes|pass|ok|okay|done|success|succeeds|verified|looks good|no errors|clean|good)\.?$/i;

function handoffProblems(task) {
  const problems = [];
  for (const entry of task.verification ?? []) {
    if (VAGUE_OUTCOMES.test(String(entry.expected ?? "").trim())) {
      problems.push(`verification expected outcome "${entry.expected}" is vague - state the specific observable result (which check, which output, which behavior).`);
    }
  }
  const referencedPaths = new Set((task.source_references ?? []).map((ref) => String(ref.path ?? "").trim()).filter(Boolean));
  if (referencedPaths.size === 1 && (task.files_likely_touched ?? []).length > 1) {
    problems.push("files_likely_touched names several files but source_references grounds only one - reference each file the worker must understand or modify.");
  }
  return problems;
}

const HANDOFF_BAR = `Handoff bar (the worker starts cold):
  - context >= 200 chars: why this exists, what is known, what was tried/ruled out, conventions, gotchas
  - spec >= 120 chars: the concrete change and the pattern to follow
  - source_references: file/section refs with substantive notes (>= 20 chars) for every place the worker must touch or imitate
  - setup_notes when build/run/test is non-obvious
  - acceptance_criteria: specific, checkable statements
  - verification: exact commands with specific expected outcomes
  - out_of_scope: at least one explicit non-goal
Write it so a competent worker with zero prior context could finish without asking a question.`;

function parseEvidence(entries) {
  return entries.map((raw) => {
    const splitAt = raw.indexOf("=>");
    if (splitAt === -1) {
      throw new Error(`Evidence must be "check => outcome", got: ${raw}`);
    }
    return { check: raw.slice(0, splitAt).trim(), outcome: raw.slice(splitAt + 2).trim() };
  });
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const taskIdArg = args._[1];

try {
  const cfg = resolveConfig(args);
  const now = new Date();

  // init is special: it creates the queue and does not need an existing one.
  if (command === "init") {
    await ensureDirs(cfg);
    const cfgFile = path.join(cfg.cwd, "agent-queue.config.json");
    if (!existsSync(cfgFile)) {
      const starter = {
        queueDir: path.relative(cfg.cwd, cfg.queueDir) || ".agent-queue",
        plannerName: cfg.roles.planner,
        workerName: cfg.roles.worker,
        ownerName: cfg.roles.owner
      };
      await writeFile(cfgFile, `${JSON.stringify(starter, null, 2)}\n`, "utf8");
    }
    await rebuildIndex(cfg);
    console.log(`Initialized queue at ${path.relative(cfg.cwd, cfg.queueDir) || cfg.queueDir}.`);
    console.log("Next: write a task JSON (see examples/) and run `agent-queue add --file task.json`.");
    process.exit(0);
  }

  await ensureDirs(cfg);
  const validate = await getValidator(cfg);

  switch (command) {
    case "add": {
      const raw = args.file ? await readFile(path.resolve(args.file), "utf8") : await readStdin();
      if (!raw.trim()) throw new Error("Provide a task JSON via --file or stdin.");
      const task = JSON.parse(raw);
      task.schema_version ??= "1.0";
      task.task_id ??= newTaskId(now);
      task.created_at ??= now.toISOString();
      task.created_by ??= cfg.roles.planner;
      task.status ??= "queued";
      task.sensitivity ??= "redacted_or_metadata";
      const problems = handoffProblems(task);
      if (problems.length > 0) {
        throw new Error(`Task rejected: handoff is not clean.\n${problems.map((p) => `  - ${p}`).join("\n")}\n\n${HANDOFF_BAR}`);
      }
      let filePath;
      try {
        filePath = await saveTask(cfg, task, validate);
      } catch (error) {
        throw new Error(`${error.message}\n\n${HANDOFF_BAR}`);
      }
      await appendLog(cfg, "add", task, `lane=${task.lane} priority=${task.priority}`);
      console.log(`Queued ${task.task_id}: ${path.relative(cfg.cwd, filePath)}`);
      break;
    }

    case "list": {
      let tasks = await loadTasks(cfg);
      if (args.status) tasks = tasks.filter((t) => t.status === args.status);
      if (args.lane) tasks = tasks.filter((t) => t.lane === args.lane);
      tasks.sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
      if (tasks.length === 0) console.log("No tasks match.");
      for (const task of tasks) console.log(shortLine(task));
      break;
    }

    case "show": {
      if (!taskIdArg) throw new Error("Usage: show <task-id>");
      const { task } = await findTask(cfg, taskIdArg);
      console.log(JSON.stringify(task, null, 2));
      break;
    }

    case "next": {
      const allTasks = await loadTasks(cfg);
      const claimedElsewhere = allTasks.filter((t) => t.status === "claimed");
      const claimedTargets = new Set(claimedElsewhere.map(targetKey).filter(Boolean));
      const eligible = allTasks.filter(eligibleForClaim);
      const tasks = eligible.filter((task) => {
        const key = targetKey(task);
        return !key || !claimedTargets.has(key);
      });
      tasks.sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
      if (tasks.length === 0 && eligible.length > 0) {
        const targets = [...new Set(claimedElsewhere.map((task) => task.target).filter(Boolean))].join(", ");
        console.log(`Queue waiting: eligible tasks exist only in claimed targets (${targets}).`);
        break;
      }
      if (tasks.length === 0) {
        console.log("Queue empty: no eligible tasks.");
        break;
      }
      const task = tasks[0];
      task.status = "claimed";
      task.claimed_by = args.by ?? cfg.roles.worker;
      task.claimed_at = now.toISOString();
      await saveTask(cfg, task, validate);
      await appendLog(cfg, "claim", task, `by=${task.claimed_by}`);
      console.log(JSON.stringify(task, null, 2));
      break;
    }

    case "claim": {
      if (!taskIdArg) throw new Error("Usage: claim <task-id>");
      const { task } = await findTask(cfg, taskIdArg);
      if (!eligibleForClaim(task)) {
        throw new Error(`Task ${task.task_id} is not claimable (status=${task.status}, lane=${task.lane}, approved=${task.owner_approval?.approved ?? false}).`);
      }
      const key = targetKey(task);
      if (key) {
        const claimedInTarget = (await loadTasks(cfg)).filter((candidate) => (
          candidate.status === "claimed"
          && candidate.task_id !== task.task_id
          && targetKey(candidate) === key
        ));
        if (claimedInTarget.length > 0) {
          throw new Error(
            `Target "${task.target}" already has claimed task(s): ${claimedInTarget.map((candidate) => candidate.task_id).join(", ")}. Close or release them first.`
          );
        }
      }
      task.status = "claimed";
      task.claimed_by = args.by ?? cfg.roles.worker;
      task.claimed_at = now.toISOString();
      await saveTask(cfg, task, validate);
      await appendLog(cfg, "claim", task, `by=${task.claimed_by}`);
      console.log(`Claimed ${task.task_id} by ${task.claimed_by}.`);
      break;
    }

    case "complete": {
      if (!taskIdArg) throw new Error("Usage: complete <task-id> --summary ... --evidence \"check => outcome\"");
      const { task } = await findTask(cfg, taskIdArg);
      if (task.status !== "claimed") throw new Error(`Task ${task.task_id} is ${task.status}; only claimed tasks can be completed.`);
      const evidence = parseEvidence(asArray(args.evidence));
      if (!args.summary || evidence.length === 0) {
        throw new Error("complete requires --summary and at least one --evidence \"check => outcome\". No proof, no done.");
      }
      task.status = "done";
      task.result = {
        completed_at: now.toISOString(),
        summary: args.summary,
        verification_evidence: evidence,
        files_changed: asArray(args["file-changed"]),
        commits: asArray(args.commit),
        follow_ups: asArray(args["follow-up"])
      };
      await saveTask(cfg, task, validate);
      await appendLog(cfg, "complete", task, task.result.summary);
      console.log(`Completed ${task.task_id}.`);
      if (task.result.follow_ups.length > 0) {
        console.log(`Follow-ups for planner triage:\n${task.result.follow_ups.map((f) => `  - ${f}`).join("\n")}`);
      }
      break;
    }

    case "fail":
    case "block": {
      if (!taskIdArg || !args.reason) throw new Error(`Usage: ${command} <task-id> --reason "..."`);
      const { task } = await findTask(cfg, taskIdArg);
      if (task.status !== "claimed") throw new Error(`Task ${task.task_id} is ${task.status}; only claimed tasks can be ${command}ed.`);
      if (command === "fail") {
        task.status = "failed";
        task.failed_reason = args.reason;
      } else {
        task.status = "blocked";
        task.blocked_reason = args.reason;
      }
      await saveTask(cfg, task, validate);
      await appendLog(cfg, command, task, args.reason);
      console.log(`${command === "fail" ? "Failed" : "Blocked"} ${task.task_id}: ${args.reason}`);
      break;
    }

    case "release": {
      if (!taskIdArg) throw new Error("Usage: release <task-id>");
      const { task } = await findTask(cfg, taskIdArg);
      if (task.status !== "claimed" && task.status !== "blocked") {
        throw new Error(`Task ${task.task_id} is ${task.status}; only claimed or blocked tasks can be released.`);
      }
      task.status = "queued";
      delete task.claimed_by;
      delete task.claimed_at;
      delete task.blocked_reason;
      await saveTask(cfg, task, validate);
      await appendLog(cfg, "release", task);
      console.log(`Released ${task.task_id} back to queued.`);
      break;
    }

    case "cancel": {
      if (!taskIdArg || !args.reason) throw new Error("Usage: cancel <task-id> --reason \"...\"");
      const { task } = await findTask(cfg, taskIdArg);
      if (TERMINAL.has(task.status)) throw new Error(`Task ${task.task_id} is already terminal (${task.status}).`);
      task.status = "cancelled";
      task.cancelled_reason = args.reason;
      await saveTask(cfg, task, validate);
      await appendLog(cfg, "cancel", task, args.reason);
      console.log(`Cancelled ${task.task_id}.`);
      break;
    }

    case "approve": {
      if (!taskIdArg) throw new Error("Usage: approve <task-id>");
      const { task } = await findTask(cfg, taskIdArg);
      if (task.lane !== "needs_owner") throw new Error(`Task ${task.task_id} is lane=${task.lane}; only needs_owner tasks take approval.`);
      task.owner_approval = {
        approved: true,
        approved_by: args.by ?? cfg.roles.owner,
        approved_at: now.toISOString(),
        ...(args.note ? { note: args.note } : {})
      };
      await saveTask(cfg, task, validate);
      await appendLog(cfg, "approve", task, `by=${task.owner_approval.approved_by}`);
      console.log(`Approved ${task.task_id}; now claimable.`);
      break;
    }

    case "status": {
      const tasks = await loadTasks(cfg);
      const counts = countByStatus(tasks);
      console.log(`Tasks: ${tasks.length}`);
      for (const [status, count] of Object.entries(counts)) console.log(`- ${status}: ${count}`);
      const awaiting = tasks.filter((t) => t.lane === "needs_owner" && t.status === "queued" && t.owner_approval?.approved !== true);
      if (awaiting.length > 0) {
        console.log("Awaiting owner approval:");
        for (const task of awaiting) console.log(`  ${shortLine(task)}`);
      }
      const blocked = tasks.filter((t) => t.status === "blocked");
      if (blocked.length > 0) {
        console.log("Blocked:");
        for (const task of blocked) console.log(`  ${shortLine(task)} | ${task.blocked_reason}`);
      }
      break;
    }

    case "pending": {
      // The human's inbox: everything that cannot move without a person.
      const byPriority = (a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at);
      const tasks = await loadTasks(cfg);
      const awaiting = tasks
        .filter((t) => t.lane === "needs_owner" && t.status === "queued" && t.owner_approval?.approved !== true)
        .sort(byPriority);
      const blocked = tasks.filter((t) => t.status === "blocked").sort(byPriority);
      if (awaiting.length === 0 && blocked.length === 0) {
        console.log("Nothing needs a person right now.");
        break;
      }
      const fileOf = (task) => path.relative(cfg.cwd, path.join(cfg.tasksDir, `${task.task_id}.json`));
      if (awaiting.length > 0) {
        console.log(`Awaiting approval (${awaiting.length}):`);
        for (const task of awaiting) {
          console.log(`  ${shortLine(task)}`);
          console.log(`    approve: agent-queue approve ${task.task_id}`);
          console.log(`    file:    ${fileOf(task)}`);
        }
      }
      if (blocked.length > 0) {
        console.log(`Blocked, needs intervention (${blocked.length}):`);
        for (const task of blocked) {
          console.log(`  ${shortLine(task)}${task.blocked_reason ? ` | ${task.blocked_reason}` : ""}`);
          console.log(`    release: agent-queue release ${task.task_id}`);
          console.log(`    file:    ${fileOf(task)}`);
        }
      }
      break;
    }

    case "archive": {
      if (taskIdArg) {
        const { task } = await findTask(cfg, taskIdArg);
        if (!TERMINAL.has(task.status)) {
          throw new Error(`Task ${task.task_id} is ${task.status}; only terminal tasks can be archived.`);
        }
        const stamp = task.result?.completed_at ?? task.created_at;
        const month = stamp.slice(0, 7);
        const destDir = path.join(cfg.archiveDir, month);
        await mkdir(destDir, { recursive: true });
        await rename(path.join(cfg.tasksDir, `${task.task_id}.json`), path.join(destDir, `${task.task_id}.json`));
        await rebuildIndex(cfg);
        console.log(`Archived ${task.task_id} to ${path.relative(cfg.cwd, destDir)}.`);
        break;
      }
      const days = Number(args.days ?? 14);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const tasks = await loadTasks(cfg);
      let moved = 0;
      for (const task of tasks) {
        if (!TERMINAL.has(task.status)) continue;
        const stamp = task.result?.completed_at ?? task.created_at;
        if (new Date(stamp).getTime() > cutoff) continue;
        const month = stamp.slice(0, 7);
        const destDir = path.join(cfg.archiveDir, month);
        await mkdir(destDir, { recursive: true });
        await rename(path.join(cfg.tasksDir, `${task.task_id}.json`), path.join(destDir, `${task.task_id}.json`));
        moved += 1;
      }
      await rebuildIndex(cfg);
      console.log(`Archived ${moved} terminal task(s) older than ${days} days.`);
      break;
    }

    default:
      throw new Error(`Unknown command: ${command ?? "(none)"}. See the header of bin/agent-queue.mjs for usage.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
