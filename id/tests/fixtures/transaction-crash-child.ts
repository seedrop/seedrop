import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PassportCommitPhase } from "../../src/commit-journal.js";
import { Identity } from "../../src/identity.js";
import { readPassport } from "../../src/passport.js";

const [, , passportPath, crashPhase, mode] = process.argv;
if (!passportPath || !crashPhase) process.exit(90);

const onPhase = (phase: PassportCommitPhase) => {
  if (phase === crashPhase) process.exit(91);
};
if (mode === "create") {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "valid-passport.json");
  await Identity.savePassport(await readPassport(fixture), passportPath, {
    commandId: `process-crash-create-${crashPhase}`,
    now: new Date("2026-08-09T08:00:00.000Z"),
    onPhase,
  });
} else {
  const identity = await Identity.fromPassport(passportPath);
  await identity.commitSession({
    write: true,
    commandId: `process-crash-${crashPhase}`,
    now: new Date("2026-08-09T08:00:00.000Z"),
    onPhase,
  });
}
