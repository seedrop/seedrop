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
