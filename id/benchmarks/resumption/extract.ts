/**
 * Resumption benchmark v2 — extract fixtures from real handoffs.
 *
 * v1 and v1.1 asked: does *synthesis* help, with information held constant?
 * Both arms received identical curated evidence and the packet only reorganized
 * it. The answer at ~1.2k tokens was no (Δ-1.1pp) — a careful reader saturates.
 *
 * v2 asks the question the product actually rests on: **does the recorded
 * ledger help, with the repo held constant?** Here the booted arm legitimately
 * knows things the cold arm cannot derive. "codex tried a PEG grammar here and
 * it died on nested blocks" is not latent in the repo — it exists only because
 * someone recorded it. That asymmetry is the value proposition, not a leak, and
 * this file is explicit about it so no one reads a v2 delta as a v1 delta.
 *
 * Fixtures come from real handoff moments in the corpus: a point where one
 * agent finished a run and a different agent started the next one in the same
 * repo. Ground truth is what the second agent actually did — and, where the
 * outcome layer has labeled it, whether that work survived.
 *
 * Output is the same `ResumptionTask` shape v1 uses, so `runner.ts` runs it
 * unchanged:
 *
 *   npx tsx id/benchmarks/resumption/extract.ts --corpus --out <dir>
 *   SEEDROP_BENCH_TASKS_DIR=<dir> npx tsx id/benchmarks/resumption/run.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ResumptionProbe, ResumptionTask } from "./types.js";

interface RunRecord {
  run_id: string;
  agent_id: string;
  goal: string;
  status: string;
  cause?: string;
  swept?: boolean;
  started_at: string;
  finished_at?: string;
  decisions?: string[];
  assumptions?: string[];
  open_threads?: string[];
  changed_paths?: string[];
  validation?: Array<{ command: string; status: string }>;
}

const EVIDENCE_LOG_COMMITS = 25;
const EVIDENCE_FILE_LIMIT = 60;
const PACKET_PRIOR_RUNS = 6;
const PACKET_GRAVE_LIMIT = 4;
const README_CHARS = 1200;

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function loadRuns(root: string): RunRecord[] {
  const dir = join(root, ".seedrop", "view", "runs");
  if (!existsSync(dir)) return [];
  const runs: RunRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const run = JSON.parse(readFileSync(join(dir, name), "utf8")) as RunRecord;
      if (run.run_id && run.started_at && run.goal) runs.push(run);
    } catch {
      // A malformed run should not abort extraction over the whole corpus.
    }
  }
  return runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** The commit a fresh agent would have been looking at when it arrived at `iso`. */
function commitAt(root: string, iso: string): string | null {
  const out = git(root, ["rev-list", "-1", `--before=${iso}`, "HEAD"]);
  const sha = out?.trim();
  return sha && sha.length > 0 ? sha : null;
}

function fileAtCommit(root: string, sha: string, path: string): string | null {
  return git(root, ["show", `${sha}:${path}`]);
}

/**
 * What a cold agent genuinely has: the repo as of the handoff. Orientation docs,
 * recent history, and the file tree — everything derivable without a ledger.
 * Deliberately excludes run journals, tasks, and continuity packets.
 */
function buildRepoEvidence(root: string, sha: string, projectName: string): string {
  const parts: string[] = [`# Repository: ${projectName}`, ""];

  for (const doc of ["README.md", "AGENTS.md", "CLAUDE.md"]) {
    const content = fileAtCommit(root, sha, doc);
    if (content) {
      parts.push(`## ${doc}`, "", content.slice(0, README_CHARS).trimEnd(), "");
    }
  }

  const log = git(root, ["log", "--oneline", "-n", String(EVIDENCE_LOG_COMMITS), sha]);
  if (log) parts.push("## Recent commit history (newest first)", "", log.trimEnd(), "");

  const tree = git(root, ["ls-tree", "-r", "--name-only", sha]);
  if (tree) {
    const files = tree.trimEnd().split("\n");
    const shown = files.slice(0, EVIDENCE_FILE_LIMIT);
    parts.push(
      "## Tracked files",
      "",
      shown.join("\n"),
      files.length > shown.length ? `...and ${files.length - shown.length} more` : "",
      "",
    );
  }

  return parts.join("\n").trimEnd();
}

