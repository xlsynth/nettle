// SPDX-License-Identifier: Apache-2.0

export interface SourceLanguage {
  id: string;
  label: string;
}

export const sourceLanguageForPath = (path: string): SourceLanguage => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".sv") || lower.endsWith(".svh")) {
    return { id: "systemverilog", label: "SystemVerilog" };
  }
  if (lower.endsWith(".v") || lower.endsWith(".vh")) {
    return { id: "verilog", label: "Verilog" };
  }
  if (lower.endsWith(".json")) return { id: "json", label: "JSON" };
  if (lower.endsWith(".md")) return { id: "markdown", label: "Markdown" };
  if (lower.endsWith(".toml")) return { id: "toml", label: "TOML" };
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return { id: "yaml", label: "YAML" };
  if (lower.endsWith(".rs")) return { id: "rust", label: "Rust" };
  if (lower.endsWith(".py")) return { id: "python", label: "Python" };
  if (lower.endsWith(".c") || lower.endsWith(".h")) return { id: "c", label: "C" };
  if (/\.(?:cc|cpp|cxx|hh|hpp|hxx)$/i.test(lower)) return { id: "cpp", label: "C++" };
  if (lower.endsWith(".js")) return { id: "javascript", label: "JavaScript" };
  if (lower.endsWith(".ts")) return { id: "typescript", label: "TypeScript" };
  if (lower.endsWith(".f")) return { id: "plaintext", label: "File list" };
  return { id: "plaintext", label: "Plain text" };
};
