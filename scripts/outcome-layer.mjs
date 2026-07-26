#!/usr/bin/env node
/**
 * Outcome layer — label past runs with what actually became of their work.
 *
 * A run journal records intent: goal, decisions, changed_paths. It does not
 * record whether any of that survived contact with the repo. Git knows, but
 * nobody asks it. This walks git history and answers, per run:
 *
 *   survived      some lines the run authored are still live at HEAD
 *   superseded    the paths still exist, but nothing the run wrote remains
 *   absent        the paths are gone from HEAD entirely
 *   uncommitted   nothing landed in the window — the work never reached git
 *
 * The measurement is line survival via `git blame` author-time. For each path a
 * run touched, count lines at HEAD whose author-time falls inside the run's
 * window, and compare against the file's current size. That is a direct answer
 * to "how much of what this run did is still standing", rather than a proxy
 * like commit counts.
 *
 * Why this matters: it labels the corpus retroactively and for free. Every
 * month of ordinary work adds ground truth to runs recorded months earlier, so
 * old traces get more informative without anyone maintaining them. That is what
 * makes a pile of agent transcripts into a dataset you can learn from.
 *
 * Usage:
 *   node scripts/outcome-layer.mjs --root <repo>          one repo
 *   node scripts/outcome-layer.mjs --corpus               every linked repo
 *   node scripts/outcome-layer.mjs --corpus --json out.json
 *
 * Read-only. Never writes to any View.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Work is frequently committed after the run is marked finished. */
const DEFAULT_GRACE_DAYS = 7;

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function isGitRepo(root) {
  return git(root, ["rev-parse", "--git-dir"]) !== null;
}

/**
 * Author-time (epoch seconds) for every line of `path` at HEAD.
 * Returns null when the path is absent, binary, or unreadable.
 */
function blameLineTimes(root, path) {
  const out = git(root, ["blame", "--line-porcelain", "HEAD", "--", path]);
  if (out === null) return null;
  const times = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("author-time ")) times.push(Number(line.slice(12).trim()));
  }
  return times;
}

function pathExistsAtHead(root, path) {
  return git(root, ["cat-file", "-e", `HEAD:${path}`]) !== null;
}

function classifyRun(root, run, blameCache, graceDays, lastCommitTime) {
  const changed = (run.changed_paths ?? []).filter(Boolean);
  if (changed.length === 0) return null;

  const start = Date.parse(run.started_at ?? "");
  const end = Date.parse(run.finished_at ?? run.updated_at ?? run.started_at ?? "");
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const windowStart = Math.floor(start / 1000);
  const windowEnd = Math.floor(end / 1000) + graceDays * 86400;

  const paths = [];
  let attributed = 0;
  let totalLines = 0;
  let present = 0;

  for (const path of changed) {
    if (!pathExistsAtHead(root, path)) {
      paths.push({ path, status: "absent", attributed_lines: 0, total_lines: 0 });
      continue;
    }
    present += 1;
    if (!blameCache.has(path)) blameCache.set(path, blameLineTimes(root, path));
    const times = blameCache.get(path);
    if (times === null) {
      paths.push({ path, status: "unreadable", attributed_lines: 0, total_lines: 0 });
      continue;
    }
    const inWindow = times.filter((t) => t >= windowStart && t <= windowEnd).length;
    attributed += inWindow;
    totalLines += times.length;
    paths.push({
      path,
      status: inWindow > 0 ? "survived" : "superseded",
      attributed_lines: inWindow,
      total_lines: times.length,
    });
  }

  // A run's work can only be *superseded* if the repo actually moved after it.
  // When the newest commit predates the run, nothing the run did ever reached
  // git — that is a gap in the record, not an outcome, and conflating the two
  // silently inflates the "work was later replaced" rate. Whole repos in this
  // corpus (loci, outer) sit entirely after their final commit.
  const repoMovedAfter = lastCommitTime !== null && lastCommitTime >= windowStart;

  let outcome;
  if (attributed > 0) outcome = "survived";
  else if (!repoMovedAfter) outcome = "uncommitted";
  else if (present === 0) outcome = "absent";
  else outcome = "superseded";

  return {
    run_id: run.run_id,
    agent_id: run.agent_id,
    goal: run.goal,
    status: run.status,
    cause: run.cause ?? null,
    started_at: run.started_at,
    finished_at: run.finished_at ?? null,
    outcome,
    /** Share of current lines in the touched files attributable to this run. */
    survival_ratio: totalLines > 0 ? Number((attributed / totalLines).toFixed(4)) : 0,
    attributed_lines: attributed,
    total_lines: totalLines,
    paths,
  };
}

