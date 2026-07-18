// SPDX-License-Identifier: Apache-2.0

import { BUILD_DATE_UTC, BUILD_GIT_SHA, BUILD_SUFFIX } from "../build-info";

export function BuildInfo() {
  return (
    <footer className="build-info">
      <span>Build date (UTC) {BUILD_DATE_UTC}</span>
      <span aria-hidden="true">·</span>
      <span>
        Git SHA {BUILD_GIT_SHA}
        {BUILD_SUFFIX}
      </span>
    </footer>
  );
}
