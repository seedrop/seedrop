/**
 * The CLI/MCP coverage map lives in @seedrop/cli (cli/src/capabilities.ts) so
 * it can power `seed capabilities` while staying the single source of truth.
 * Re-exported here unchanged so the MCP coverage tests keep enforcing that the
 * map is complete and every exposed MCP tool maps back to a CLI command.
 */
export {
  CLI_COMMAND_SURFACE,
  MCP_CLI_COVERAGE,
  MCP_ONLY_COMMANDS,
  type CliCommandCoverage,
  type CliCoverageStatus,
} from "@seedrop/cli";
