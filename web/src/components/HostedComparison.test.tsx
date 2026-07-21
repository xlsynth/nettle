// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedApiError } from "../api/hosted";
import { HostedComparisonPage, HostedComparisonUploadDialog } from "./HostedComparison";

const harness = vi.hoisted(() => ({
  createHostedSession: vi.fn(),
  getHostedConfig: vi.fn(),
  getHostedSessionStatus: vi.fn(),
  loadHostedBundle: vi.fn(),
}));

vi.mock("../api/hosted", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/hosted")>();
  return {
    ...original,
    createHostedSession: harness.createHostedSession,
    getHostedConfig: harness.getHostedConfig,
    getHostedSessionStatus: harness.getHostedSessionStatus,
    loadHostedBundle: harness.loadHostedBundle,
  };
});

const referenceToken = "a".repeat(43);
const candidateToken = "b".repeat(43);
const config = {
  hostingEnabled: true,
  retention: {
    mode: "expires" as const,
    seconds: 2_592_000,
    display: "Retained for 30 days after completion",
  },
  limits: { maxUploadBytes: 1024 * 1024, maxQueuedBuilds: 32 },
  sourceFormats: ["zip", "tar", "tar.gz", "tgz"],
};
const readyStatus = {
  state: "ready" as const,
  admittedAtMs: 1_000,
  completedAtMs: 2_000,
  expiresAtMs: 10_000,
  serverTimeMs: 3_000,
};

const created = (token: string) => ({
  token,
  url: `/s/${token}`,
  statusUrl: `/api/v1/sessions/${token}/status`,
});

