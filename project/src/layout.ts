import { resolve, join } from "node:path";
import type { ProjectTransactionDigest } from "@seedrop/protocol";
import { PROJECT_STORE_LAYOUT_VERSION } from "./types.js";
import type { ProjectStoreLayout } from "./types.js";

const DIGEST = /^sha256:([0-9a-f]{64})$/;

export function projectStoreLayout(root: string): ProjectStoreLayout {
  if (typeof root !== "string" || root.trim().length === 0) throw new TypeError("project store root is required");
  const resolvedRoot = resolve(root);
  return Object.freeze({
    layout_version: PROJECT_STORE_LAYOUT_VERSION,
    root: resolvedRoot,
    transactions_dir: join(resolvedRoot, "transactions"),
    staging_dir: join(resolvedRoot, "staging"),
    index_dir: join(resolvedRoot, "index"),
    projection_index: join(resolvedRoot, "index", "project-projection.json"),
    locks_dir: join(resolvedRoot, "locks"),
    writer_lock: join(resolvedRoot, "locks", "project-writer.lock"),
  });
}

export function projectTransactionRelativePath(digest: ProjectTransactionDigest): string {
  const match = DIGEST.exec(digest);
  if (!match) throw new TypeError(`invalid project transaction digest: ${digest}`);
  const hex = match[1]!;
  return `transactions/${hex.slice(0, 2)}/${hex}.json`;
}
