import { createHash } from "node:crypto";
import { protocolError } from "./errors.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return encode(value, new WeakSet<object>(), "$", false);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function canonicalJsonDigest(value: unknown): `sha256:${string}` {
  const digest = createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
  return `sha256:${digest}`;
}

function encode(value: unknown, ancestors: WeakSet<object>, path: string, inArray: boolean): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string") assertValidUnicode(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw protocolError("seedrop.protocol.canonical_json_unsupported", { path, type: "non_finite_number" });
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw protocolError("seedrop.protocol.canonical_json_unsupported", {
      path,
      type: value === undefined ? (inArray ? "undefined_array_item" : "undefined") : typeof value,
    });
  }

  if (ancestors.has(value)) {
    throw protocolError("seedrop.protocol.canonical_json_cycle", { path });
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertArrayOwnProperties(value, path);
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw protocolError("seedrop.protocol.canonical_json_unsupported", {
            path: `${path}[${index}]`,
            type: "sparse_array_item",
          });
        }
        encoded.push(encode(value[index], ancestors, `${path}[${index}]`, true));
      }
      return `[${encoded.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw protocolError("seedrop.protocol.canonical_json_unsupported", {
        path,
        type: "non_plain_object",
      });
    }

    const record = value as Record<string, unknown>;
    const keys = assertPlainObjectProperties(record, path).sort(compareUtf16);
    const encoded = keys.map((key) => {
      assertValidUnicode(key, `${path}.<key>`);
      return `${JSON.stringify(key)}:${encode(record[key], ancestors, childPath(path, key), false)}`;
    });
    return `{${encoded.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertArrayOwnProperties(value: unknown[], path: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key === "symbol") {
      throw protocolError("seedrop.protocol.canonical_json_unsupported", { path, type: "symbol_key" });
    }
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw protocolError("seedrop.protocol.canonical_json_unsupported", {
        path: childPath(path, key),
        type: "extra_array_property",
      });
    }
    assertDataProperty(value, key, childPath(path, key));
  }
}

function assertPlainObjectProperties(record: Record<string, unknown>, path: string): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key === "symbol") {
      throw protocolError("seedrop.protocol.canonical_json_unsupported", { path, type: "symbol_key" });
    }
    assertDataProperty(record, key, childPath(path, key));
    keys.push(key);
  }
  return keys;
}

function assertDataProperty(value: object, key: string, path: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable) {
    throw protocolError("seedrop.protocol.canonical_json_unsupported", {
      path,
      type: "non_enumerable_property",
    });
  }
  if (!("value" in descriptor)) {
    throw protocolError("seedrop.protocol.canonical_json_unsupported", {
      path,
      type: "accessor_property",
    });
  }
}

function compareUtf16(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw protocolError("seedrop.protocol.canonical_json_invalid_unicode", { path, offset: index });
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw protocolError("seedrop.protocol.canonical_json_invalid_unicode", { path, offset: index });
    }
  }
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}
