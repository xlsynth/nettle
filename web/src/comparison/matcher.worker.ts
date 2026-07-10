// SPDX-License-Identifier: Apache-2.0

/// <reference lib="webworker" />

import type { GraphSlice } from "../model/graph";
import { compareGraphSlices } from "./matcher";
import type { CompareGraphOptions, ComparisonSlice } from "./types";

export interface GraphMatcherWorkerRequest {
  reference: GraphSlice;
  candidate: GraphSlice;
  options: CompareGraphOptions;
}

export type GraphMatcherWorkerResponse =
  | { result: ComparisonSlice }
  | { error: { name: string; message: string } };

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<GraphMatcherWorkerRequest>) => {
  try {
    const { reference, candidate, options } = event.data;
    worker.postMessage({
      result: compareGraphSlices(reference, candidate, options),
    } satisfies GraphMatcherWorkerResponse);
  } catch (error) {
    worker.postMessage({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies GraphMatcherWorkerResponse);
  }
};
