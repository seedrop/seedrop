import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import type { RunCliIO } from "./router.js";

const TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".toml", ".md", ".txt", ".yaml", ".yml", ".log"]);

interface MigrateOptions {
  removeAcorn: boolean;
  json: boolean;
}

interface MigrationReport {
  source_root: string;
  target_root: string;
  source_existed: boolean;
  target_existed_before: boolean;
  files_copied: number;
  files_skipped_already_present: number;
  files_rewritten_paths: number;
  directories_renamed: number;
  cwd_view_migrated: boolean;
  cwd_view_path: string | null;
  source_removed: boolean;
  next_steps: string[];
  notes: string[];
}

export async function runMigrateAcorn(argv: readonly string[], io: RunCliIO): Promise<number> {
  const opts = parseArgs(argv);
  const sourceRoot = join(homedir(), ".acorn");
  const targetRoot = join(homedir(), ".seedrop");

  const report: MigrationReport = {
    source_root: sourceRoot,
    target_root: targetRoot,
    source_existed: existsSync(sourceRoot),
    target_existed_before: existsSync(targetRoot),
    files_copied: 0,
    files_skipped_already_present: 0,
    files_rewritten_paths: 0,
    directories_renamed: 0,
    cwd_view_migrated: false,
    cwd_view_path: null,
    source_removed: false,
    next_steps: [],
    notes: [],
  };

  if (!report.source_existed) {
    report.notes.push("No ~/.acorn/ directory found. Nothing to migrate.");
    if (!report.target_existed_before) {
      report.next_steps.push("Run `seed bootstrap --name <agent> --purpose \"<mission>\"` to set up fresh.");
    }
    writeReport(io, opts, report);
    return report.target_existed_before ? 0 : 1;
  }

  copyTree(sourceRoot, targetRoot, report);

  const cwdAcorn = join(process.cwd(), ".acorn");
  if (existsSync(cwdAcorn) && process.cwd() !== homedir()) {
    const cwdSeedrop = join(process.cwd(), ".seedrop");
    copyTree(cwdAcorn, cwdSeedrop, report);
    report.cwd_view_migrated = true;
    report.cwd_view_path = cwdSeedrop;
  }

  if (opts.removeAcorn) {
    rmSync(sourceRoot, { recursive: true, force: true });
    if (report.cwd_view_migrated) {
      rmSync(cwdAcorn, { recursive: true, force: true });
    }
    report.source_removed = true;
    report.notes.push("Old ~/.acorn/ removed (--remove-acorn flag).");
  } else {
    report.notes.push("Old ~/.acorn/ left in place. Pass --remove-acorn to delete it after verification.");
  }

  report.next_steps.push("Stop the old acorn daemon if it is still running: `launchctl bootout gui/$(id -u)/com.acornkit.space 2>/dev/null || true`");
  report.next_steps.push("Install the new seed daemon: `seed daemon install`");
  report.next_steps.push("Swap MCP config: `seed install claude-code` and `seed install codex-cli`");
  report.next_steps.push("Restart your agent client (Claude Code, Codex CLI) so the new MCP server is picked up.");

  writeReport(io, opts, report);
  return 0;
}

function copyTree(source: string, targetParent: string, report: MigrationReport): void {
  if (!existsSync(targetParent)) {
    mkdirSync(targetParent, { recursive: true });
  }
  const entries = readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const renamedName = entry.name === ".acorn" ? ".seedrop" : entry.name;
    if (renamedName !== entry.name) {
      report.directories_renamed++;
    }
    const targetPath = join(targetParent, renamedName);
    if (entry.isDirectory()) {
      copyTree(sourcePath, targetPath, report);
    } else if (entry.isFile()) {
      if (existsSync(targetPath)) {
        report.files_skipped_already_present++;
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (TEXT_EXTENSIONS.has(ext)) {
        const content = readFileSync(sourcePath, "utf8");
        const rewritten = rewriteAcornPaths(content);
        if (rewritten !== content) {
          report.files_rewritten_paths++;
        }
        writeFileSync(targetPath, rewritten, "utf8");
      } else {
        copyFileSync(sourcePath, targetPath);
      }
      report.files_copied++;
    }
  }
}

function rewriteAcornPaths(content: string): string {
  return content
    .replace(/\/\.acorn\//g, "/.seedrop/")
    .replace(/\/\.acorn"/g, "/.seedrop\"")
    .replace(/\/\.acorn$/gm, "/.seedrop");
}

function parseArgs(argv: readonly string[]): MigrateOptions {
  let removeAcorn = false;
  let json = false;
  for (const arg of argv) {
    if (arg === "--remove-acorn") removeAcorn = true;
    else if (arg === "--json") json = true;
  }
  return { removeAcorn, json };
}

function writeReport(io: RunCliIO, opts: MigrateOptions, report: MigrationReport): void {
  if (opts.json) {
    io.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  const lines: string[] = [];
  lines.push(`migrate-acorn: ${report.source_existed ? "source found" : "source NOT found"}`);
  lines.push(`  source: ${report.source_root}`);
  lines.push(`  target: ${report.target_root}${report.target_existed_before ? " (existed before)" : " (created)"}`);
  lines.push(`  files copied:           ${report.files_copied}`);
  lines.push(`  files skipped (exists): ${report.files_skipped_already_present}`);
  lines.push(`  text files rewritten:   ${report.files_rewritten_paths}`);
  lines.push(`  directories renamed:    ${report.directories_renamed}`);
  if (report.cwd_view_migrated) {
    lines.push(`  cwd view migrated:      ${report.cwd_view_path}`);
  }
  if (report.source_removed) {
    lines.push(`  source removed: yes`);
  }
  if (report.notes.length > 0) {
    lines.push("");
    for (const note of report.notes) lines.push(`note: ${note}`);
  }
  if (report.next_steps.length > 0) {
    lines.push("");
    lines.push("next steps:");
    for (const step of report.next_steps) lines.push(`  - ${step}`);
  }
  io.stdout.write(lines.join("\n") + "\n");
}

export function failClosedIfUnmigrated(io: RunCliIO): boolean {
  const sourceRoot = join(homedir(), ".acorn");
  const targetRoot = join(homedir(), ".seedrop");
  if (existsSync(sourceRoot) && !existsSync(targetRoot)) {
    io.stderr.write(
      [
        "seed: refusing to operate — found legacy ~/.acorn/ state from acornkit but no ~/.seedrop/.",
        "",
        "Run `seed migrate-acorn` first to copy your passports, spaces, and inbox state to the new location.",
        "Add `--remove-acorn` if you want the migration to delete ~/.acorn/ after a successful copy.",
        "",
      ].join("\n"),
    );
    return true;
  }
  return false;
}
