import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface GoldenFixture {
  fixture_version: string;
  id_kind_codes: Record<string, string>;
  canonical_id: {
    kind: "intent";
    timestamp_ms: number;
    entropy_hex: string;
    value: string;
  };
  canonical_json: {
    value: unknown;
    text: string;
    utf8_hex: string;
    sha256: string;
  };
  versions: Record<string, string>;
  migration_plan: unknown;
  error_registry: unknown;
}

const fixturePath = fileURLToPath(new URL("../fixtures/golden-v2-contract.json", import.meta.url));
export const golden = JSON.parse(readFileSync(fixturePath, "utf8")) as GoldenFixture;
