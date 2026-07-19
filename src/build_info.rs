// SPDX-License-Identifier: Apache-2.0

//! Software build metadata embedded by the package build script.

/// UTC timestamp at which this software artifact was built.
pub const DATE_UTC: &str = env!("NETTLE_BUILD_DATE_UTC");

/// Git commit SHA from which this software artifact was built.
pub const GIT_SHA: &str = env!("NETTLE_BUILD_GIT_SHA");

/// Provenance suffix indicating a dirty tree or a commit outside `main`.
pub const SUFFIX: &str = env!("NETTLE_BUILD_SUFFIX");

/// Detailed version text printed by the CLI.
pub const VERSION: &str = concat!(
    env!("CARGO_PKG_VERSION"),
    "\nbuild date (UTC): ",
    env!("NETTLE_BUILD_DATE_UTC"),
    "\ngit SHA: ",
    env!("NETTLE_BUILD_GIT_SHA"),
    env!("NETTLE_BUILD_SUFFIX"),
);