/**
 * The ledger as of the handoff: what prior agents recorded and no one else could
 * know. Built only from records timestamped before the handoff, so the packet
 * never sees the future it is being asked to predict.
 */
function buildBootPacket(prior: RunRecord[], next: RunRecord, projectName: string): string {
  const parts: string[] = [
    `# Situation: ${projectName}`,
    "",
    `You are ${next.agent_id}, arriving in this repository.`,
    "",
  ];

  const finished = prior.filter((r) => r.status === "completed").slice(-PACKET_PRIOR_RUNS);
  if (finished.length > 0) {
    parts.push("## Work already completed here", "");
    for (const run of finished) {
      parts.push(`- [${run.agent_id}] ${run.goal}`);
      for (const decision of (run.decisions ?? []).slice(0, 2)) {
        parts.push(`    decision: ${decision}`);
      }
    }
    parts.push("");
  }

  const graves = prior
    .filter((r) => r.status === "failed" || r.status === "blocked")
    .slice(-PACKET_GRAVE_LIMIT);
  if (graves.length > 0) {
    parts.push("## Attempts that died here (do not repeat these)", "");
    for (const grave of graves) {
      const how = grave.swept ? "abandoned" : grave.status;
      parts.push(`- [${grave.agent_id}] ${grave.goal}`);
      parts.push(`    ${how}: ${grave.cause ?? "(no cause recorded)"}`);
      if (grave.changed_paths?.length) {
        parts.push(`    touched: ${grave.changed_paths.slice(0, 4).join(", ")}`);
      }
    }
    parts.push("");
  }

  const threads = prior.flatMap((r) => r.open_threads ?? []).slice(-4);
  if (threads.length > 0) {
    parts.push("## Unresolved threads", "", ...threads.map((t) => `- ${t}`), "");
  }

  const last = prior[prior.length - 1];
  if (last) {
    parts.push(
      "## Immediately prior run",
      "",
      `[${last.agent_id}] ${last.goal}`,
      `status: ${last.status}${last.cause ? ` — ${last.cause}` : ""}`,
      last.changed_paths?.length ? `changed: ${last.changed_paths.slice(0, 6).join(", ")}` : "",
      "",
    );
  }

  return parts.filter((l) => l !== undefined).join("\n").trimEnd();
}

/**
 * Probes are only emitted where the corpus supplies ground truth. A handoff with
 * nothing verifiable produces no probe rather than a guessed one.
 */
function buildProbes(prior: RunRecord[], next: RunRecord, includeNextAction: boolean): ResumptionProbe[] {
  const probes: ResumptionProbe[] = [];

  // DISABLED — kept for the record, not emitted.
  //
  // The obvious probe is "what should you do next?", judged against what the
  // next agent actually did. A validity pass over 47 extracted instances killed
  // it: the ground truths are human product decisions ("redesign the landing
  // brand panel into a monochrome auto-advancing slider", "audit Settings
  // information architecture for quiet minimalism"). No agent can derive those
  // from a repo or a ledger, because they were not derived — they were chosen
  // by the operator and handed down. Both arms score near zero and the delta is
  // noise, which is worse than no probe: it looks like a measurement.
  //
  // A valid version needs handoffs where the next action was genuinely implied
  // by repo state — e.g. runs started from an existing task rather than a fresh
  // human instruction. That requires filtering on `related_runs`/task linkage,
  // which the corpus does not yet populate densely enough.
  if (includeNextAction) {
    probes.push({
      id: "next-action",
      question:
        "You are resuming work in this repository. State the single most important thing to do next, " +
        "in one or two sentences. Be specific about what you would change.",
      check: {
        kind: "llm",
        question:
          `Does the response propose work that is substantially the same as this actual next task: ` +
          `"${next.goal}"? Answer YES only if the core objective matches, ignoring wording.`,
        correct_answer: "YES",
      },
    });
  }

  // Ground truth: a recorded death. Only the ledger knows this.
  const grave = [...prior].reverse().find((r) => (r.status === "failed" || r.status === "blocked") && r.cause);
  if (grave) {
    probes.push({
      id: "dead-end",
      question:
        "Has any previous approach in this repository been tried and abandoned or failed? " +
        "If so, name it and say what went wrong. If you do not know, say you do not know.",
      check: {
        kind: "llm",
        question:
          `Does the response identify this specific failed attempt — "${grave.goal}" — and its cause: ` +
          `"${grave.cause}"? Answer YES only if both the attempt and the reason it failed are conveyed.`,
        correct_answer: "YES",
      },
    });
  }

  // Ground truth: a recorded decision that constrains later work.
  const decision = [...prior].reverse().flatMap((r) => r.decisions ?? [])[0];
  if (decision) {
    probes.push({
      id: "standing-decision",
      question:
        "Is there a decision made in earlier work here that constrains what you may do now? " +
        "State it, or say you do not know of one.",
      check: {
        kind: "llm",
        question:
          `Does the response convey this recorded decision: "${decision}"? ` +
          `Answer YES only if the substance of the decision is present, ignoring wording.`,
        correct_answer: "YES",
      },
    });
  }

  return probes;
}