function loadRuns(root) {
  const dir = join(root, ".seedrop", "view", "runs");
  if (!existsSync(dir)) return [];
  const runs = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      runs.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
    } catch {
      // A malformed run file is not worth failing the whole corpus pass over.
    }
  }
  return runs.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
}

function linkedRoots() {
  const roots = new Set();
  const files = [join(homedir(), ".seedrop", "id", "passport.json")];
  const agentsDir = join(homedir(), ".seedrop", "id", "agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.endsWith(".json") && !f.endsWith(".audit.jsonl")) files.push(join(agentsDir, f));
    }
  }
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const passport = JSON.parse(readFileSync(file, "utf8"));
      for (const project of passport.active_projects ?? []) {
        if (project.root && existsSync(project.root)) roots.add(project.root);
      }
    } catch {
      // Skip unreadable passports rather than aborting the sweep.
    }
  }
  return [...roots].sort();
}

function analyzeRepo(root, graceDays) {
  if (!isGitRepo(root)) return null;
  const runs = loadRuns(root);
  if (runs.length === 0) return null;
  const blameCache = new Map();
  // Newest commit in the repo, as epoch seconds. Distinguishes "the repo moved
  // on without this work" from "this work never reached the repo".
  const lastCommitRaw = git(root, ["log", "-1", "--format=%ct"]);
  const lastCommitTime = lastCommitRaw ? Number(lastCommitRaw.trim()) : null;
  const labeled = [];
  for (const run of runs) {
    const result = classifyRun(root, run, blameCache, graceDays, lastCommitTime);
    if (result) labeled.push(result);
  }
  return { root, runs_total: runs.length, runs_labeled: labeled.length, runs: labeled };
}

function summarize(repos) {
  const outcomes = {};
  const byStatus = {};
  let labeled = 0;
  let total = 0;
  for (const repo of repos) {
    total += repo.runs_total;
    for (const run of repo.runs) {
      labeled += 1;
      outcomes[run.outcome] = (outcomes[run.outcome] ?? 0) + 1;
      const key = `${run.status}/${run.outcome}`;
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }
  }
  return { repos: repos.length, runs_total: total, runs_labeled: labeled, outcomes, by_status_outcome: byStatus };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? true) : undefined;
  };
  const graceDays = Number(flag("grace-days") ?? DEFAULT_GRACE_DAYS);
  const roots = argv.includes("--corpus") ? linkedRoots() : [String(flag("root") ?? process.cwd())];

  const repos = [];
  for (const root of roots) {
    process.stderr.write(`scanning ${root}\n`);
    const report = analyzeRepo(root, graceDays);
    if (report) repos.push(report);
  }

  const summary = summarize(repos);
  const payload = { generated_at: new Date().toISOString(), grace_days: graceDays, summary, repos };

  const jsonPath = flag("json");
  if (typeof jsonPath === "string") {
    writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write(`wrote ${jsonPath}\n`);
  }

  console.log(`\nrepos ${summary.repos} · runs ${summary.runs_total} · labeled ${summary.runs_labeled}\n`);
  console.log("outcome distribution:");
  for (const [k, v] of Object.entries(summary.outcomes).sort((a, b) => b[1] - a[1])) {
    const pct = ((v / summary.runs_labeled) * 100).toFixed(1);
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(4)}  ${pct}%`);
  }
  console.log("\nreported status -> actual outcome:");
  for (const [k, v] of Object.entries(summary.by_status_outcome).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${String(v).padStart(4)}`);
  }
}

main();
