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
} from "./boot.js";
export type { CommandDispatch, CommandRunner, RunCliIO } from "./router.js";
