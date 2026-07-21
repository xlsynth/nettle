// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostedSession,
  decodeHostedConfig,
  decodeHostedSessionCreated,
  decodeHostedSessionStatus,
  hostedSessionTokenFromPath,
  isHostedSessionPath,
} from "./hosted";

class MockEventTarget {
  private readonly listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener() {}

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class MockXmlHttpRequest extends MockEventTarget {
  static sent: FormData[] = [];

  readonly upload = new MockEventTarget();
  status = 202;
  response = {
    token: "a".repeat(43),
    url: `/s/${"a".repeat(43)}`,
    statusUrl: `/api/v1/sessions/${"a".repeat(43)}/status`,
  };
  responseType = "";
  withCredentials = false;

  open() {}

  setRequestHeader() {}

  send(body: FormData) {
    MockXmlHttpRequest.sent.push(body);
    this.dispatch("load");
  }

  abort() {
    this.dispatch("abort");
  }
}

afterEach(() => {
  MockXmlHttpRequest.sent = [];
  vi.unstubAllGlobals();
});

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

  it("places an optional source filelist before the archive multipart field", async () => {
    vi.stubGlobal("XMLHttpRequest", MockXmlHttpRequest);
    const file = new File(["sources"], "project.zip", { type: "application/zip" });

    await createHostedSession(
      "sources",
      file,
      "br_counter/filelist.f",
      vi.fn(),
    );
    const selected = Array.from(MockXmlHttpRequest.sent[0].entries());
    expect(selected.map(([name]) => name)).toEqual(["kind", "filelist", "file"]);
    expect(selected[1][1]).toBe("br_counter/filelist.f");
    expect((selected[2][1] as File).name).toBe("project.zip");

    await createHostedSession("sources", file, undefined, vi.fn());
    const defaulted = Array.from(MockXmlHttpRequest.sent[1].entries());
    expect(defaulted.map(([name]) => name)).toEqual(["kind", "file"]);
  });
});
