// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, GraphSlice } from "../model/graph";
import { compareGraphSlices } from "./matcher";
import type { GraphMatcherWorkerRequest, GraphMatcherWorkerResponse } from "./matcher.worker";
import {
  compareGraphSlicesInWorker,
  GRAPH_MATCHER_TIMEOUT_MS,
  MAX_SYNCHRONOUS_MATCHER_WORK,
  rebindComparisonInputs,
} from "./matcher-client";
import type { CompareGraphOptions, SourceLineMapping } from "./types";

const operator = (id: string, label: string, line: number): GraphNode => ({
  id,
  kind: "operator",
  label,
  ports: [
    { id: "input", name: "input", direction: "input", role: "data" },
    { id: "output", name: "output", direction: "output", role: "data" },
  ],
  origins: [{ file: "rtl/top.sv", startLine: line, startColumn: 1 }],
});

const slice = (snapshotId: string, node: GraphNode): GraphSlice => ({
  snapshotId,
  module: {
    id: `${snapshotId}-top`,
    name: "top",
    instancePath: "top",
    definitionName: "top",
    parameters: {},
  },
  nodes: [node],
  edges: [],
});

const reference = slice("reference", operator("reference-op", "old operation", 11));
const candidate = slice("candidate", operator("candidate-op", "new operation", 13));
const mapping: SourceLineMapping = {
  referencePath: "rtl/top.sv",
  candidatePath: "rtl/top.sv",
  referenceToCandidate: new Map([[10, 12]]),
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("graph matcher worker client", () => {
  it("rebinds cloned comparison payloads to caller-owned nodes and node-scoped ports", () => {
    const nodes: GraphNode[] = [
      {
        id: "left",
        kind: "operator",
        label: "left",
        ports: [{ id: "shared", name: "A", direction: "input" }],
      },
      {
        id: "right",
        kind: "operator",
        label: "right",
        ports: [{ id: "shared", name: "Y", direction: "output" }],
      },
    ];
    const callerReference: GraphSlice = {
      snapshotId: "reference-owned",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes,
      edges: [],
    };
    const callerCandidate = structuredClone(callerReference);
    callerCandidate.snapshotId = "candidate-owned";
    const clonedComparison = compareGraphSlices(
      structuredClone(callerReference),
      structuredClone(callerCandidate),
    );

    const rebound = rebindComparisonInputs(clonedComparison, callerReference, callerCandidate);

    expect(rebound.reference).toBe(callerReference);
    expect(rebound.candidate).toBe(callerCandidate);
    expect(rebound.nodes.find((entity) => entity.reference?.id === "left")?.reference).toBe(
      nodes[0],
    );
    expect(rebound.ports.find((entity) => entity.referenceNodeId === "left")?.reference).toBe(
      nodes[0].ports[0],
    );
    expect(rebound.ports.find((entity) => entity.referenceNodeId === "right")?.reference).toBe(
      nodes[1].ports[0],
    );
  });

  it("indexes high-cardinality ports once instead of scanning for every comparison record", () => {
    const portCount = 4_096;
    let callerPortIdReads = 0;
    const callerPorts = Array.from({ length: portCount }, (_, index) => {
      const id = `port-${index.toString().padStart(4, "0")}`;
      return {
        get id() {
          callerPortIdReads += 1;
          return id;
        },
        name: id,
        direction: "input" as const,
      };
    });
    const referenceNode: GraphNode = {
      id: "wide-node",
      kind: "operator",
      label: "wide node",
      ports: callerPorts,
    };
    const callerReference = slice("wide-reference", referenceNode);
    const callerCandidate: GraphSlice = {
      ...slice("wide-candidate", {
        id: "candidate-only",
        kind: "operator",
        label: "candidate only",
        ports: [],
      }),
      nodes: [],
    };
    const clonedReference = slice("wide-reference-clone", {
      ...referenceNode,
      ports: callerPorts.map((port, index) => ({
        id: `port-${index.toString().padStart(4, "0")}`,
        name: port.name,
        direction: port.direction,
      })),
    });
    const clonedCandidate = { ...callerCandidate, snapshotId: "wide-candidate-clone" };
    const clonedComparison = compareGraphSlices(clonedReference, clonedCandidate);

    callerPortIdReads = 0;
    const rebound = rebindComparisonInputs(clonedComparison, callerReference, callerCandidate);

    expect(rebound.ports).toHaveLength(portCount);
    expect(new Set(rebound.ports.map((entity) => entity.reference))).toEqual(new Set(callerPorts));
    expect(callerPortIdReads).toBe(portCount);
  });

  it("falls back asynchronously and can cancel before synchronous matching starts", async () => {
    vi.stubGlobal("Worker", undefined);
    const controller = new AbortController();
    const pending = compareGraphSlicesInWorker(
      reference,
      candidate,
      { policy: "aggressive", sourceLineMappings: [mapping] },
      controller.signal,
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses an oversized synchronous fallback when workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    const crowdedReference: GraphSlice = {
      ...reference,
      nodes: Array.from({ length: MAX_SYNCHRONOUS_MATCHER_WORK + 1 }, (_, index) => ({
        id: `node-${index}`,
        kind: "operator" as const,
        label: "crowded",
        ports: [],
      })),
    };
    const emptyCandidate: GraphSlice = { ...candidate, nodes: [] };

    await expect(
      compareGraphSlicesInWorker(crowdedReference, emptyCandidate),
    ).rejects.toMatchObject({
      name: "MatcherWorkerUnavailableError",
      message: expect.stringContaining(
        `synchronous fallback is limited to ${MAX_SYNCHRONOUS_MATCHER_WORK}`,
      ),
    });
  });

  it("includes origins and source mappings in the synchronous fallback budget", async () => {
    vi.stubGlobal("Worker", undefined);
    const originHeavyReference = slice("origin-heavy", {
      ...operator("origin-heavy-op", "origin heavy", 1),
      origins: Array.from({ length: MAX_SYNCHRONOUS_MATCHER_WORK }, (_, index) => ({
        file: "rtl/generated.sv",
        startLine: index + 1,
        startColumn: 1,
      })),
    });
    await expect(
      compareGraphSlicesInWorker(originHeavyReference, candidate, { policy: "aggressive" }),
    ).rejects.toMatchObject({ name: "MatcherWorkerUnavailableError" });

    const mappingHeavy: SourceLineMapping = {
      referencePath: "rtl/top.sv",
      candidatePath: "rtl/top.sv",
      referenceToCandidate: new Map(
        Array.from({ length: MAX_SYNCHRONOUS_MATCHER_WORK }, (_, index) => [index + 1, index + 1]),
      ),
    };
    await expect(
      compareGraphSlicesInWorker(reference, candidate, {
        policy: "aggressive",
        sourceLineMappings: [mappingHeavy],
      }),
    ).rejects.toMatchObject({ name: "MatcherWorkerUnavailableError" });
  });

  it("structured-clones source-line Maps through the browser worker request", async () => {
    let clonedRequest: GraphMatcherWorkerRequest | undefined;
    class CompletingWorker {
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessage: ((event: MessageEvent<GraphMatcherWorkerResponse>) => void) | null = null;

      postMessage(request: GraphMatcherWorkerRequest) {
        clonedRequest = structuredClone(request);
        queueMicrotask(() => {
          const cloned = clonedRequest as GraphMatcherWorkerRequest;
          this.onmessage?.({
            data: {
              result: compareGraphSlices(cloned.reference, cloned.candidate, cloned.options),
            },
          } as MessageEvent<GraphMatcherWorkerResponse>);
        });
      }

      terminate() {}
    }
    vi.stubGlobal("Worker", CompletingWorker);

    const result = await compareGraphSlicesInWorker(reference, candidate, {
      policy: "aggressive",
      sourceLineMappings: [mapping],
    });

    expect(clonedRequest?.options.sourceLineMappings?.[0]?.referenceToCandidate).toBeInstanceOf(
      Map,
    );
    expect(result.nodes[0].match?.method).toBe("heuristic");
  });

  it("terminates a stale conservative request when policy switches", async () => {
    class ControlledWorker {
      static instances: ControlledWorker[] = [];
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessage: ((event: MessageEvent<GraphMatcherWorkerResponse>) => void) | null = null;
      request?: GraphMatcherWorkerRequest;
      terminated = false;

      constructor() {
        ControlledWorker.instances.push(this);
      }

      postMessage(request: GraphMatcherWorkerRequest) {
        this.request = structuredClone(request);
      }

      complete() {
        const request = this.request as GraphMatcherWorkerRequest;
        this.onmessage?.({
          data: {
            result: compareGraphSlices(request.reference, request.candidate, request.options),
          },
        } as MessageEvent<GraphMatcherWorkerResponse>);
      }

      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal("Worker", ControlledWorker);
    const options = (policy: CompareGraphOptions["policy"]): CompareGraphOptions => ({
      policy,
      sourceLineMappings: [mapping],
    });
    const conservativeController = new AbortController();
    const conservative = compareGraphSlicesInWorker(
      reference,
      candidate,
      options("conservative"),
      conservativeController.signal,
    );

    conservativeController.abort();
    const aggressive = compareGraphSlicesInWorker(reference, candidate, options("aggressive"));
    ControlledWorker.instances[1].complete();

    await expect(conservative).rejects.toMatchObject({ name: "AbortError" });
    expect(ControlledWorker.instances[0].terminated).toBe(true);
    await expect(aggressive).resolves.toMatchObject({
      policy: "aggressive",
      heuristicMatchCount: 1,
    });
  });

  it("terminates a matcher worker at the generated wall-time ceiling", async () => {
    vi.useFakeTimers();
    class HangingWorker {
      static instance: HangingWorker | undefined;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessage: ((event: MessageEvent<GraphMatcherWorkerResponse>) => void) | null = null;
      terminated = false;

      constructor() {
        HangingWorker.instance = this;
      }

      postMessage(_request: GraphMatcherWorkerRequest) {}

      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal("Worker", HangingWorker);

    const pending = compareGraphSlicesInWorker(reference, candidate, { policy: "aggressive" });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining(`exceeded ${GRAPH_MATCHER_TIMEOUT_MS} ms`),
    });
    await vi.advanceTimersByTimeAsync(GRAPH_MATCHER_TIMEOUT_MS);

    await rejection;
    expect(HangingWorker.instance?.terminated).toBe(true);
  });
});
