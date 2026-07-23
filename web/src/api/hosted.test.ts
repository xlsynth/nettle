// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyHostedUploadKind,
  createHostedAzureSession,
  createHostedSession,
  decodeHostedConfig,
  decodeHostedSessionCreated,
  decodeHostedSessionStatus,
  hostedComparisonPath,
  hostedComparisonRouteFromLocation,
  hostedSessionTokenFromPath,
  isHostedComparisonPath,
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
        azureEnabled: false,
        retention: { mode: "expires", seconds: 2_592_000, display: "for 30 days" },
        limits: { maxUploadBytes: 1024, maxQueuedBuilds: 32 },
        sourceFormats: ["zip", "tar.gz"],
      }),
    ).toEqual({
      hostingEnabled: true,
      azureEnabled: false,
      retention: { mode: "expires", seconds: 2_592_000, display: "for 30 days" },
      limits: { maxUploadBytes: 1024, maxQueuedBuilds: 32 },
      sourceFormats: ["zip", "tar.gz"],
    });
  });

  it("requires an explicit boolean Azure capability", () => {
    const base = {
      hostingEnabled: true,
      retention: { mode: "forever", display: "Retained" },
      limits: { maxUploadBytes: 1024, maxQueuedBuilds: 32 },
      sourceFormats: [".zip"],
    };

    expect(() => decodeHostedConfig(base)).toThrow("azureEnabled");
    expect(() => decodeHostedConfig({ ...base, azureEnabled: "1" })).toThrow("azureEnabled");
    expect(decodeHostedConfig({ ...base, azureEnabled: true }).azureEnabled).toBe(true);
  });

  it("submits an Azure import as a same-origin JSON request", async () => {
    const token = "a".repeat(64);
    const created = {
      token,
      url: `/s/${token}`,
      statusUrl: `/api/v1/sessions/${token}/status`,
    };
    const fetch = vi.fn(async () => ({ ok: true, json: async () => created }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await expect(
      createHostedAzureSession(
        "az://account/container/project.zip",
        "nested/project.f",
        controller.signal,
      ),
    ).resolves.toEqual(created);
    expect(fetch).toHaveBeenCalledWith("/api/v1/azure-imports", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Nettle-Upload": "1",
      },
      body: JSON.stringify({
        path: "az://account/container/project.zip",
        sourceFilelist: "nested/project.f",
      }),
      signal: controller.signal,
    });
  });

  it("omits a source filelist for an imported Azure bundle", async () => {
    const token = "b".repeat(64);
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token,
        url: `/s/${token}`,
        statusUrl: `/api/v1/sessions/${token}/status`,
      }),
    }));
    vi.stubGlobal("fetch", fetch);

    await createHostedAzureSession("az://account/container/design.nettle");

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/azure-imports",
      expect.objectContaining({
        body: JSON.stringify({ path: "az://account/container/design.nettle" }),
      }),
    );
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

    await createHostedSession("sources", file, "br_counter/filelist.f", vi.fn());
    const selected = Array.from(MockXmlHttpRequest.sent[0].entries());
    expect(selected.map(([name]) => name)).toEqual(["kind", "filelist", "file"]);
    expect(selected[1][1]).toBe("br_counter/filelist.f");
    expect((selected[2][1] as File).name).toBe("project.zip");

    await createHostedSession("sources", file, undefined, vi.fn());
    const defaulted = Array.from(MockXmlHttpRequest.sent[1].entries());
    expect(defaulted.map(([name]) => name)).toEqual(["kind", "file"]);
  });

  it("classifies comparison inputs from case-insensitive server-advertised suffixes", () => {
    const sourceFormats = [".zip", "tar", ".tar.gz", ".tgz"];
    expect(classifyHostedUploadKind("reference.NETTLE", sourceFormats)).toBe("bundle");
    expect(classifyHostedUploadKind("candidate.ZIP", sourceFormats)).toBe("sources");
    expect(classifyHostedUploadKind("candidate.TAR.GZ", sourceFormats)).toBe("sources");
    expect(classifyHostedUploadKind("candidate.tgz", sourceFormats)).toBe("sources");
    expect(classifyHostedUploadKind("candidate.sv", sourceFormats)).toBeUndefined();
  });

  it("round-trips composed comparison capability routes and defaults matching", () => {
    const referenceToken = "a".repeat(64);
    const candidateToken = "b".repeat(64);
    const route = hostedComparisonPath({
      referenceToken,
      candidateToken,
      matching: "aggressive",
      modulePair: {
        referenceModule: "reference_top",
        candidateModule: "candidate_top",
      },
    });
    expect(route).toBe(
      `/compare/${referenceToken}/${candidateToken}?matching=aggressive&referenceModule=reference_top&candidateModule=candidate_top`,
    );
    expect(
      hostedComparisonRouteFromLocation(
        `/compare/${referenceToken}/${candidateToken}`,
        "?matching=aggressive&referenceModule=reference_top&candidateModule=candidate_top",
      ),
    ).toEqual({
      referenceToken,
      candidateToken,
      matching: "aggressive",
      modulePair: {
        referenceModule: "reference_top",
        candidateModule: "candidate_top",
      },
    });
    expect(
      hostedComparisonRouteFromLocation(
        `/compare/${referenceToken}/${candidateToken}`,
        "?matching=unknown",
      )?.matching,
    ).toBe("conservative");
    expect(isHostedComparisonPath(`/compare/${referenceToken}/${candidateToken}`)).toBe(true);
    expect(isHostedComparisonPath("/unrelated")).toBe(false);
    expect(
      hostedComparisonRouteFromLocation(
        `/compare/${referenceToken}/${candidateToken}`,
        "?referenceModule=reference_top",
      )?.modulePair,
    ).toBeUndefined();
  });

  it("rejects malformed comparison capability routes", () => {
    const token = "a".repeat(64);
    expect(hostedComparisonRouteFromLocation(`/compare/short/${token}`)).toBeUndefined();
    expect(hostedComparisonRouteFromLocation(`/compare/${token}/${token}/extra`)).toBeUndefined();
    expect(() =>
      hostedComparisonPath({
        referenceToken: "short",
        candidateToken: token,
        matching: "conservative",
      }),
    ).toThrow("comparison session token");
    expect(() =>
      hostedComparisonPath({
        referenceToken: token,
        candidateToken: token,
        matching: "conservative",
        modulePair: {
          referenceModule: "",
          candidateModule: "candidate_top",
        },
      }),
    ).toThrow("comparison module pair");
  });
});
