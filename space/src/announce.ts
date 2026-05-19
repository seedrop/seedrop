/**
 * Identity announce helpers — pure, side-effect-free, importable from tests
 * without executing the CLI entry point.
 */

/**
 * Commands that mutate persisted state (write a JSON file, change a status,
 * post a message). For these we surface the identity so the user sees who
 * the action is attributed to before reading the result.
 */
export function isMutatingCommand(
  namespace: string | undefined,
  command: string | undefined,
): boolean {
  if (!command) return false;
  if (namespace === "run") {
    return ["start", "log", "decision", "thread", "verify", "finish"].includes(command);
  }
  if (namespace === "task") {
    return ["create", "claim", "assign", "accept", "decline", "start", "pause", "done", "drop"].includes(command);
  }
  if (namespace === "handoff") {
    return ["create", "accept"].includes(command);
  }
  return ["log", "sync", "init", "claim", "release"].includes(command);
}

/**
 * Pure decision for the `[acting as <agent>]` banner.
 *
 * Humans watching an interactive shell want the banner; pipelines do not —
 * e.g. `seed run finish ... 2>&1 | jq` merges stderr into stdout and the
 * banner corrupts a downstream JSON consumer. Gate on `stderrIsTTY`: humans
 * get the line, pipes don't. Explicit `--quiet` and `SEEDROP_QUIET=1` also
 * suppress (for script authors who keep a real terminal attached but still
 * want silence).
 */
export function shouldAnnounceIdentity(opts: {
  isMutating: boolean;
  quietFlag: boolean;
  quietEnv: string | undefined;
  stderrIsTTY: boolean | undefined;
}): boolean {
  if (!opts.isMutating) return false;
  if (opts.quietFlag) return false;
  if (opts.quietEnv && opts.quietEnv !== "0" && opts.quietEnv !== "") return false;
  return opts.stderrIsTTY === true;
}
