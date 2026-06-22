# Repository Agent Instructions

## Licensing

- Every source file must carry an `SPDX-License-Identifier: Apache-2.0`
  header using the file format's appropriate comment syntax. Preserve
  shebangs as the first line, and do not alter generated files or vendored
  third-party files.

## Dependency pinning

- Pin and lock every external dependency to immutable content. Record an exact
  commit SHA or artifact digest/checksum in the appropriate lockfile, manifest,
  provenance record, or build definition; a branch name, release name, or
  version tag alone is not an acceptable pin.
- Keep dependency pins and their integrity metadata under version control, and
  update them deliberately in the same change that updates the dependency.
