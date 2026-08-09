#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertRepairJournal,
  buildCommandAuditTrail,
  buildRepairReceipt,
  canonicalJsonDigest,
  evaluateCommandInvariants,
  findCommandSweepCandidates,
} from "../dist/index.js";

const fixturePath = fileURLToPath(new URL("../fixtures/command-recovery-v1.json", import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

const commands = fixture.command_inputs.map(buildCommandAuditTrail);
const reports = evaluateCommandInvariants(commands, fixture.sweep_policy, fixture.observed_at);
const candidates = findCommandSweepCandidates(commands, fixture.sweep_policy, fixture.observed_at);
const receipts = [];
for (const raw of fixture.repair_inputs) {
  const input = structuredClone(raw);
  if (input.journal.previous_receipt_digest === "$previous_receipt_digest") {
    input.journal.previous_receipt_digest = canonicalJsonDigest(receipts.at(-1));
  }
  receipts.push(buildRepairReceipt(input));
}
assertRepairJournal(receipts);

const actual = {
  terminal_commands: reports.filter((report) => report.terminal).length,
  recoverable_commands: reports.filter((report) => report.recoverable).length,
  sweep_candidates: candidates.length,
  repair_receipts: receipts.length,
  command_audits_digest: canonicalJsonDigest(commands),
  invariant_reports_digest: canonicalJsonDigest(reports),
  sweep_candidates_digest: canonicalJsonDigest(candidates),
  repair_journal_digest: canonicalJsonDigest(receipts),
};

for (const [key, expected] of Object.entries(fixture.expected)) {
  if (expected !== "" && actual[key] !== expected) {
    throw new Error(`${key} mismatch: expected ${expected}, received ${actual[key]}`);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  node: process.version,
  fixture_version: fixture.fixture_version,
  ...actual,
})}\n`);
