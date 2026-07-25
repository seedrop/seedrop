export { resolveCommand, runCli, defaultPassportPath, defaultSpaceRoot } from "./router.js";
export {
  buildBootReport,
  buildBootReportFromContinuity,
  renderBoot,
  resolveBootNextAction,
  scoreBootOutcome,
  type BootOutcomeObservation,
  type BootOutcomeScore,
  type BootReport,
  type BootNextAction,
  type Situation,
  type SituationConfidence,
  type SituationEvidence,
  type SituationNextMove,
} from "./boot.js";
export type { CommandDispatch, CommandRunner, RunCliIO } from "./router.js";
export {
  CLI_COMMAND_SURFACE,
  DEPRECATED_CAPABILITY_ALIASES,
  MCP_CLI_COVERAGE,
  MCP_ONLY_COMMANDS,
  buildCapabilities,
  renderCapabilities,
  type CapabilityCatalog,
  type CapabilityEntry,
  type CliCommandCoverage,
  type CliCoverageStatus,
  type DeprecatedCapabilityAlias,
} from "./capabilities.js";