beforeEach(() => {
  harness.getHostedConfig.mockResolvedValue(config);
  harness.createHostedSession.mockImplementation(
    async (
      _kind: string,
      file: File,
      _sourceFilelist: string | undefined,
      progress: (value: unknown) => void,
    ) => {
      progress({ loaded: file.size, total: file.size, percent: 100 });
      return created(file.name.startsWith("reference") ? referenceToken : candidateToken);
    },
  );
  harness.getHostedSessionStatus.mockResolvedValue(readyStatus);
  harness.loadHostedBundle.mockImplementation(async (token: string) => {
    return new File([token], `${token}.nettle`, { type: "application/octet-stream" });
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HostedComparisonUploadDialog", () => {
  it.each([
    ["reference.nettle", "candidate.nettle", "bundle", "bundle"],
    ["reference.nettle", "candidate.zip", "bundle", "sources"],
    ["reference.TAR.GZ", "candidate.nettle", "sources", "bundle"],
    ["reference.tgz", "candidate.tar", "sources", "sources"],
  ])(
    "classifies %s and %s independently",
    async (referenceName, candidateName, referenceKind, candidateKind) => {
      const onCreated = vi.fn();
      render(<HostedComparisonUploadDialog open onClose={vi.fn()} onCreated={onCreated} />);

      const reference = new File(["reference"], referenceName);
      const candidate = new File(["candidate"], candidateName);
      fireEvent.change(
        await screen.findByLabelText("Choose reference .nettle bundle or source archive"),
        { target: { files: [reference] } },
      );
      fireEvent.change(screen.getByLabelText("Choose candidate .nettle bundle or source archive"), {
        target: { files: [candidate] },
      });
      fireEvent.change(screen.getByLabelText("Matching policy"), {
        target: { value: "aggressive" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Upload and create comparison link" }));

      await waitFor(() => expect(harness.createHostedSession).toHaveBeenCalledTimes(2));
      expect(harness.createHostedSession).toHaveBeenNthCalledWith(
        1,
        referenceKind,
        reference,
        undefined,
        expect.any(Function),
        expect.any(AbortSignal),
      );
      expect(harness.createHostedSession).toHaveBeenNthCalledWith(
        2,
        candidateKind,
        candidate,
        undefined,
        expect.any(Function),
        expect.any(AbortSignal),
      );
      await waitFor(() =>
        expect(onCreated).toHaveBeenCalledWith({
          referenceToken,
          candidateToken,
          matching: "aggressive",
        }),
      );
    },
  );

  it("preserves one admitted side and retries only the failed side", async () => {
    harness.createHostedSession
      .mockResolvedValueOnce(created(referenceToken))
      .mockRejectedValueOnce(new Error("Candidate admission failed"))
      .mockResolvedValueOnce(created(candidateToken));
    const onCreated = vi.fn();
    render(<HostedComparisonUploadDialog open onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(
      await screen.findByLabelText("Choose reference .nettle bundle or source archive"),
      { target: { files: [new File(["reference"], "reference.nettle")] } },
    );
    fireEvent.change(screen.getByLabelText("Choose candidate .nettle bundle or source archive"), {
      target: { files: [new File(["candidate"], "candidate.zip")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload and create comparison link" }));

    expect(await screen.findByText("Candidate admission failed")).toBeTruthy();
    const referenceInput = screen.getByLabelText(
      "Choose reference .nettle bundle or source archive",
    );
    const candidateInput = screen.getByLabelText(
      "Choose candidate .nettle bundle or source archive",
    );
    expect(referenceInput.hasAttribute("disabled")).toBe(true);
    expect(candidateInput.hasAttribute("disabled")).toBe(false);
    fireEvent.change(candidateInput, {
      target: { files: [new File(["fixed"], "candidate-fixed.nettle")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry incomplete upload" }));

    await waitFor(() => expect(harness.createHostedSession).toHaveBeenCalledTimes(3));
    expect(harness.createHostedSession.mock.calls[2][1].name).toBe("candidate-fixed.nettle");
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({
        referenceToken,
        candidateToken,
        matching: "conservative",
      }),
    );
  });

  it("rejects unsupported extensions and over-limit files before uploading", async () => {
    render(<HostedComparisonUploadDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    const referenceInput = await screen.findByLabelText(
      "Choose reference .nettle bundle or source archive",
    );
    const candidateInput = screen.getByLabelText(
      "Choose candidate .nettle bundle or source archive",
    );

    fireEvent.change(referenceInput, {
      target: { files: [new File(["rtl"], "reference.sv")] },
    });
    fireEvent.change(candidateInput, {
      target: {
        files: [new File([new Uint8Array(config.limits.maxUploadBytes + 1)], "candidate.zip")],
      },
    });

    expect(
      screen.getByText(/Reference must be a .nettle bundle or a supported source archive/),
    ).toBeTruthy();
    expect(screen.getByText(/Candidate is larger than the server limit/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Upload and create comparison link" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(harness.createHostedSession).not.toHaveBeenCalled();
  });

  it("aborts both outstanding admissions when closed", async () => {
    const signals: AbortSignal[] = [];
    harness.createHostedSession.mockImplementation(
      (
        _kind: string,
        _file: File,
        _sourceFilelist: string | undefined,
        _progress: (value: unknown) => void,
        signal: AbortSignal,
      ) => {
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );
    const onClose = vi.fn();
    render(<HostedComparisonUploadDialog open onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.change(
      await screen.findByLabelText("Choose reference .nettle bundle or source archive"),
      { target: { files: [new File(["reference"], "reference.nettle")] } },
    );
    fireEvent.change(screen.getByLabelText("Choose candidate .nettle bundle or source archive"), {
      target: { files: [new File(["candidate"], "candidate.nettle")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload and create comparison link" }));
    await waitFor(() => expect(signals).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Close hosted comparison upload dialog" }));
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("HostedComparisonPage", () => {
  it("opens two ready hosted bundles with the URL matching policy", async () => {
    const onOpenComparison = vi.fn().mockResolvedValue(undefined);
    render(
      <HostedComparisonPage
        route={{ referenceToken, candidateToken, matching: "aggressive" }}
        onOpenComparison={onOpenComparison}
      />,
    );

    await waitFor(() => expect(harness.getHostedSessionStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(harness.loadHostedBundle).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onOpenComparison).toHaveBeenCalledOnce());
    const [reference, candidate, matching, sessions] = onOpenComparison.mock.calls[0];
    expect(reference).toBeInstanceOf(File);
    expect(candidate).toBeInstanceOf(File);
    expect(matching).toBe("aggressive");
    expect(sessions).toEqual({
      reference: { token: referenceToken, status: readyStatus },
      candidate: { token: candidateToken, status: readyStatus },
      shareable: true,
    });
    expect(screen.getByRole("link", { name: "Download reference" }).getAttribute("href")).toBe(
      `/api/v1/sessions/${referenceToken}/download`,
    );
    expect(
      screen.getByText(/Anyone with this link can view and download both bundles/),
    ).toBeTruthy();
  });

  it("identifies which underlying session is missing", async () => {
    harness.getHostedSessionStatus.mockImplementation(async (token: string) => {
      if (token === referenceToken) {
        throw new HostedApiError("Session not found or expired.", 404);
      }
      return readyStatus;
    });
    render(
      <HostedComparisonPage
        route={{ referenceToken, candidateToken, matching: "conservative" }}
        onOpenComparison={vi.fn()}
      />,
    );

    expect(await screen.findByText("Reference session was not found or has expired.")).toBeTruthy();
    expect(harness.loadHostedBundle).not.toHaveBeenCalled();
  });
});
