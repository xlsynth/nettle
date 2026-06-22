// SPDX-License-Identifier: Apache-2.0

export type LogicGateKind = "and" | "or" | "xor" | "nand" | "nor" | "xnor" | "not" | "buffer";

export const logicGateKind = (glyph?: string): LogicGateKind | undefined => {
  switch (glyph) {
    case "&":
    case "&&":
      return "and";
    case "|":
    case "||":
    case "≥1":
    case "≠0":
      return "or";
    case "^":
      return "xor";
    case "~^":
      return "xnor";
    case "NAND":
      return "nand";
    case "NOR":
      return "nor";
    case "~":
    case "!":
      return "not";
    case "→":
      return "buffer";
    default:
      return undefined;
  }
};

export const gateHasInversion = (kind: LogicGateKind): boolean =>
  kind === "nand" || kind === "nor" || kind === "xnor" || kind === "not";
