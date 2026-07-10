// SPDX-License-Identifier: Apache-2.0

/// <reference lib="webworker" />

import { diffSourceTexts, type SourceDiffOptions, type SourceTextDiff } from "./source-diff";

export interface SourceDiffWorkerRequest {
  referencePath: string;
  candidatePath: string;
  referenceText: string;
  candidateText: string;
  options: SourceDiffOptions;
}

export type SourceDiffWorkerResponse =
  | { result: SourceTextDiff }
  | { error: { name: string; message: string } };

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<SourceDiffWorkerRequest>) => {
  try {
    const request = event.data;
    const result = diffSourceTexts(
      request.referencePath,
      request.candidatePath,
      request.referenceText,
      request.candidateText,
      request.options,
    );
    worker.postMessage({ result } satisfies SourceDiffWorkerResponse);
  } catch (error) {
    worker.postMessage({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies SourceDiffWorkerResponse);
  }
};
