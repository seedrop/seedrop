import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PassportSchema, type Passport } from "./schema.js";
import {
  PassportNotFoundError,
  PassportParseError,
  PassportValidationError,
} from "./errors.js";

export function serializePassport(passport: Passport): string {
  const result = PassportSchema.safeParse(passport);
  if (!result.success) {
    throw new PassportValidationError(result.error.issues);
  }
  return JSON.stringify(result.data, null, 2) + "\n";
}

export async function readPassport(path: string): Promise<Passport> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PassportNotFoundError(path);
    }
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new PassportParseError(path, err as Error);
  }

  const result = PassportSchema.safeParse(json);
  if (!result.success) {
    throw new PassportValidationError(result.error.issues, path);
  }
  return result.data;
}

export async function writePassport(passport: Passport, path: string): Promise<void> {
  const serialized = serializePassport(passport);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, serialized, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
