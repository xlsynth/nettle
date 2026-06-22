// SPDX-License-Identifier: Apache-2.0

import { RESOURCE_LIMITS } from "../generated/resource-limits";

export type ConstantRadix = "binary" | "hex" | "decimal";

const BINARY_LITERAL = /^(\d+)'[bB]([01xXzZ?_]+)$/;
const MAX_DECIMAL_CONVERSION_BITS = RESOURCE_LIMITS.browser.display.decimalConversionBits;
const MAX_FORMATTABLE_BITS = RESOURCE_LIMITS.browser.display.formattableConstantBits;

const canonicalBinary = (width: number, bits: string): string => {
  const uniform = ["0", "x", "z"].find((digit) => [...bits].every((bit) => bit === digit));
  return `${width}'b${uniform ?? bits}`;
};

export const formatConstantLiteral = (literal: string, radix: ConstantRadix): string => {
  const match = BINARY_LITERAL.exec(literal.trim());
  if (!match) return literal;

  const width = Number(match[1]);
  const digits = match[2].replaceAll("_", "").toLowerCase().replaceAll("?", "x");
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > MAX_FORMATTABLE_BITS ||
    digits.length > width
  ) {
    return literal;
  }

  const fill = digits.length === 1 && ["0", "x", "z"].includes(digits) ? digits : "0";
  const bits = digits.padStart(width, fill);
  const binary = canonicalBinary(width, bits);
  if (radix === "binary") return binary;

  const uniformUnknown = ["x", "z"].find((digit) => [...bits].every((bit) => bit === digit));
  if (radix === "decimal") {
    if (uniformUnknown) return `${width}'d${uniformUnknown}`;
    if (bits.includes("x") || bits.includes("z") || width > MAX_DECIMAL_CONVERSION_BITS) {
      return binary;
    }
    return `${width}'d${BigInt(`0b${bits}`).toString(10)}`;
  }

  if (uniformUnknown) return `${width}'h${uniformUnknown}`;

  const padded = bits.padStart(Math.ceil(width / 4) * 4, "0");
  const hexDigits: string[] = [];
  for (let index = 0; index < padded.length; index += 4) {
    const nibble = padded.slice(index, index + 4);
    if ([...nibble].every((bit) => bit === "x")) {
      hexDigits.push("x");
    } else if ([...nibble].every((bit) => bit === "z")) {
      hexDigits.push("z");
    } else if ([...nibble].every((bit) => bit === "0" || bit === "1")) {
      hexDigits.push(Number.parseInt(nibble, 2).toString(16));
    } else {
      return binary;
    }
  }
  const hex = hexDigits.join("");
  return `${width}'h${[...hex].every((digit) => digit === "0") ? "0" : hex}`;
};
