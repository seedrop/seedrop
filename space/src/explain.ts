import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceView } from "./view.js";
import type { ViewPolicy, WorkspaceManifest } from "./schema.js";

export interface ExplainPathReport {
  topic: "path";
  path: string;
  in_manifest: boolean;
  manifest_purpose?: string;
  manifest_owner?: string;
  manifest_confidence?: number;
  on_disk: boolean;
  policy_purpose?: string;
  policy_recommended_read_reason?: string;
  policy_recommended_read_priority?: number;
  in_recommended_reads: boolean;
  in_important_paths: boolean;
  ignored: boolean;
  notes: string[];
}

export interface ExplainSuccessCriterion {
  id: string;
  label: string;
  met: boolean;
  detail: string;
}

export interface ExplainSuccessReport {
  topic: "success";
  level: "L0" | "L1" | "L2" | "L3" | "L4";
  label: string;
  summary: string;
  required_level?: "L0" | "L1" | "L2" | "L3" | "L4";
  meets_required: boolean;
  criteria: ExplainSuccessCriterion[];
}

export async function explainPath(view: WorkspaceView, target: string): Promise<ExplainPathReport> {
  const normalized = path.posix.normalize(target.replace(/\\/g, "/"));
  const absolutePath = path.resolve(view.root, normalized);
  const notes: string[] = [];

  const onDisk = existsSync(absolutePath);
  if (!onDisk) {
    notes.push(`Path does not exist on disk at ${absolutePath}`);
  } else {
    try {
      const s = await stat(absolutePath);
      if (s.isDirectory()) notes.push(`Path is a directory; the manifest tracks files only.`);
    } catch {
      // ignore
    }
  }

  const manifest = await readManifestIfPresent(view);
  const policy = await readPolicyIfPresent(view);

  const manifestFile = manifest?.files.find((f) => f.path === normalized);
  const in_manifest = Boolean(manifestFile);

  if (!in_manifest && onDisk && manifest) {
    notes.push("File exists on disk but is not in the manifest. Run `seed view sync`.");
  }
  if (!manifest) {
    notes.push("No manifest present. Run `seed view init` and `seed view sync`.");
  }

  const policyEntry = policy?.path_purposes?.[normalized];
  const policyDirEntry = policy?.path_purposes?.[`${normalized}/`] ?? findContainingPolicyDir(policy, normalized);

  const in_recommended_reads = manifest?.recommended_reads.some((r) => r.path === normalized) ?? false;
  const in_important_paths = Boolean(manifestFile && in_recommended_reads);

  const explicitPurpose = policyEntry?.purpose ?? policyDirEntry?.purpose;
  const recommendedReason = policyEntry?.recommended_read_reason;
  const recommendedPriority = policyEntry?.recommended_read_priority;

  if (policy && !policyEntry && !policyDirEntry) {
    notes.push("Policy has no path_purposes entry for this file. Add one in `.seedrop/view/policy.json` to lift it into the boot block.");
  }
  if (recommendedReason && !in_recommended_reads && in_manifest) {
    notes.push("Policy declares recommended_read_reason but the manifest hasn't been refreshed. Run `seed view sync`.");
  }
  if (recommendedReason && !in_manifest) {
    notes.push("Policy declares recommended_read_reason but the file is missing from the manifest (either not on disk, or ignored by `policy.ignore`).");
  }

  const ignored = Boolean(policy?.ignore?.includes(normalized));
  if (ignored) {
    notes.push("Path is in `policy.ignore` so the manifest will not track it.");
  }

  return {
    topic: "path",
    path: normalized,
    in_manifest,
    ...(manifestFile?.purpose ? { manifest_purpose: manifestFile.purpose } : {}),
    ...(manifestFile?.owner ? { manifest_owner: manifestFile.owner } : {}),
    ...(manifestFile?.confidence !== undefined ? { manifest_confidence: manifestFile.confidence } : {}),
    on_disk: onDisk,
    ...(explicitPurpose ? { policy_purpose: explicitPurpose } : {}),
    ...(recommendedReason ? { policy_recommended_read_reason: recommendedReason } : {}),
    ...(recommendedPriority !== undefined ? { policy_recommended_read_priority: recommendedPriority } : {}),
    in_recommended_reads,
    in_important_paths,
    ignored,
    notes,
  };
}

