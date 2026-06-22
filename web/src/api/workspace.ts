// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceProvider } from "../bundle/provider";
import {
  firstSourceReference,
  type LoadedWorkspace,
  normalizeGraphSlice,
  normalizeProject,
} from "./normalize";

export const loadWorkspace = async (
  client: WorkspaceProvider,
  signal?: AbortSignal,
): Promise<LoadedWorkspace> => {
  const projectPromise = client.getProject(signal);
  const treePromise = client.getTree(signal);
  const graphPromise = projectPromise.then((project) =>
    client.getGraphSlice(
      {
        snapshotId: project.snapshotId,
        moduleName: project.top,
      },
      signal,
    ),
  );
  const [projectResponse, treeResponse, graphResponse] = await Promise.all([
    projectPromise,
    treePromise,
    graphPromise,
  ]);
  const project = normalizeProject(projectResponse, treeResponse);
  const slice = normalizeGraphSlice(graphResponse);
  const sourceReference = firstSourceReference(slice, project.files);

  if (!sourceReference) return { project, slice };
  try {
    const source = await client.getSource(sourceReference.id, signal);
    return { project, slice, source };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      project,
      slice,
      sourceError: error instanceof Error ? error.message : String(error),
    };
  }
};