function linkedRoots(): string[] {
  const roots = new Set<string>();
  const files = [join(homedir(), ".seedrop", "id", "passport.json")];
  const agentsDir = join(homedir(), ".seedrop", "id", "agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.endsWith(".json")) files.push(join(agentsDir, f));
    }
  }
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const passport = JSON.parse(readFileSync(file, "utf8")) as {
        active_projects?: Array<{ root?: string }>;
      };
      for (const project of passport.active_projects ?? []) {
        if (project.root && existsSync(project.root)) roots.add(project.root);
      }
    } catch {
      // Skip unreadable passports.
    }
  }
  return [...roots].sort();
}

export function extractRepo(root: string, includeNextAction = false): ResumptionTask[] {
  const seenGroundTruths = new Set<string>();
  if (git(root, ["rev-parse", "--git-dir"]) === null) return [];
  const runs = loadRuns(root);
  if (runs.length < 2) return [];
  const projectName = root.split("/").filter(Boolean).pop() ?? root;
  const tasks: ResumptionTask[] = [];

  for (let i = 1; i < runs.length; i += 1) {
    const previous = runs[i - 1]!;
    const next = runs[i]!;
    // A handoff is a baton pass: the next run is a different agent.
    if (previous.agent_id === next.agent_id) continue;
    // The repo must have existed at that point for a cold arm to read anything.
    const sha = commitAt(root, next.started_at);
    if (!sha) continue;

    const prior = runs.slice(0, i);
    const probes = buildProbes(prior, next, includeNextAction).filter((probe) => {
      // Fixtures are only independent observations if their ground truth differs.
      // Without this, 39 extracted decision probes collapsed to 6 distinct facts,
      // two of which covered 31 of them — an n of 6 dressed up as an n of 39.
      const truth = probe.check.kind === "llm" ? probe.check.question : probe.check.pattern;
      const key = `${probe.id}::${truth}`;
      if (seenGroundTruths.has(key)) return false;
      seenGroundTruths.add(key);
      return true;
    });
    if (probes.length === 0) continue;

    tasks.push({
      id: `${projectName}-${next.run_id.slice(0, 8)}`,
      scenario: `Real handoff: ${previous.agent_id} -> ${next.agent_id} in ${projectName} at ${next.started_at.slice(0, 10)}`,
      project_name: projectName,
      repo_evidence: buildRepoEvidence(root, sha, projectName),
      boot_packet: buildBootPacket(prior, next, projectName),
      probes,
    });
  }

  return tasks;
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const outDir = resolve(flag("out") ?? "id/benchmarks/resumption/tasks-v2");
  const roots = argv.includes("--corpus") ? linkedRoots() : [resolve(flag("root") ?? process.cwd())];

  mkdirSync(outDir, { recursive: true });
  let written = 0;
  let probes = 0;
  for (const root of roots) {
    const tasks = extractRepo(root, argv.includes("--include-next-action"));
    for (const task of tasks) {
      writeFileSync(join(outDir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`);
      written += 1;
      probes += task.probes.length;
    }
    if (tasks.length > 0) process.stderr.write(`${root}: ${tasks.length} handoff fixtures\n`);
  }
  process.stderr.write(`\nwrote ${written} fixtures / ${probes} probes to ${outDir}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("extract.ts")) main();
