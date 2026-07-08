// SPDX-License-Identifier: Apache-2.0

import { diffSourceTextsAsync, type SourceDiffOptions, type SourceTextDiff } from "./source-diff";
import type { SourceDiffWorkerRequest, SourceDiffWorkerResponse } from "./source-diff.worker";

const abortError = () => new DOMException("The operation was aborted", "AbortError");

/**
 * Runs the bounded source diff in a disposable Vite worker. Non-browser test
 * environments fall back to the async implementation with identical limits.
 */
export const diffSourceTextsInWorker = (
  referencePath: string,
  candidatePath: string,
  referenceText: string,
  candidateText: string,
  options: SourceDiffOptions = {},
  signal?: AbortSignal,
): Promise<SourceTextDiff> => {
  if (signal?.aborted) return Promise.reject(abortError());
  if (typeof Worker === "undefined") {
    return diffSourceTextsAsync(
      referencePath,
      candidatePath,
      referenceText,
      candidateText,
      options,
      signal,
    );
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./source-diff.worker.ts", import.meta.url), {
      type: "module",
    });
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Source diff worker failed"));
    };
    worker.onmessage = (event: MessageEvent<SourceDiffWorkerResponse>) => {
      cleanup();
      if ("error" in event.data) {
        const error = new Error(event.data.error.message);
        error.name = event.data.error.name;
        reject(error);
      } else {
        resolve(event.data.result);
      }
    };
    worker.postMessage({
      referencePath,
      candidatePath,
      referenceText,
      candidateText,
      options,
    } satisfies SourceDiffWorkerRequest);
  });
};
