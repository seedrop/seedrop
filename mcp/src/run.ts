import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  truncated?: boolean;
}

/**
 * Resolve the bundled `seed` CLI script path. Prefers @seedrop/cli installed
 * as a dependency of this package, falls back to PATH lookup if resolution
 * fails (e.g. during dev when symlinks haven't been wired).
 */
export function resolveSeedCli(): { kind: "node"; script: string } | { kind: "path"; cmd: string } {
  try {
    const entryUrl = import.meta.resolve("@seedrop/cli");
    const entryPath = fileURLToPath(entryUrl);
    return { kind: "node", script: join(dirname(entryPath), "cli.js") };
  } catch {
    return { kind: "path", cmd: "seed" };
  }
}

export function runSeed(
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const resolved = resolveSeedCli();
    const cmd = resolved.kind === "node" ? process.execPath : resolved.cmd;
    const cmdArgs = resolved.kind === "node" ? [resolved.script, ...args] : [...args];
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const maxOutputBytes = opts.maxOutputBytes ?? 1_000_000;
    let settled = false;
    let timedOut = false;
    let truncated = false;
    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const next = chunk.toString();
      if (target === "stdout") stdout += next;
      else stderr += next;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) {
        truncated = true;
        stdout = stdout.slice(0, maxOutputBytes);
        stderr = stderr.slice(0, maxOutputBytes);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("close", (code) => finish({ stdout, stderr, exitCode: timedOut ? 124 : code ?? 1, timedOut, truncated }));
    child.on("error", (error) => finish({ stdout, stderr: stderr + String(error), exitCode: 1, timedOut, truncated }));
  });
}
