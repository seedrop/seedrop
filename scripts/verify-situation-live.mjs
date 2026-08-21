import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  LIVE_SITUATION_BOOT_BUDGET_MS,
  compileLiveBoundedSituation,
  digestReadOnlyTree,
} from "@seedrop/migration";

const MCP_DEFAULT_SPAWN_MS = 15_000;
const repoRoot = resolve(process.cwd());
const viewRoot = resolve(repoRoot, ".seedrop", "view");
const operatorPassport = join(homedir(), ".seedrop", "id", "passport.json");
const envPassport = process.env.SEEDROP_PASSPORT?.trim();
const activePath = join(homedir(), ".seedrop", "state", "active-passport.json");
const active = existsSync(activePath) ? JSON.parse(readFileSync(activePath, "utf8")) : null;
const passportPath = envPassport
  || (active?.passport_path && existsSync(active.passport_path) ? active.passport_path : operatorPassport);
const passport = JSON.parse(readFileSync(passportPath, "utf8"));
const principalAlias = typeof passport.agent_id === "string" ? passport.agent_id : undefined;

const before = await digestReadOnlyTree(viewRoot);
const started = performance.now();
const result = await compileLiveBoundedSituation({
  repo_root: repoRoot,
  view_root: viewRoot,
  principal_alias: principalAlias,
  requested_bytes: 4096,
});
const compileMs = Math.round(performance.now() - started);

assert.equal(result.view_unchanged, true);
assert.ok(result.bytes <= 4096);
assert.ok(result.bounded.orientation.intent, "real corpus must expose current intent");
assert.ok(result.bounded.orientation.delivery, "real corpus must expose delivery state");
assert.ok("grave" in result.bounded.orientation, "real corpus must expose the Grave field");
assert.ok(result.bounded.orientation.source_health, "real corpus must expose source health");
assert.ok(result.bounded.orientation.next_action, "real corpus must expose a decision");
assert.ok(result.bounded.trust, "4 KiB output must retain field trust metadata");
assert.equal(result.bounded.budget.scanned_count, 0);
assert.equal(await digestReadOnlyTree(viewRoot), before, "live View changed during Situation projection");
assert.ok(
  compileMs <= LIVE_SITUATION_BOOT_BUDGET_MS,
  `live boot compile took ${compileMs}ms; budget is ${LIVE_SITUATION_BOOT_BUDGET_MS}ms (outcome-layer must not run on this path)`,
);

const cli = join(repoRoot, "cli", "dist", "cli.js");
assert.ok(existsSync(cli), "cli/dist/cli.js missing; build @seedrop/cli before this gate");
const bootStarted = performance.now();
const bootRaw = execFileSync(process.execPath, [cli, "boot", "--json", "--peek"], {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: MCP_DEFAULT_SPAWN_MS,
  env: process.env,
});
const bootMs = Math.round(performance.now() - bootStarted);
const boot = JSON.parse(bootRaw);
assert.equal(boot.selection?.mode, "v2", "CLI boot must serve live v2 by default without --situation-file");
assert.equal(boot.selection?.served?.kind, "v2_situation");
assert.equal(boot.selection?.served?.payload?.situation_id, result.bounded.situation_id);
assert.equal(boot.selection?.served?.payload?.decision_id, result.bounded.decision_id);
assert.ok(
  bootMs <= MCP_DEFAULT_SPAWN_MS,
  `CLI live boot took ${bootMs}ms; MCP default spawn window is ${MCP_DEFAULT_SPAWN_MS}ms`,
);

const v1Raw = execFileSync(process.execPath, [cli, "boot", "--v1", "--json", "--peek"], {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: MCP_DEFAULT_SPAWN_MS,
  env: process.env,
});
const v1 = JSON.parse(v1Raw);
assert.notEqual(v1.selection?.mode, "v2", "CLI --v1 must not serve the v2 Situation");
assert.ok(v1.identity && v1.next_action, "CLI --v1 must serve the classic v1 boot packet");

const { tools } = await import("@seedrop/mcp");
const bootTool = tools.find((item) => item.name === "seedrop_boot");
assert.ok(bootTool, "seedrop_boot tool missing from @seedrop/mcp");
const mcpStarted = performance.now();
const mcpResult = await bootTool.handler({
  json: true,
  peek: true,
  cwd: repoRoot,
});
const mcpMs = Math.round(performance.now() - mcpStarted);
assert.notEqual(mcpResult.isError, true, mcpResult.content[0]?.text ?? "MCP boot failed");
const mcpBinding = JSON.parse(mcpResult.content[0].text);
assert.equal(mcpBinding.selection?.mode, "v2", "MCP boot must serve live v2 without situation_file");
assert.equal(mcpBinding.selection?.served?.payload?.situation_id, result.bounded.situation_id);
assert.equal(mcpBinding.selection?.served?.payload?.decision_id, result.bounded.decision_id);
assert.ok(
  mcpMs <= MCP_DEFAULT_SPAWN_MS,
  `MCP live boot took ${mcpMs}ms; default spawn window is ${MCP_DEFAULT_SPAWN_MS}ms`,
);

console.log(JSON.stringify({
  ok: true,
  mode: "live-read-only-situation-shadow",
  aaa: true,
  compile_ms: compileMs,
  boot_ms: bootMs,
  mcp_ms: mcpMs,
  compile_budget_ms: LIVE_SITUATION_BOOT_BUDGET_MS,
  mcp_default_spawn_ms: MCP_DEFAULT_SPAWN_MS,
  bytes: result.bytes,
  budget: result.bounded.budget,
  situation_id: result.bounded.situation_id,
  decision_id: result.bounded.decision_id,
  intent: result.bounded.orientation.intent,
  risk: result.bounded.orientation.risk,
  delivery: result.bounded.orientation.delivery,
  grave: result.bounded.orientation.grave,
  source_health: result.bounded.orientation.source_health,
  next_action: result.bounded.orientation.next_action,
  source_tree_unchanged: true,
  cli_mcp_object: "identical_ids",
}));
