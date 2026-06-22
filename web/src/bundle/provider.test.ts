// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { BundleSourceFile } from "./protobuf";
import { MAX_SOURCE_PATH_BYTES, MAX_SOURCE_PATH_DEPTH, makeTree } from "./provider";

const source = (path: string): BundleSourceFile => ({
  id: path,
  path,
  entry: "sources/digest",
  sha256: "digest",
  size: 0,
});

describe("bundle source tree limits", () => {
  it("rejects paths that would create excessively deep trees", () => {
    const path = `${Array.from({ length: MAX_SOURCE_PATH_DEPTH }, () => "d").join("/")}/file.sv`;
    expect(() => makeTree([source(path)])).toThrow("exceeds the supported depth");
  });

  it("preserves ordinary nested source paths", () => {
    expect(makeTree([source("rtl/blocks/top.sv")])).toEqual({
      root: "",
      entries: [
        {
          name: "rtl",
          path: "rtl",
          kind: "directory",
          children: [
            {
              name: "blocks",
              path: "rtl/blocks",
              kind: "directory",
              children: [
                {
                  name: "top.sv",
                  path: "rtl/blocks/top.sv",
                  kind: "file",
                  fileId: "rtl/blocks/top.sv",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it.each(["../rtl/top.sv", "rtl//top.sv", "/rtl/top.sv", "rtl\\top.sv", "rtl/./top.sv"])(
    "rejects unsafe source path %s",
    (path) => {
      expect(() => makeTree([source(path)])).toThrow("is unsafe");
    },
  );

  it("rejects source paths over the shared byte limit", () => {
    expect(() => makeTree([source("a".repeat(MAX_SOURCE_PATH_BYTES + 1))])).toThrow("is unsafe");
  });
});
