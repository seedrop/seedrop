#!/usr/bin/env node
import { runCli } from "./router.js";
import { failClosedIfUnmigrated } from "./migrate-acorn.js";

const argv = process.argv.slice(2);
const io = { stdout: process.stdout, stderr: process.stderr };

// Allow the migration command itself to run even when unmigrated state is present.
const isMigrateCommand = argv[0] === "migrate-acorn";

if (!isMigrateCommand && failClosedIfUnmigrated(io)) {
  process.exitCode = 1;
} else {
  process.exitCode = await runCli(argv);
}