export async function explainSuccess(view: WorkspaceView): Promise<ExplainSuccessReport> {
  const brief = await view.brief();
  const success = brief.success;
  const policy = await readPolicyIfPresent(view);
  const manifest = await readManifestIfPresent(view);
  const freshness = brief.manifest?.freshness;
  const verificationCommands = brief.verification_commands;

  const criteria: ExplainSuccessCriterion[] = [];

  criteria.push({
    id: "view_present",
    label: "View directory exists",
    met: brief.view.present,
    detail: brief.view.present ? `Present at ${brief.view.data_dir}` : "Missing — run `seed view init`",
  });

  criteria.push({
    id: "manifest_present",
    label: "Manifest exists and is parseable",
    met: Boolean(manifest),
    detail: manifest ? `${manifest.files.length} file(s) tracked` : "Missing or invalid — run `seed view sync`",
  });

  criteria.push({
    id: "manifest_fresh",
    label: "Manifest is fresh (matches disk)",
    met: freshness === "fresh",
    detail: freshness ? `freshness=${freshness}` : "unknown",
  });

  criteria.push({
    id: "policy_purpose",
    label: "Policy declares a purpose",
    met: Boolean(policy?.purpose),
    detail: policy?.purpose ? "set" : "missing — add `purpose` to `.seedrop/view/policy.json`",
  });

  criteria.push({
    id: "verification_commands",
    label: "Verification commands are discoverable",
    met: verificationCommands.length > 0,
    detail: verificationCommands.length > 0
      ? `${verificationCommands.length} command(s)`
      : "none — declare `preferred_verification_commands` in policy or add tests/scripts",
  });

  const gitStatus = brief.git_status;
  criteria.push({
    id: "git_clean",
    label: "Git tree is clean (or not a git repo)",
    met: !gitStatus?.is_dirty,
    detail: gitStatus?.is_dirty
      ? `${gitStatus.uncommitted_count} uncommitted file(s)`
      : gitStatus?.is_repo ? "clean" : "not a git repo",
  });

  return {
    topic: "success",
    level: success.level,
    label: success.label,
    summary: success.summary,
    ...(success.required_level ? { required_level: success.required_level } : {}),
    meets_required: success.meets_required,
    criteria,
  };
}

function findContainingPolicyDir(policy: ViewPolicy | undefined, target: string): { purpose: string; owner?: string; confidence?: number; recommended_read_reason?: string; recommended_read_priority?: number } | undefined {
  if (!policy?.path_purposes) return undefined;
  const parts = target.split("/");
  while (parts.length > 1) {
    parts.pop();
    const dirKey = parts.join("/") + "/";
    const entry = policy.path_purposes[dirKey];
    if (entry) return entry;
  }
  return undefined;
}

async function readManifestIfPresent(view: WorkspaceView): Promise<WorkspaceManifest | undefined> {
  try {
    return await view.readManifest();
  } catch {
    return undefined;
  }
}

async function readPolicyIfPresent(view: WorkspaceView): Promise<ViewPolicy | undefined> {
  // readPolicyResult is private; brief()'s next_actions surface invalidness.
  // For now, read the file directly using the well-known path.
  const policyPath = path.join(view.dataDir, "policy.json");
  if (!existsSync(policyPath)) return undefined;
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(policyPath, "utf8");
    const { ViewPolicySchema } = await import("./schema.js");
    const parsed = JSON.parse(raw);
    const result = ViewPolicySchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function renderExplainPath(report: ExplainPathReport): string {
  const lines: string[] = [];
  lines.push(`path: ${report.path}`);
  lines.push(`  on disk: ${report.on_disk ? "yes" : "no"}`);
  lines.push(`  in manifest: ${report.in_manifest ? "yes" : "no"}`);
  if (report.manifest_purpose) lines.push(`    manifest.purpose: ${report.manifest_purpose}`);
  if (report.manifest_owner) lines.push(`    manifest.owner: ${report.manifest_owner}`);
  if (report.manifest_confidence !== undefined) lines.push(`    manifest.confidence: ${report.manifest_confidence}`);
  if (report.policy_purpose) lines.push(`  policy.purpose: ${report.policy_purpose}`);
  if (report.policy_recommended_read_reason) {
    lines.push(`  policy.recommended_read_reason: ${report.policy_recommended_read_reason}`);
  }
  if (report.policy_recommended_read_priority !== undefined) {
    lines.push(`  policy.recommended_read_priority: ${report.policy_recommended_read_priority}`);
  }
  lines.push(`  in recommended_reads: ${report.in_recommended_reads ? "yes" : "no"}`);
  lines.push(`  in important_paths: ${report.in_important_paths ? "yes" : "no"}`);
  lines.push(`  ignored by policy: ${report.ignored ? "yes" : "no"}`);
  if (report.notes.length > 0) {
    lines.push(`  notes:`);
    for (const note of report.notes) lines.push(`    - ${note}`);
  }
  return lines.join("\n");
}

export function renderExplainSuccess(report: ExplainSuccessReport): string {
  const lines: string[] = [];
  lines.push(`success: ${report.level} ${report.label}${report.required_level ? ` (requires ${report.required_level})` : ""}`);
  lines.push(`  ${report.summary}`);
  lines.push(`  meets_required: ${report.meets_required ? "yes" : "no"}`);
  lines.push(`  criteria:`);
  for (const c of report.criteria) {
    const mark = c.met ? "✓" : "✗";
    lines.push(`    ${mark} ${c.label} — ${c.detail}`);
  }
  return lines.join("\n");
}
