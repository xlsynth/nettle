// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  decodeHostedConfig,
  decodeHostedSessionCreated,
  decodeHostedSessionStatus,
  hostedSessionTokenFromPath,
  isHostedSessionPath,
} from "./hosted";

describe("hosted API contracts", () => {
  it("decodes the public host policy used by pre-upload disclosures", () => {
    expect(
      decodeHostedConfig({
        hostingEnabled: true,
        retention: { mode: "expires", seconds: 2_592_000, display: "for 30 days" },
        limits: { maxUploadBytes: 1024, maxQueuedBuilds: 32 },
        sourceFormats: ["zip", "tar.gz"],
      }),
    ).toEqual({
      hostingEnabled: true,
      retention: { mode: "expires", seconds: 2_592_000, display: "for 30 days" },
      limits: { maxUploadBytes: 1024, maxQueuedBuilds: 32 },
      sourceFormats: ["zip", "tar.gz"],
    });
  });

  it("decodes integer server timestamps without relying on client clock parsing", () => {
    expect(
      decodeHostedSessionStatus({
        state: "queued",
        admittedAtMs: 1_000,
        serverTimeMs: 2_000,
        queuePosition: 3,
      }),
    ).toEqual({
      state: "queued",
      admittedAtMs: 1_000,
      serverTimeMs: 2_000,
      queuePosition: 3,
      buildStartedAtMs: undefined,
      completedAtMs: undefined,
      expiresAtMs: undefined,
      error: undefined,
    });
  });

  it("rejects incomplete session contracts", () => {
    expect(() =>
      decodeHostedSessionCreated({
        token: "token",
        url: "/s/token",
      }),
    ).toThrow("status URL");
    expect(() =>
      decodeHostedSessionStatus({
        state: "ready",
        admittedAtMs: 1_000,
      }),
    ).toThrow("server time");
    expect(() =>
      decodeHostedSessionCreated({
        token: "a".repeat(64),
        url: "https://example.test/steal",
        statusUrl: `/api/v1/sessions/${"a".repeat(64)}/status`,
      }),
    ).toThrow("session routes");
  });

  it("extracts only bounded capability tokens from session routes", () => {
    const token = "a".repeat(43);
    expect(hostedSessionTokenFromPath(`/s/${token}`)).toBe(token);
    expect(hostedSessionTokenFromPath("/s/short")).toBeUndefined();
    expect(hostedSessionTokenFromPath(`/s/${token}/extra`)).toBeUndefined();
    expect(isHostedSessionPath("/s/short")).toBe(true);
    expect(isHostedSessionPath("/unrelated")).toBe(false);
  });
});
