import assert from "node:assert/strict";
import { resolve } from "node:path";
import { compileLiveBoundedSituation, digestReadOnlyTree } from "@seedrop/migration";

const repoRoot = resolve(process.cwd());
const viewRoot = resolve(repoRoot, ".seedrop", "view");
const before = await digestReadOnlyTree(viewRoot);
const result = await compileLiveBoundedSituation({
  repo_root: repoRoot,
  view_root: viewRoot,
  requested_bytes: 4096,
});
assert.equal(result.view_unchanged, true);
assert.ok(result.bytes <= 4096);
assert.ok(result.bounded.orientation.intent, "real corpus must expose current intent");
assert.ok(result.bounded.orientation.delivery, "real corpus must expose delivery state");
assert.ok(result.bounded.orientation.grave, "real corpus must expose a relevant Grave");
assert.ok(result.bounded.orientation.source_health, "real corpus must expose source health");
assert.ok(result.bounded.orientation.next_action, "real corpus must expose a decision");
assert.ok(result.bounded.trust, "4 KiB output must retain field trust metadata");
assert.equal(result.bounded.budget.scanned_count, 0);
assert.equal(await digestReadOnlyTree(viewRoot), before, "live View changed during Situation projection");
console.log(JSON.stringify({
  ok: true,
  mode: "live-read-only-situation-shadow",
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
}));
