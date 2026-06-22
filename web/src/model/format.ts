// SPDX-License-Identifier: Apache-2.0

import { RESOURCE_LIMITS } from "../generated/resource-limits";
import type { JsonValue } from "./graph";

export const MAX_DECIMAL_FORMAT_BITS = RESOURCE_LIMITS.browser.display.decimalConversionBits;
export const MAX_FORMATTED_METADATA_DEPTH = RESOURCE_LIMITS.browser.display.metadataDepth;
export const MAX_FORMATTED_METADATA_NODES = RESOURCE_LIMITS.browser.display.metadataNodes;
export const MAX_FORMATTED_METADATA_CHARS = RESOURCE_LIMITS.browser.display.metadataCharacters;

const metadataWithinDisplayLimits = (root: JsonValue) => {
  const pending: Array<{ value: JsonValue; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  let characters = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_FORMATTED_METADATA_NODES || current.depth > MAX_FORMATTED_METADATA_DEPTH) {
      return false;
    }
    const { value } = current;
    if (typeof value === "string") characters += value.length + 2;
    else if (typeof value === "number") characters += 32;
    else if (typeof value === "boolean") characters += 5;
    else if (value === null) characters += 4;
    else if (Array.isArray(value)) {
      characters += value.length + 2;
      if (nodes + pending.length + value.length > MAX_FORMATTED_METADATA_NODES) return false;
      for (const child of value) pending.push({ value: child, depth: current.depth + 1 });
    } else {
      characters += 2;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        characters += key.length + 3;
        if (nodes + pending.length >= MAX_FORMATTED_METADATA_NODES) return false;
        pending.push({ value: value[key], depth: current.depth + 1 });
      }
    }
    if (characters > MAX_FORMATTED_METADATA_CHARS) return false;
  }
  return true;
};

export function formatJsonValue(value: JsonValue): string {
  if (typeof value === "string") {
    if (value.length <= MAX_DECIMAL_FORMAT_BITS && /^[01]+$/.test(value)) {
      try {
        return BigInt(`0b${value}`).toString(10);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (value === null) return "null";
  if (typeof value === "object") {
    if (!metadataWithinDisplayLimits(value)) return "[metadata omitted: exceeds display limits]";
    return JSON.stringify(value);
  }
  return String(value);
}
