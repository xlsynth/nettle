// SPDX-License-Identifier: Apache-2.0

//! Generates Rust Protobuf bindings and build-time resource-limit constants.
#![deny(missing_docs)]

use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use time::OffsetDateTime;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceLimits {
    schema_version: u32,
    bundle: BundleLimits,
    native: NativeLimits,
    browser: BrowserLimits,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleLimits {
    archive: ArchiveLimits,
    protobuf: ProtobufLimits,
    #[serde(rename = "sourcePathComponents")]
    source_path_components: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveLimits {
    eocd_search_bytes: usize,
    entry_path_bytes: usize,
    manifest_bytes: u64,
    entry_count: usize,
    entry_bytes: u64,
    total_bytes: u64,
    compression_ratio: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtobufLimits {
    string_bytes: usize,
    modules: u64,
    sources: u64,
    graph_objects: u64,
    nodes: u64,
    edges: u64,
    groups: u64,
    graph_files: u64,
    ports: u64,
    origins: u64,
    metadata_entries: u64,
    build_items: u64,
    diagnostics: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeLimits {
    builder: BuilderLimits,
    compiler: CompilerLimits,
    filelist: FilelistLimits,
    yosys_import: YosysImportLimits,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuilderLimits {
    source_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompilerLimits {
    error_output_bytes: usize,
    process_output_bytes: usize,
    diagnostics_json_bytes: usize,
    model_json_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilelistLimits {
    depth: usize,
    files: usize,
    bytes: usize,
    tokens: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YosysImportLimits {
    endpoint_pairs: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserLimits {
    cache: BrowserCacheLimits,
    load: BrowserLoadLimits,
    comparison: BrowserComparisonLimits,
    display: BrowserDisplayLimits,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserCacheLimits {
    modules_bytes: usize,
    sources_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserLoadLimits {
    entry_concurrency: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserComparisonLimits {
    source_diff_timeout_ms: usize,
    source_diff_max_edit_length: usize,
    source_diff_concurrency: usize,
    source_mapping_files: usize,
    source_evidence_module_pairs: usize,
    source_evidence_timeout_ms: usize,
    matcher_timeout_ms: usize,
    fuzzy_candidates_per_node: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserDisplayLimits {
    decimal_conversion_bits: usize,
    formattable_constant_bits: usize,
    metadata_depth: usize,
    metadata_nodes: usize,
    metadata_characters: usize,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    emit_build_info()?;

    let schema = "proto/nettle.proto";
    println!("cargo:rerun-if-changed={schema}");
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    config.compile_protos(&[schema], &["proto"])?;

    let limits_path = "resource-limits.yaml";
    println!("cargo:rerun-if-changed={limits_path}");
    let limits: ResourceLimits = serde_yaml_ng::from_str(&fs::read_to_string(limits_path)?)?;
    validate_limits(&limits)?;
    let generated = generate_rust_limits(&limits);
    let output = PathBuf::from(std::env::var("OUT_DIR")?).join("resource_limits.rs");
    fs::write(output, generated)?;
    Ok(())
}

fn emit_build_info() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-env-changed=NETTLE_BUILD_DATE_UTC");
    println!("cargo:rerun-if-env-changed=NETTLE_BUILD_GIT_SHA");
    println!("cargo:rerun-if-env-changed=NETTLE_BUILD_STATE");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    emit_git_rerun_inputs();

    let build_date = match std::env::var("NETTLE_BUILD_DATE_UTC") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            let seconds = match std::env::var("SOURCE_DATE_EPOCH") {
                Ok(value) => value
                    .parse::<u64>()
                    .map_err(|error| format!("invalid SOURCE_DATE_EPOCH {value:?}: {error}"))?,
                Err(_) => SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
            };
            format_unix_timestamp(seconds)?
        }
    };
    let git_sha = match std::env::var("NETTLE_BUILD_GIT_SHA") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            let output = Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .map_err(|error| format!("running git rev-parse HEAD: {error}"))?;
            if !output.status.success() {
                return Err(format!(
                    "git rev-parse HEAD failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )
                .into());
            }
            String::from_utf8(output.stdout)?.trim().to_owned()
        }
    };
    if !matches!(git_sha.len(), 40 | 64)
        || !git_sha
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(
            format!("build Git SHA is not a full hexadecimal object ID: {git_sha:?}").into(),
        );
    }
    let build_state = match std::env::var("NETTLE_BUILD_STATE") {
        Ok(value) => match value.as_str() {
            "clean" | "dev" | "dirty" => value,
            _ => {
                return Err(format!(
                    "NETTLE_BUILD_STATE must be clean, dev, or dirty; got {value:?}"
                )
                .into());
            }
        },
        Err(_) => detect_build_state()?,
    };
    let build_suffix = match build_state.as_str() {
        "dirty" => " (dirty)",
        "dev" => " (dev branch)",
        "clean" => "",
        _ => unreachable!("build state was validated above"),
    };

    println!("cargo:rustc-env=NETTLE_BUILD_DATE_UTC={build_date}");
    println!("cargo:rustc-env=NETTLE_BUILD_GIT_SHA={git_sha}");
    println!("cargo:rustc-env=NETTLE_BUILD_SUFFIX={build_suffix}");
    Ok(())
}

fn emit_git_rerun_inputs() {
    for path in ["HEAD", "index", "packed-refs"] {
        emit_git_path_rerun_input(path);
    }

    if let Some(reference) = git_stdout(&["symbolic-ref", "--quiet", "HEAD"]) {
        emit_git_path_rerun_input(reference.trim());
    }

    if let Ok(output) = Command::new("git")
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .output()
        && output.status.success()
    {
        for path in output.stdout.split(|byte| *byte == 0) {
            if !path.is_empty() {
                println!("cargo:rerun-if-changed={}", String::from_utf8_lossy(path));
            }
        }
    }
}

fn emit_git_path_rerun_input(path: &str) {
    if let Some(path) = git_stdout(&["rev-parse", "--git-path", path]) {
        println!("cargo:rerun-if-changed={}", path.trim());
    }
}

fn git_stdout(arguments: &[&str]) -> Option<String> {
    let output = Command::new("git").args(arguments).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn detect_build_state() -> Result<String, Box<dyn std::error::Error>> {
    let status = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=normal"])
        .output()
        .map_err(|error| format!("running git status: {error}"))?;
    if !status.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&status.stderr).trim()
        )
        .into());
    }
    if !status.stdout.is_empty() {
        return Ok("dirty".to_owned());
    }

    let containing_refs = Command::new("git")
        .args([
            "for-each-ref",
            "--contains",
            "HEAD",
            "--format=%(refname)",
            "refs/heads/main",
            "refs/remotes",
        ])
        .output()
        .map_err(|error| format!("finding main refs containing HEAD: {error}"))?;
    if !containing_refs.status.success() {
        return Err(format!(
            "finding main refs containing HEAD failed: {}",
            String::from_utf8_lossy(&containing_refs.stderr).trim()
        )
        .into());
    }
    let is_on_main = String::from_utf8(containing_refs.stdout)?
        .lines()
        .any(|reference| reference == "refs/heads/main" || reference.ends_with("/main"));
    Ok(if is_on_main { "clean" } else { "dev" }.to_owned())
}

fn format_unix_timestamp(seconds: u64) -> Result<String, Box<dyn std::error::Error>> {
    let timestamp = OffsetDateTime::from_unix_timestamp(i64::try_from(seconds)?)?;
    let format = time::format_description::parse("[year]-[month]-[day]T[hour]:[minute]:[second]Z")?;
    Ok(timestamp.format(&format)?)
}

fn validate_limits(limits: &ResourceLimits) -> Result<(), Box<dyn std::error::Error>> {
    if limits.schema_version != 1 {
        return Err(format!(
            "unsupported resource-limits.yaml schema version {}",
            limits.schema_version
        )
        .into());
    }
    let positive_values = [
        limits.bundle.archive.eocd_search_bytes as u64,
        limits.bundle.archive.entry_path_bytes as u64,
        limits.bundle.archive.manifest_bytes,
        limits.bundle.archive.entry_count as u64,
        limits.bundle.archive.entry_bytes,
        limits.bundle.archive.total_bytes,
        limits.bundle.archive.compression_ratio,
        limits.bundle.protobuf.string_bytes as u64,
        limits.bundle.protobuf.modules,
        limits.bundle.protobuf.sources,
        limits.bundle.protobuf.graph_objects,
        limits.bundle.protobuf.nodes,
        limits.bundle.protobuf.edges,
        limits.bundle.protobuf.groups,
        limits.bundle.protobuf.graph_files,
        limits.bundle.protobuf.ports,
        limits.bundle.protobuf.origins,
        limits.bundle.protobuf.metadata_entries,
        limits.bundle.protobuf.build_items,
        limits.bundle.protobuf.diagnostics,
        limits.bundle.source_path_components as u64,
        limits.native.builder.source_bytes,
        limits.native.compiler.error_output_bytes as u64,
        limits.native.compiler.process_output_bytes as u64,
        limits.native.compiler.diagnostics_json_bytes as u64,
        limits.native.compiler.model_json_bytes as u64,
        limits.native.filelist.depth as u64,
        limits.native.filelist.files as u64,
        limits.native.filelist.bytes as u64,
        limits.native.filelist.tokens as u64,
        limits.native.yosys_import.endpoint_pairs as u64,
        limits.browser.cache.modules_bytes as u64,
        limits.browser.cache.sources_bytes as u64,
        limits.browser.load.entry_concurrency as u64,
        limits.browser.comparison.source_diff_timeout_ms as u64,
        limits.browser.comparison.source_diff_max_edit_length as u64,
        limits.browser.comparison.source_diff_concurrency as u64,
        limits.browser.comparison.source_mapping_files as u64,
        limits.browser.comparison.source_evidence_module_pairs as u64,
        limits.browser.comparison.source_evidence_timeout_ms as u64,
        limits.browser.comparison.matcher_timeout_ms as u64,
        limits.browser.comparison.fuzzy_candidates_per_node as u64,
        limits.browser.display.decimal_conversion_bits as u64,
        limits.browser.display.formattable_constant_bits as u64,
        limits.browser.display.metadata_depth as u64,
        limits.browser.display.metadata_nodes as u64,
        limits.browser.display.metadata_characters as u64,
    ];
    if positive_values.contains(&0) {
        return Err("resource limits must be positive".into());
    }
    if limits.bundle.archive.manifest_bytes > limits.bundle.archive.entry_bytes
        || limits.bundle.archive.entry_bytes > limits.bundle.archive.total_bytes
    {
        return Err("bundle archive byte limits must be monotonically increasing".into());
    }
    if limits.native.builder.source_bytes > limits.bundle.archive.entry_bytes {
        return Err("native source byte limit cannot exceed bundle entry byte limit".into());
    }
    if limits.bundle.protobuf.string_bytes as u64 > limits.bundle.archive.entry_bytes {
        return Err("Protobuf string byte limit cannot exceed bundle entry byte limit".into());
    }
    let minimum_archive_entries = limits
        .bundle
        .protobuf
        .modules
        .checked_add(limits.bundle.protobuf.sources)
        .and_then(|value| value.checked_add(4))
        .ok_or("bundle entry-count requirement overflowed")?;
    if (limits.bundle.archive.entry_count as u64) < minimum_archive_entries {
        return Err(
            "bundle archive entry limit must accommodate module and source slices plus four fixed entries"
                .into(),
        );
    }
    if limits.native.compiler.error_output_bytes > limits.native.compiler.process_output_bytes {
        return Err("compiler error display limit cannot exceed captured output limit".into());
    }
    if limits.bundle.archive.eocd_search_bytes < 65_557 {
        return Err("ZIP EOCD search limit must cover the maximum ZIP comment".into());
    }
    Ok(())
}

fn generate_rust_limits(limits: &ResourceLimits) -> String {
    let mut output = String::from(
        "// SPDX-License-Identifier: Apache-2.0\n\n// @generated from resource-limits.yaml. Do not edit directly.\n\n",
    );
    let archive = &limits.bundle.archive;
    let protobuf = &limits.bundle.protobuf;
    let native = &limits.native;
    let browser = &limits.browser;
    writeln!(
        output,
        "pub(crate) mod bundle {{\n    pub(crate) mod archive {{\n        pub(crate) const ENTRY_PATH_BYTES: usize = {};\n        pub(crate) const MANIFEST_BYTES: u64 = {};\n        pub(crate) const ENTRY_COUNT: usize = {};\n        pub(crate) const ENTRY_BYTES: u64 = {};\n        pub(crate) const TOTAL_BYTES: u64 = {};\n        pub(crate) const COMPRESSION_RATIO: u64 = {};\n    }}\n    pub(crate) mod protobuf {{\n        pub(crate) const STRING_BYTES: usize = {};\n        pub(crate) const MODULES: u64 = {};\n        pub(crate) const SOURCES: u64 = {};\n        pub(crate) const GRAPH_OBJECTS: u64 = {};\n        pub(crate) const NODES: u64 = {};\n        pub(crate) const EDGES: u64 = {};\n        pub(crate) const GROUPS: u64 = {};\n        pub(crate) const GRAPH_FILES: u64 = {};\n        pub(crate) const PORTS: u64 = {};\n        pub(crate) const ORIGINS: u64 = {};\n        pub(crate) const METADATA_ENTRIES: u64 = {};\n        pub(crate) const BUILD_ITEMS: u64 = {};\n        pub(crate) const DIAGNOSTICS: u64 = {};\n    }}\n    pub(crate) const SOURCE_PATH_COMPONENTS: usize = {};\n}}",
        archive.entry_path_bytes,
        archive.manifest_bytes,
        archive.entry_count,
        archive.entry_bytes,
        archive.total_bytes,
        archive.compression_ratio,
        protobuf.string_bytes,
        protobuf.modules,
        protobuf.sources,
        protobuf.graph_objects,
        protobuf.nodes,
        protobuf.edges,
        protobuf.groups,
        protobuf.graph_files,
        protobuf.ports,
        protobuf.origins,
        protobuf.metadata_entries,
        protobuf.build_items,
        protobuf.diagnostics,
        limits.bundle.source_path_components,
    )
    .expect("writing to String cannot fail");
    writeln!(
        output,
        "pub(crate) mod native {{\n    pub(crate) mod builder {{ pub(crate) const SOURCE_BYTES: u64 = {}; }}\n    pub(crate) mod compiler {{\n        pub(crate) const ERROR_OUTPUT_BYTES: usize = {};\n        pub(crate) const PROCESS_OUTPUT_BYTES: usize = {};\n        pub(crate) const DIAGNOSTICS_JSON_BYTES: usize = {};\n        pub(crate) const MODEL_JSON_BYTES: usize = {};\n    }}\n    pub(crate) mod filelist {{\n        pub(crate) const DEPTH: usize = {};\n        pub(crate) const FILES: usize = {};\n        pub(crate) const BYTES: usize = {};\n        pub(crate) const TOKENS: usize = {};\n    }}\n    pub(crate) mod yosys_import {{ pub(crate) const ENDPOINT_PAIRS: usize = {}; }}\n}}",
        native.builder.source_bytes,
        native.compiler.error_output_bytes,
        native.compiler.process_output_bytes,
        native.compiler.diagnostics_json_bytes,
        native.compiler.model_json_bytes,
        native.filelist.depth,
        native.filelist.files,
        native.filelist.bytes,
        native.filelist.tokens,
        native.yosys_import.endpoint_pairs,
    )
    .expect("writing to String cannot fail");
    writeln!(
        output,
        "#[allow(dead_code)]\npub(crate) mod browser {{\n    pub(crate) mod cache {{\n        pub(crate) const MODULES_BYTES: usize = {};\n        pub(crate) const SOURCES_BYTES: usize = {};\n    }}\n    pub(crate) mod load {{ pub(crate) const ENTRY_CONCURRENCY: usize = {}; }}\n    pub(crate) mod comparison {{\n        pub(crate) const SOURCE_DIFF_TIMEOUT_MS: usize = {};\n        pub(crate) const SOURCE_DIFF_MAX_EDIT_LENGTH: usize = {};\n        pub(crate) const SOURCE_DIFF_CONCURRENCY: usize = {};\n        pub(crate) const SOURCE_MAPPING_FILES: usize = {};\n        pub(crate) const SOURCE_EVIDENCE_MODULE_PAIRS: usize = {};\n        pub(crate) const SOURCE_EVIDENCE_TIMEOUT_MS: usize = {};\n        pub(crate) const FUZZY_CANDIDATES_PER_NODE: usize = {};\n    }}\n    pub(crate) mod display {{\n        pub(crate) const DECIMAL_CONVERSION_BITS: usize = {};\n        pub(crate) const FORMATTABLE_CONSTANT_BITS: usize = {};\n        pub(crate) const METADATA_DEPTH: usize = {};\n        pub(crate) const METADATA_NODES: usize = {};\n        pub(crate) const METADATA_CHARACTERS: usize = {};\n    }}\n}}",
        browser.cache.modules_bytes,
        browser.cache.sources_bytes,
        browser.load.entry_concurrency,
        browser.comparison.source_diff_timeout_ms,
        browser.comparison.source_diff_max_edit_length,
        browser.comparison.source_diff_concurrency,
        browser.comparison.source_mapping_files,
        browser.comparison.source_evidence_module_pairs,
        browser.comparison.source_evidence_timeout_ms,
        browser.comparison.fuzzy_candidates_per_node,
        browser.display.decimal_conversion_bits,
        browser.display.formattable_constant_bits,
        browser.display.metadata_depth,
        browser.display.metadata_nodes,
        browser.display.metadata_characters,
    )
    .expect("writing to String cannot fail");
    output
}
