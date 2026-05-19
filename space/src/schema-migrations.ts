import type { MigrationChain } from "./migrations.js";

/**
 * Per-schema migration chains. Today every chain is empty (current = "1.0")
 * — the infrastructure ships now so the FIRST schema bump (v1.0 → v1.1) can
 * land just by adding an entry here, without further changes to view.ts or
 * any read sites. See .seedrop/view/knowledge/schema-migrations-2026-05-19.md.
 */

export const TaskMigrationChain: MigrationChain = {
  schemaName: "Task",
  current: "1.0",
  migrations: [],
};

export const RunJournalMigrationChain: MigrationChain = {
  schemaName: "RunJournal",
  current: "1.0",
  migrations: [],
};

export const ContinuityPacketMigrationChain: MigrationChain = {
  schemaName: "ContinuityPacket",
  current: "1.0",
  migrations: [],
};
