// SPDX-License-Identifier: Apache-2.0

//! Build-time resource limits generated from `resource-limits.yaml`.
//!
//! The generated constants are intentionally not runtime configurable. Bundle
//! limits form a compatibility and security contract with the browser reader.

include!(concat!(env!("OUT_DIR"), "/resource_limits.rs"));
