#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertBoundedOutput,
  assertFieldExplanation,
  assertOperationalMetricsSnapshot,
  assertTelemetryConsentReceipt,
  authorizeTelemetryExport,
  buildFieldExplanation,
  buildOperationalMetricsSnapshot,
  buildTelemetryConsentReceipt,
  canonicalJsonDigest,
  compileBoundedOutput,
  telemetryExportState,
} from "../dist/index.js";

const fixturePath = fileURLToPath(new URL("../fixtures/observability-v1.json", import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

const metrics = buildOperationalMetricsSnapshot(fixture.metrics_input);
assertOperationalMetricsSnapshot(metrics);
const explanations = fixture.explanation_inputs.map(buildFieldExplanation);
explanations.forEach(assertFieldExplanation);
const bounded = compileBoundedOutput(fixture.budget_input);
assertBoundedOutput(bounded);
const consent = buildTelemetryConsentReceipt(fixture.consent_input);
assertTelemetryConsentReceipt(consent);
const authorization = authorizeTelemetryExport(consent, fixture.export_request);

const localOnlyWithoutConsent = telemetryExportState(null, fixture.export_request.requested_at).mode === "local_only";
const noConsentDenied = throwsCode(
  () => authorizeTelemetryExport(null, fixture.export_request),
  "seedrop.protocol.telemetry_export_denied",
);
const secretPayloadDenied = throwsCode(
  () => authorizeTelemetryExport(consent, {
    ...structuredClone(fixture.export_request),
    payload: {
      ...structuredClone(fixture.export_request.payload),
      command_recovery: {
        ...structuredClone(fixture.export_request.payload.command_recovery),
        access_token: "redacted",
      },
    },
  }),
  "seedrop.protocol.telemetry_secret_detected",
);
const insufficientBudgetDenied = throwsCode(
  () => compileBoundedOutput({ ...structuredClone(fixture.budget_input), requested_bytes: 1 }),
  "seedrop.protocol.budget_insufficient",
);

const actual = {
  metrics_digest: canonicalJsonDigest(metrics),
  explanations_digest: canonicalJsonDigest(explanations),
  bounded_output_digest: canonicalJsonDigest(bounded),
  bounded_actual_bytes: bounded.actual_bytes,
  authorization_digest: canonicalJsonDigest(authorization),
  metric_alert_count: metrics.alerts.length,
  resolved_explanation_count: explanations.filter((trace) => trace.status === "resolved").length,
  unknown_explanation_count: explanations.filter((trace) => trace.status === "unknown").length,
  local_only_without_consent: localOnlyWithoutConsent,
  no_consent_denied: noConsentDenied,
  secret_payload_denied: secretPayloadDenied,
  insufficient_budget_denied: insufficientBudgetDenied,
};

for (const [key, expected] of Object.entries(fixture.expected)) {
  if (expected !== "" && expected !== 0) assert.deepEqual(actual[key], expected, key);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  node: process.version,
  fixture_version: fixture.fixture_version,
  ...actual,
})}\n`);

function throwsCode(action, code) {
  try {
    action();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}
