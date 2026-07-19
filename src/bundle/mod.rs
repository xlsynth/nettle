// SPDX-License-Identifier: Apache-2.0

//! Writes and validates deterministic `.nettle` bundles.

/// Generated Protobuf messages for bundle format major version 1.
#[allow(missing_docs)]
pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/nettle.bundle.v1.rs"));
}

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Seek, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::ir::{
    DesignSnapshot, Diagnostic, DiagnosticSeverity, GraphEdge, GraphGroup, GraphModule, GraphNode,
    GraphPort, GraphSlice, NodeKind, PortDirection, SourceElaborationRange, SourceFileRef,
    SourceOrigin,
};
use crate::resource_limits::bundle::SOURCE_PATH_COMPONENTS as MAX_SOURCE_PATH_COMPONENTS;
use crate::resource_limits::bundle::archive::{
    COMPRESSION_RATIO as MAX_COMPRESSION_RATIO, ENTRY_BYTES as MAX_ENTRY_BYTES,
    ENTRY_COUNT as MAX_ENTRY_COUNT, ENTRY_PATH_BYTES as MAX_ENTRY_PATH_BYTES,
    MANIFEST_BYTES as MAX_MANIFEST_BYTES, TOTAL_BYTES as MAX_TOTAL_BYTES,
};
use crate::resource_limits::bundle::protobuf::{
    BUILD_ITEMS as MAX_BUILD_ITEMS, DIAGNOSTICS as MAX_DIAGNOSTICS, EDGES as MAX_EDGES,
    GRAPH_FILES as MAX_GRAPH_FILES, GRAPH_OBJECTS as MAX_GRAPH_OBJECTS, GROUPS as MAX_GROUPS,
    METADATA_ENTRIES as MAX_METADATA_ENTRIES, MODULES as MAX_MODULES, NODES as MAX_NODES,
    ORIGINS as MAX_ORIGINS, PORTS as MAX_PORTS, SOURCES as MAX_SOURCES,
    STRING_BYTES as MAX_STRING_BYTES,
};
use prost::Message;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// Bundle format major version understood by this implementation.
pub const FORMAT_MAJOR: u32 = 1;
/// Bundle format minor version written by this implementation.
pub const FORMAT_MINOR: u32 = 1;
/// Canonical ZIP path of the JSON manifest.
pub const MANIFEST_ENTRY: &str = "manifest.json";
/// Canonical ZIP path of the Protobuf design index.
pub const DESIGN_INDEX_ENTRY: &str = "design/index.pb";
/// Canonical ZIP path of the Protobuf source index.
pub const SOURCE_INDEX_ENTRY: &str = "sources/index.pb";
/// Canonical ZIP path of the Protobuf diagnostics collection.
pub const DIAGNOSTICS_ENTRY: &str = "diagnostics.pb";

const SUPPORTED_FEATURES: &[&str] = &["debugArtifacts"];
static OUTPUT_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
/// Error returned while writing, opening, or validating a `.nettle` bundle.
pub enum BundleError {
    /// Underlying filesystem or stream operation failed.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    /// ZIP structure or compression processing failed.
    #[error("ZIP error: {0}")]
    Zip(#[from] zip::result::ZipError),
    /// The JSON manifest could not be decoded.
    #[error("invalid manifest JSON: {0}")]
    ManifestJson(#[from] serde_json::Error),
    /// A declared Protobuf payload could not be decoded.
    #[error("invalid Protobuf in {entry}: {source}")]
    Protobuf {
        /// Bundle entry containing the malformed payload.
        entry: String,
        #[source]
        /// Protobuf decoder error.
        source: prost::DecodeError,
    },
    /// The bundle requires an unsupported format version.
    #[error("unsupported .nettle format {major}.{minor}; this build reads major {FORMAT_MAJOR}")]
    UnsupportedVersion {
        /// Unsupported major version.
        major: u32,
        /// Minor version accompanying the unsupported major version.
        minor: u32,
    },
    /// A structural, integrity, compatibility, or resource-limit check failed.
    #[error("invalid bundle: {0}")]
    Invalid(String),
}

/// Result type returned by bundle operations.
pub type Result<T> = std::result::Result<T, BundleError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Semantic version of the `.nettle` interchange format.
pub struct FormatVersion {
    /// Compatibility-breaking format generation.
    pub major: u32,
    /// Additive format revision within a major generation.
    pub minor: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Tool identity recorded as the producer of a bundle.
pub struct Producer {
    /// Producer application name.
    pub name: String,
    /// Producer application version.
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Manifest integrity and storage metadata for one ZIP entry.
pub struct ManifestEntry {
    /// Canonical relative entry path.
    pub path: String,
    /// Lowercase SHA-256 digest of the uncompressed payload.
    pub sha256: String,
    /// Uncompressed payload size in bytes.
    pub size: u64,
    /// ZIP compression method required for the entry.
    pub compression: EntryCompression,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Supported per-entry ZIP compression modes.
pub enum EntryCompression {
    /// Store bytes without compression for efficient random access.
    Stored,
    /// Compress bytes using the DEFLATE algorithm.
    Deflate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Root JSON metadata and exact entry inventory for a `.nettle` bundle.
pub struct Manifest {
    /// Interchange format version.
    pub format_version: FormatVersion,
    /// Application that produced the bundle.
    pub producer: Producer,
    /// Stable identity of the elaborated design snapshot.
    pub snapshot_id: String,
    /// Selected top module name.
    pub top: String,
    /// Entry containing the design index.
    pub design_index: String,
    /// Entry containing the source index.
    pub source_index: String,
    /// Entry containing normalized diagnostics.
    pub diagnostics: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    /// Optional format features required to interpret the bundle.
    pub features: Vec<String>,
    /// Complete sorted inventory of non-manifest entries.
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Referenced source file prepared for content-addressed bundle storage.
pub struct BundleSource {
    /// Stable source identifier used by graph provenance.
    pub id: String,
    /// Project-root-relative display path.
    pub path: String,
    /// UTF-8 source bytes.
    pub contents: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Safe compiler identity persisted in build metadata.
pub struct ToolMetadata {
    /// Compiler name.
    pub name: String,
    /// Sanitized executable basename rather than a host path.
    pub path: String,
    /// Compiler-reported version string.
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
/// Effective elaboration configuration and compiler provenance.
pub struct BuildMetadata {
    /// Project-relative root filelist path.
    pub filelist: String,
    /// Effective top-level parameter overrides.
    pub parameters: Vec<(String, String)>,
    /// Effective preprocessor definitions and their optional values.
    pub defines: Vec<(String, Option<String>)>,
    /// Effective preprocessor undefinitions.
    pub undefines: Vec<String>,
    /// Compilers used to produce the snapshot.
    pub tools: Vec<ToolMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Opt-in raw compiler output stored beneath the bundle's `debug/` namespace.
pub struct DebugArtifact {
    /// Path relative to the `debug/` namespace.
    pub name: String,
    /// Artifact bytes.
    pub contents: Vec<u8>,
}

/// Borrowed inputs required to encode a complete `.nettle` bundle.
pub struct BundleContents<'a> {
    /// Compiler-neutral elaborated design.
    pub snapshot: &'a DesignSnapshot,
    /// Referenced source files.
    pub sources: &'a [BundleSource],
    /// Normalized compiler diagnostics.
    pub diagnostics: &'a [Diagnostic],
    /// Effective build inputs and compiler provenance.
    pub build: &'a BuildMetadata,
    /// Optional privacy-sensitive raw compiler artifacts.
    pub debug_artifacts: &'a [DebugArtifact],
}

#[derive(Debug)]
struct PendingEntry {
    bytes: Vec<u8>,
    compression: EntryCompression,
}

/// Atomically writes a deterministic bundle to `path` and returns its manifest.
pub fn write_bundle(path: &Path, contents: &BundleContents<'_>) -> Result<Manifest> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| BundleError::Invalid("output bundle has no file name".to_owned()))?;
    let mut temporary_name = OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        OUTPUT_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let temporary_path = parent.join(temporary_name);
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)?;
        let manifest = write_bundle_to(&mut file, contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary_path, path)?;
        Ok(manifest)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

/// Encodes a deterministic bundle into an arbitrary seekable writer.
pub fn write_bundle_to<W: Write + Seek>(
    writer: W,
    contents: &BundleContents<'_>,
) -> Result<Manifest> {
    let mut entries = BTreeMap::<String, PendingEntry>::new();

    let mut modules = Vec::with_capacity(contents.snapshot.modules.len());
    for slice in contents.snapshot.modules.values() {
        validate_graph_origin_budget(slice, MAX_ORIGINS)?;
        let entry = format!("design/modules/{}.pb", slice.module.id);
        insert_entry(
            &mut entries,
            entry.clone(),
            proto::GraphSlice::from(slice).encode_to_vec(),
            EntryCompression::Stored,
        )?;
        modules.push(proto::ModuleSummary {
            id: slice.module.id.clone(),
            name: slice.module.name.clone(),
            definition_name: slice.module.definition_name.clone(),
            instance_path: slice.module.instance_path.clone(),
            node_count: slice.nodes.len() as u64,
            edge_count: slice.edges.len() as u64,
            entry,
        });
    }
    modules.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    let design_index = proto::DesignIndex {
        schema_major: FORMAT_MAJOR,
        schema_minor: FORMAT_MINOR,
        snapshot_id: contents.snapshot.snapshot_id.clone(),
        top: contents.snapshot.top.clone(),
        tops: contents.snapshot.tops.clone(),
        modules,
        build: Some(proto_build_metadata(contents.build)),
    };
    insert_entry(
        &mut entries,
        DESIGN_INDEX_ENTRY.to_owned(),
        design_index.encode_to_vec(),
        EntryCompression::Stored,
    )?;

    let mut source_payloads = BTreeMap::<String, Vec<u8>>::new();
    let mut source_files = Vec::with_capacity(contents.sources.len());
    for source in contents.sources {
        validate_relative_path(&source.path)?;
        let digest = sha256(&source.contents);
        let entry = format!("sources/{digest}");
        source_payloads
            .entry(entry.clone())
            .or_insert_with(|| source.contents.clone());
        source_files.push(proto::SourceFile {
            id: source.id.clone(),
            path: source.path.clone(),
            entry,
            sha256: digest,
            size: source.contents.len() as u64,
            elaboration_ranges: vec![],
        });
    }
    source_files.sort_by(|left, right| left.path.cmp(&right.path).then(left.id.cmp(&right.id)));
    for (entry, bytes) in source_payloads {
        insert_entry(&mut entries, entry, bytes, EntryCompression::Deflate)?;
    }
    insert_entry(
        &mut entries,
        SOURCE_INDEX_ENTRY.to_owned(),
        proto::SourceIndex {
            files: source_files,
        }
        .encode_to_vec(),
        EntryCompression::Stored,
    )?;

    let diagnostics = proto::Diagnostics {
        diagnostics: contents.diagnostics.iter().map(Into::into).collect(),
    };
    insert_entry(
        &mut entries,
        DIAGNOSTICS_ENTRY.to_owned(),
        diagnostics.encode_to_vec(),
        EntryCompression::Stored,
    )?;

    for artifact in contents.debug_artifacts {
        validate_debug_name(&artifact.name)?;
        insert_entry(
            &mut entries,
            format!("debug/{}", artifact.name),
            artifact.contents.clone(),
            EntryCompression::Deflate,
        )?;
    }

    let manifest_entries = entries
        .iter()
        .map(|(path, entry)| ManifestEntry {
            path: path.clone(),
            sha256: sha256(&entry.bytes),
            size: entry.bytes.len() as u64,
            compression: entry.compression,
        })
        .collect();
    let manifest = Manifest {
        format_version: FormatVersion {
            major: FORMAT_MAJOR,
            minor: FORMAT_MINOR,
        },
        producer: Producer {
            name: "nettle".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        },
        snapshot_id: contents.snapshot.snapshot_id.clone(),
        top: contents.snapshot.top.clone(),
        design_index: DESIGN_INDEX_ENTRY.to_owned(),
        source_index: SOURCE_INDEX_ENTRY.to_owned(),
        diagnostics: DIAGNOSTICS_ENTRY.to_owned(),
        features: if contents.debug_artifacts.is_empty() {
            Vec::new()
        } else {
            vec!["debugArtifacts".to_owned()]
        },
        entries: manifest_entries,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(BundleError::Invalid(
            "manifest exceeds size limit".to_owned(),
        ));
    }
    entries.insert(
        MANIFEST_ENTRY.to_owned(),
        PendingEntry {
            bytes: manifest_bytes,
            compression: EntryCompression::Stored,
        },
    );

    let mut zip = ZipWriter::new(writer);
    for (path, entry) in entries {
        let method = match entry.compression {
            EntryCompression::Stored => CompressionMethod::Stored,
            EntryCompression::Deflate => CompressionMethod::Deflated,
        };
        let options = FileOptions::default()
            .compression_method(method)
            .last_modified_time(zip::DateTime::default())
            .unix_permissions(0o644);
        zip.start_file(path, options)?;
        zip.write_all(&entry.bytes)?;
    }
    zip.finish()?;
    Ok(manifest)
}

/// Validating random-access reader for a `.nettle` ZIP archive.
pub struct BundleReader<R: Read + Seek> {
    archive: ZipArchive<R>,
    manifest: Manifest,
    declared: BTreeMap<String, ManifestEntry>,
}

impl BundleReader<File> {
    /// Opens and preflights a bundle stored at `path`.
    pub fn open(path: &Path) -> Result<Self> {
        Self::new(File::open(path)?)
    }
}

impl BundleReader<Cursor<Vec<u8>>> {
    /// Opens and preflights a bundle held entirely in memory.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self> {
        Self::new(Cursor::new(bytes))
    }
}

impl<R: Read + Seek> BundleReader<R> {
    /// Opens and preflights a bundle from a seekable reader.
    pub fn new(reader: R) -> Result<Self> {
        let mut archive = ZipArchive::new(reader)?;
        preflight_archive(&mut archive)?;
        let manifest_bytes = read_zip_entry(&mut archive, MANIFEST_ENTRY, MAX_MANIFEST_BYTES)?;
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
        if manifest.format_version.major != FORMAT_MAJOR {
            return Err(BundleError::UnsupportedVersion {
                major: manifest.format_version.major,
                minor: manifest.format_version.minor,
            });
        }
        if let Some(feature) = manifest
            .features
            .iter()
            .find(|feature| !SUPPORTED_FEATURES.contains(&feature.as_str()))
        {
            return Err(BundleError::Invalid(format!(
                "bundle requires unsupported feature {feature}"
            )));
        }
        if manifest.snapshot_id.is_empty() || manifest.top.is_empty() {
            return Err(BundleError::Invalid(
                "manifest snapshotId and top must be non-empty".to_owned(),
            ));
        }
        let mut declared = BTreeMap::new();
        for entry in &manifest.entries {
            validate_entry_name(&entry.path)?;
            if entry.path == MANIFEST_ENTRY {
                return Err(BundleError::Invalid(
                    "manifest must not declare itself".to_owned(),
                ));
            }
            if entry.size > MAX_ENTRY_BYTES {
                return Err(BundleError::Invalid(format!(
                    "entry {} exceeds size limit",
                    entry.path
                )));
            }
            let actual_compression = archive.by_name(&entry.path)?.compression();
            let declared_compression = match entry.compression {
                EntryCompression::Stored => CompressionMethod::Stored,
                EntryCompression::Deflate => CompressionMethod::Deflated,
            };
            if actual_compression != declared_compression {
                return Err(BundleError::Invalid(format!(
                    "entry {} compression does not match manifest",
                    entry.path
                )));
            }
            if declared.insert(entry.path.clone(), entry.clone()).is_some() {
                return Err(BundleError::Invalid(format!(
                    "manifest declares duplicate entry {}",
                    entry.path
                )));
            }
        }
        for required in [
            manifest.design_index.as_str(),
            manifest.source_index.as_str(),
            manifest.diagnostics.as_str(),
        ] {
            if !declared.contains_key(required) {
                return Err(BundleError::Invalid(format!(
                    "manifest does not declare required entry {required}"
                )));
            }
        }
        let archive_names: BTreeSet<String> = (0..archive.len())
            .map(|index| archive.by_index(index).map(|file| file.name().to_owned()))
            .collect::<std::result::Result<_, _>>()?;
        let expected: BTreeSet<String> = declared
            .keys()
            .cloned()
            .chain(std::iter::once(MANIFEST_ENTRY.to_owned()))
            .collect();
        if archive_names != expected {
            return Err(BundleError::Invalid(
                "archive entries do not exactly match the manifest".to_owned(),
            ));
        }
        Ok(Self {
            archive,
            manifest,
            declared,
        })
    }

    /// Returns the already validated manifest.
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// Decodes and verifies the design index.
    pub fn design_index(&mut self) -> Result<proto::DesignIndex> {
        let entry = self.manifest.design_index.clone();
        self.decode(&entry)
    }

    /// Decodes and verifies the source index.
    pub fn source_index(&mut self) -> Result<proto::SourceIndex> {
        let entry = self.manifest.source_index.clone();
        let mut index: proto::SourceIndex = self.decode(&entry)?;
        normalize_legacy_source_elaboration_ranges(&mut index.files)?;
        Ok(index)
    }

    /// Decodes and verifies normalized diagnostics.
    pub fn diagnostics(&mut self) -> Result<Vec<Diagnostic>> {
        let entry = self.manifest.diagnostics.clone();
        let diagnostics: proto::Diagnostics = self.decode(&entry)?;
        diagnostics
            .diagnostics
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    /// Decodes and verifies one declared module graph entry.
    pub fn graph_slice(&mut self, entry: &str) -> Result<GraphSlice> {
        validate_module_entry(entry)?;
        let value: proto::GraphSlice = self.decode(entry)?;
        value.try_into()
    }

    /// Reads and verifies one declared source entry.
    pub fn source(&mut self, entry: &str) -> Result<Vec<u8>> {
        if !entry.starts_with("sources/") {
            return Err(BundleError::Invalid(format!(
                "source entry has invalid path {entry:?}"
            )));
        }
        self.read_verified(entry)
    }

    /// Verifies every declared payload and all cross-index consistency rules.
    pub fn validate_all(&mut self) -> Result<()> {
        let paths: Vec<String> = self.declared.keys().cloned().collect();
        for path in paths {
            self.read_verified(&path)?;
        }
        let index = self.design_index()?;
        if index.schema_major != FORMAT_MAJOR
            || index.snapshot_id != self.manifest.snapshot_id
            || index.top != self.manifest.top
        {
            return Err(BundleError::Invalid(
                "design index identity does not match manifest".to_owned(),
            ));
        }
        validate_module_identities(&index.modules)?;
        let sources = self.source_index()?;
        validate_source_identities(&sources.files)?;
        for source in &sources.files {
            let bytes = self.source(&source.entry)?;
            if bytes.len() as u64 != source.size || sha256(&bytes) != source.sha256 {
                return Err(BundleError::Invalid(format!(
                    "source index does not match {}",
                    source.entry
                )));
            }
        }
        for module in &index.modules {
            let slice = self.graph_slice(&module.entry)?;
            validate_module_index_entry(&index.snapshot_id, module, &slice)?;
            validate_graph_references(&slice, &index.modules, &sources.files)?;
        }
        let _ = self.diagnostics()?;
        Ok(())
    }

    fn decode<M: Message + Default>(&mut self, entry: &str) -> Result<M> {
        let bytes = self.read_verified(entry)?;
        preflight_protobuf(entry, &bytes)?;
        M::decode(bytes.as_slice()).map_err(|source| BundleError::Protobuf {
            entry: entry.to_owned(),
            source,
        })
    }

    fn read_verified(&mut self, path: &str) -> Result<Vec<u8>> {
        let declaration = self.declared.get(path).cloned().ok_or_else(|| {
            BundleError::Invalid(format!("entry {path:?} is not declared by manifest"))
        })?;
        let bytes = read_zip_entry(&mut self.archive, path, declaration.size)?;
        if bytes.len() as u64 != declaration.size {
            return Err(BundleError::Invalid(format!(
                "entry {path} size does not match manifest"
            )));
        }
        if sha256(&bytes) != declaration.sha256 {
            return Err(BundleError::Invalid(format!(
                "entry {path} digest does not match manifest"
            )));
        }
        Ok(bytes)
    }
}

fn validate_module_identities(modules: &[proto::ModuleSummary]) -> Result<()> {
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut entries = BTreeSet::new();
    for module in modules {
        if !ids.insert(module.id.as_str()) {
            return Err(BundleError::Invalid(format!(
                "duplicate module id {:?}",
                module.id
            )));
        }
        if !names.insert(module.name.as_str()) {
            return Err(BundleError::Invalid(format!(
                "duplicate module name {:?}",
                module.name
            )));
        }
        if !entries.insert(module.entry.as_str()) {
            return Err(BundleError::Invalid(format!(
                "duplicate module entry {:?}",
                module.entry
            )));
        }
    }
    Ok(())
}

fn validate_module_index_entry(
    snapshot_id: &str,
    module: &proto::ModuleSummary,
    slice: &GraphSlice,
) -> Result<()> {
    if slice.snapshot_id != snapshot_id {
        return Err(BundleError::Invalid(format!(
            "module slice {} snapshot identity does not match design index",
            module.entry
        )));
    }
    if slice.module.id != module.id
        || slice.module.name != module.name
        || slice.nodes.len() as u64 != module.node_count
        || slice.edges.len() as u64 != module.edge_count
    {
        return Err(BundleError::Invalid(format!(
            "module index does not match {}",
            module.entry
        )));
    }
    Ok(())
}

fn validate_source_identities(sources: &[proto::SourceFile]) -> Result<()> {
    let mut ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for source in sources {
        validate_relative_path(&source.path)?;
        if !ids.insert(source.id.as_str()) {
            return Err(BundleError::Invalid(format!(
                "duplicate source id {:?}",
                source.id
            )));
        }
        if !paths.insert(source.path.as_str()) {
            return Err(BundleError::Invalid(format!(
                "duplicate source path {:?}",
                source.path
            )));
        }
        for range in &source.elaboration_ranges {
            validate_legacy_source_elaboration_range_path(&source.path, &range.file)?;
            validate_elaboration_coordinates(range).map_err(|_| {
                BundleError::Invalid(format!(
                    "source {:?} has an invalid legacy elaboration range",
                    source.path
                ))
            })?;
        }
    }
    Ok(())
}

fn validate_legacy_source_elaboration_range_path(
    source_path: &str,
    range_path: &str,
) -> Result<()> {
    if !range_path.is_empty() && range_path != source_path {
        return Err(BundleError::Invalid(format!(
            "source {source_path:?} has a legacy elaboration range for mismatched file {range_path:?}"
        )));
    }
    Ok(())
}

fn normalize_legacy_source_elaboration_ranges(sources: &mut [proto::SourceFile]) -> Result<()> {
    for source in sources {
        for range in &mut source.elaboration_ranges {
            validate_legacy_source_elaboration_range_path(&source.path, &range.file)?;
            range.file.clone_from(&source.path);
        }
    }
    Ok(())
}

fn validate_elaboration_coordinates(range: &proto::SourceElaborationRange) -> Result<()> {
    if range.start_line == 0
        || range.start_column == 0
        || range.end_line == 0
        || range.end_column == 0
        || range.end_line < range.start_line
        || (range.end_line == range.start_line && range.end_column <= range.start_column)
    {
        return Err(BundleError::Invalid(
            "invalid source elaboration coordinates".to_owned(),
        ));
    }
    Ok(())
}

fn validate_graph_origin_budget(slice: &GraphSlice, maximum: u64) -> Result<()> {
    let origin_count = slice
        .nodes
        .iter()
        .map(|node| node.origins.len() as u64)
        .chain(slice.edges.iter().map(|edge| edge.origins.len() as u64))
        .chain(slice.groups.iter().map(|group| group.origins.len() as u64))
        .fold(0_u64, u64::saturating_add);
    let count = origin_count.saturating_add(slice.elaboration_ranges.len() as u64);
    if count > maximum {
        return Err(BundleError::Invalid(format!(
            "graph origin and elaboration range count exceeds supported limit {maximum}"
        )));
    }
    Ok(())
}

fn validate_graph_references(
    slice: &GraphSlice,
    modules: &[proto::ModuleSummary],
    sources: &[proto::SourceFile],
) -> Result<()> {
    let mut nodes = BTreeMap::<&str, BTreeSet<&str>>::new();
    for node in &slice.nodes {
        let mut ports = BTreeSet::new();
        for port in &node.ports {
            if !ports.insert(port.id.as_str()) {
                return Err(BundleError::Invalid(format!(
                    "node {:?} has duplicate port id {:?}",
                    node.id, port.id
                )));
            }
        }
        if nodes.insert(node.id.as_str(), ports).is_some() {
            return Err(BundleError::Invalid(format!(
                "duplicate graph node id {:?}",
                node.id
            )));
        }
        if node.kind == NodeKind::ModuleInstance {
            let definition = node.definition_name.as_deref().ok_or_else(|| {
                BundleError::Invalid(format!(
                    "module instance {:?} has no definition name",
                    node.id
                ))
            })?;
            if !modules
                .iter()
                .any(|module| module.name == definition || module.definition_name == definition)
            {
                return Err(BundleError::Invalid(format!(
                    "module instance {:?} references missing definition {:?}",
                    node.id, definition
                )));
            }
        }
    }

    let mut edge_ids = BTreeSet::new();
    for edge in &slice.edges {
        if !edge_ids.insert(edge.id.as_str()) {
            return Err(BundleError::Invalid(format!(
                "duplicate graph edge id {:?}",
                edge.id
            )));
        }
        for (side, node_id, port_id) in [
            (
                "source",
                edge.source_node.as_str(),
                edge.source_port.as_deref(),
            ),
            (
                "target",
                edge.target_node.as_str(),
                edge.target_port.as_deref(),
            ),
        ] {
            let ports = nodes.get(node_id).ok_or_else(|| {
                BundleError::Invalid(format!(
                    "edge {:?} references missing {side} node {node_id:?}",
                    edge.id
                ))
            })?;
            if let Some(port_id) = port_id
                && !ports.contains(port_id)
            {
                return Err(BundleError::Invalid(format!(
                    "edge {:?} references missing {side} port {port_id:?} on node {node_id:?}",
                    edge.id
                )));
            }
        }
    }

    let mut group_ids = BTreeSet::new();
    for group in &slice.groups {
        if !group_ids.insert(group.id.as_str()) {
            return Err(BundleError::Invalid(format!(
                "duplicate graph group id {:?}",
                group.id
            )));
        }
        let mut children = BTreeSet::new();
        for child in &group.child_node_ids {
            if !nodes.contains_key(child.as_str()) {
                return Err(BundleError::Invalid(format!(
                    "group {:?} references missing child node {:?}",
                    group.id, child
                )));
            }
            if !children.insert(child.as_str()) {
                return Err(BundleError::Invalid(format!(
                    "group {:?} has duplicate child node {:?}",
                    group.id, child
                )));
            }
        }
    }

    let source_pairs: BTreeSet<_> = sources
        .iter()
        .map(|source| (source.id.as_str(), source.path.as_str()))
        .collect();
    let mut file_ids = BTreeSet::new();
    let mut file_paths = BTreeSet::new();
    for file in slice.files.as_deref().unwrap_or_default() {
        if !file_ids.insert(file.id.as_str()) || !file_paths.insert(file.path.as_str()) {
            return Err(BundleError::Invalid(format!(
                "duplicate graph source reference {:?}",
                file.path
            )));
        }
        if !source_pairs.contains(&(file.id.as_str(), file.path.as_str())) {
            return Err(BundleError::Invalid(format!(
                "graph source reference {:?} does not match the source index",
                file.path
            )));
        }
    }
    for origin in slice
        .nodes
        .iter()
        .flat_map(|node| &node.origins)
        .chain(slice.edges.iter().flat_map(|edge| &edge.origins))
        .chain(slice.groups.iter().flat_map(|group| &group.origins))
    {
        if !file_paths.contains(origin.file.as_str()) {
            return Err(BundleError::Invalid(format!(
                "graph origin references unlisted source path {:?}",
                origin.file
            )));
        }
    }
    for range in &slice.elaboration_ranges {
        if !file_paths.contains(range.file.as_str()) {
            return Err(BundleError::Invalid(format!(
                "graph elaboration range references unlisted source path {:?}",
                range.file
            )));
        }
        if validate_elaboration_coordinates(&range.into()).is_err() {
            return Err(BundleError::Invalid(format!(
                "graph has an invalid elaboration range in {:?}",
                range.file
            )));
        }
    }
    Ok(())
}

#[derive(Default)]
struct GraphDecodeBudget {
    objects: u64,
    nodes: u64,
    edges: u64,
    groups: u64,
    files: u64,
    ports: u64,
    origins: u64,
    metadata_entries: u64,
    child_node_ids: u64,
}

fn consume_budget(value: &mut u64, maximum: u64, description: &str) -> Result<()> {
    *value = value.saturating_add(1);
    if *value > maximum {
        return Err(BundleError::Invalid(format!(
            "{description} exceeds supported limit {maximum}"
        )));
    }
    Ok(())
}

fn read_proto_varint(bytes: &[u8], offset: &mut usize) -> Result<u64> {
    let mut value = 0_u64;
    for shift in (0..70).step_by(7) {
        let byte = *bytes
            .get(*offset)
            .ok_or_else(|| BundleError::Invalid("truncated Protobuf varint".to_owned()))?;
        *offset += 1;
        if shift == 63 && byte > 1 {
            return Err(BundleError::Invalid(
                "Protobuf varint is too large".to_owned(),
            ));
        }
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(BundleError::Invalid(
        "Protobuf varint is too long".to_owned(),
    ))
}

fn visit_proto_fields(bytes: &[u8], mut visit: impl FnMut(u32, &[u8]) -> Result<()>) -> Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        let tag = read_proto_varint(bytes, &mut offset)?;
        let field = u32::try_from(tag >> 3)
            .map_err(|_| BundleError::Invalid("Protobuf field number is too large".to_owned()))?;
        if field == 0 {
            return Err(BundleError::Invalid(
                "Protobuf field number 0 is invalid".to_owned(),
            ));
        }
        let payload = match tag & 7 {
            0 => {
                read_proto_varint(bytes, &mut offset)?;
                &bytes[offset..offset]
            }
            1 => {
                let end = offset.checked_add(8).ok_or_else(|| {
                    BundleError::Invalid("Protobuf field offset overflow".to_owned())
                })?;
                let payload = bytes.get(offset..end).ok_or_else(|| {
                    BundleError::Invalid("truncated Protobuf fixed64 field".to_owned())
                })?;
                offset = end;
                payload
            }
            2 => {
                let length = usize::try_from(read_proto_varint(bytes, &mut offset)?)
                    .map_err(|_| BundleError::Invalid("Protobuf field is too large".to_owned()))?;
                let end = offset.checked_add(length).ok_or_else(|| {
                    BundleError::Invalid("Protobuf field offset overflow".to_owned())
                })?;
                let payload = bytes.get(offset..end).ok_or_else(|| {
                    BundleError::Invalid("truncated Protobuf bytes field".to_owned())
                })?;
                offset = end;
                payload
            }
            5 => {
                let end = offset.checked_add(4).ok_or_else(|| {
                    BundleError::Invalid("Protobuf field offset overflow".to_owned())
                })?;
                let payload = bytes.get(offset..end).ok_or_else(|| {
                    BundleError::Invalid("truncated Protobuf fixed32 field".to_owned())
                })?;
                offset = end;
                payload
            }
            wire => {
                return Err(BundleError::Invalid(format!(
                    "unsupported Protobuf wire type {wire}"
                )));
            }
        };
        visit(field, payload)?;
    }
    Ok(())
}

fn preflight_proto_string(payload: &[u8], description: &str) -> Result<()> {
    if payload.len() > MAX_STRING_BYTES {
        return Err(BundleError::Invalid(format!(
            "{description} exceeds supported string byte limit {MAX_STRING_BYTES}"
        )));
    }
    Ok(())
}

fn preflight_json_entry(bytes: &[u8]) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        if matches!(field, 1 | 2) {
            preflight_proto_string(payload, "JSON metadata string")?;
        }
        Ok(())
    })
}

fn preflight_origin(bytes: &[u8]) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        if field == 1 {
            preflight_proto_string(payload, "source origin file")?;
        }
        Ok(())
    })
}

fn preflight_port(bytes: &[u8]) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        if matches!(field, 1 | 2 | 5) {
            preflight_proto_string(payload, "graph port string")?;
        }
        Ok(())
    })
}

fn preflight_module_summary(bytes: &[u8]) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        if matches!(field, 1 | 2 | 3 | 4 | 7) {
            preflight_proto_string(payload, "module summary string")?;
        }
        Ok(())
    })
}

fn preflight_name_value(bytes: &[u8]) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        if matches!(field, 1 | 2) {
            preflight_proto_string(payload, "build name/value string")?;
        }
        Ok(())
    })
}

fn preflight_tool(bytes: &[u8]) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        if matches!(field, 1..=3) {
            preflight_proto_string(payload, "build tool string")?;
        }
        Ok(())
    })
}

fn preflight_build_metadata(bytes: &[u8], build_items: &mut u64) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        match field {
            1 => preflight_proto_string(payload, "build metadata string")?,
            2 | 3 => {
                consume_budget(build_items, MAX_BUILD_ITEMS, "build metadata item count")?;
                preflight_name_value(payload)?;
            }
            4 => {
                consume_budget(build_items, MAX_BUILD_ITEMS, "build metadata item count")?;
                preflight_proto_string(payload, "build metadata string")?;
            }
            5 => {
                consume_budget(build_items, MAX_BUILD_ITEMS, "build metadata item count")?;
                preflight_tool(payload)?;
            }
            _ => {}
        }
        Ok(())
    })
}

fn preflight_source_file(bytes: &[u8], elaboration_ranges: &mut u64) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        if matches!(field, 1..=4) {
            preflight_proto_string(payload, "source file string")?;
        } else if field == 6 {
            consume_budget(
                elaboration_ranges,
                MAX_ORIGINS,
                "legacy source elaboration range count",
            )?;
            preflight_elaboration_range(payload)?;
        }
        Ok(())
    })
}

fn preflight_elaboration_range(bytes: &[u8]) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        if field == 6 {
            preflight_proto_string(payload, "source elaboration range file")?;
        }
        Ok(())
    })
}

fn preflight_diagnostic(bytes: &[u8]) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        match field {
            2 => preflight_proto_string(payload, "diagnostic message")?,
            3 => preflight_origin(payload)?,
            _ => {}
        }
        Ok(())
    })
}

fn preflight_graph_message(bytes: &[u8], budget: &mut GraphDecodeBudget, kind: &str) -> Result<()> {
    visit_proto_fields(bytes, |field, payload| {
        match (kind, field) {
            ("module", 1..=4)
            | ("node", 1 | 3 | 4)
            | ("edge", 1..=6 | 8)
            | ("group", 1..=3)
            | ("file", 1 | 2) => preflight_proto_string(payload, "graph string")?,
            ("module", 5 | 6) | ("node", 5 | 6) | ("group", 4) => {
                consume_budget(
                    &mut budget.metadata_entries,
                    MAX_METADATA_ENTRIES,
                    "graph metadata entry count",
                )?;
                preflight_json_entry(payload)?;
            }
            ("node", 7) => {
                consume_budget(&mut budget.ports, MAX_PORTS, "graph port count")?;
                preflight_port(payload)?;
            }
            ("node", 8) | ("edge", 9) | ("group", 5) => {
                consume_budget(&mut budget.origins, MAX_ORIGINS, "graph origin count")?;
                preflight_origin(payload)?;
            }
            ("group", 6) => {
                consume_budget(
                    &mut budget.child_node_ids,
                    MAX_NODES,
                    "graph group child node ID count",
                )?;
                preflight_proto_string(payload, "graph group child node ID")?;
            }
            _ => {}
        }
        Ok(())
    })
}

fn preflight_graph_slice(bytes: &[u8]) -> Result<()> {
    let mut budget = GraphDecodeBudget::default();
    visit_proto_fields(bytes, |field, payload| {
        match field {
            1 => preflight_proto_string(payload, "graph snapshot ID")?,
            2 => preflight_graph_message(payload, &mut budget, "module")?,
            3 => {
                consume_budget(&mut budget.nodes, MAX_NODES, "graph node count")?;
                consume_budget(&mut budget.objects, MAX_GRAPH_OBJECTS, "graph object count")?;
                preflight_graph_message(payload, &mut budget, "node")?;
            }
            4 => {
                consume_budget(&mut budget.edges, MAX_EDGES, "graph edge count")?;
                consume_budget(&mut budget.objects, MAX_GRAPH_OBJECTS, "graph object count")?;
                preflight_graph_message(payload, &mut budget, "edge")?;
            }
            5 => {
                consume_budget(&mut budget.groups, MAX_GROUPS, "graph group count")?;
                consume_budget(&mut budget.objects, MAX_GRAPH_OBJECTS, "graph object count")?;
                preflight_graph_message(payload, &mut budget, "group")?;
            }
            6 => {
                consume_budget(&mut budget.files, MAX_GRAPH_FILES, "graph file count")?;
                preflight_graph_message(payload, &mut budget, "file")?;
            }
            7 => {
                consume_budget(
                    &mut budget.origins,
                    MAX_ORIGINS,
                    "source elaboration range count",
                )?;
                preflight_elaboration_range(payload)?;
            }
            _ => {}
        }
        Ok(())
    })
}

fn preflight_protobuf(entry: &str, bytes: &[u8]) -> Result<()> {
    if entry == DESIGN_INDEX_ENTRY {
        let mut modules = 0;
        let mut tops = 0;
        let mut build_items = 0;
        return visit_proto_fields(bytes, |field, payload| {
            match field {
                3 | 4 => preflight_proto_string(payload, "design index string")?,
                5 => {
                    consume_budget(&mut tops, MAX_MODULES, "top module count")?;
                    preflight_proto_string(payload, "top module name")?;
                }
                6 => {
                    consume_budget(&mut modules, MAX_MODULES, "module count")?;
                    preflight_module_summary(payload)?;
                }
                7 => preflight_build_metadata(payload, &mut build_items)?,
                _ => {}
            }
            Ok(())
        });
    }
    if entry == SOURCE_INDEX_ENTRY {
        let mut sources = 0;
        let mut elaboration_ranges = 0;
        return visit_proto_fields(bytes, |field, payload| {
            if field == 1 {
                consume_budget(&mut sources, MAX_SOURCES, "source count")?;
                preflight_source_file(payload, &mut elaboration_ranges)?;
            }
            Ok(())
        });
    }
    if entry == DIAGNOSTICS_ENTRY {
        let mut diagnostics = 0;
        return visit_proto_fields(bytes, |field, payload| {
            if field == 1 {
                consume_budget(&mut diagnostics, MAX_DIAGNOSTICS, "diagnostic count")?;
                preflight_diagnostic(payload)?;
            }
            Ok(())
        });
    }
    if entry.starts_with("design/modules/") {
        return preflight_graph_slice(bytes);
    }
    Ok(())
}

fn insert_entry(
    entries: &mut BTreeMap<String, PendingEntry>,
    path: String,
    bytes: Vec<u8>,
    compression: EntryCompression,
) -> Result<()> {
    validate_entry_name(&path)?;
    if bytes.len() as u64 > MAX_ENTRY_BYTES {
        return Err(BundleError::Invalid(format!(
            "entry {path} exceeds size limit"
        )));
    }
    if entries
        .insert(path.clone(), PendingEntry { bytes, compression })
        .is_some()
    {
        return Err(BundleError::Invalid(format!("duplicate entry {path}")));
    }
    Ok(())
}

fn preflight_archive<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<()> {
    if archive.is_empty() || archive.len() > MAX_ENTRY_COUNT {
        return Err(BundleError::Invalid(format!(
            "archive entry count {} is outside the supported range",
            archive.len()
        )));
    }
    let mut names = BTreeSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index)?;
        validate_entry_name(file.name())?;
        if !names.insert(file.name().to_owned()) {
            return Err(BundleError::Invalid(format!(
                "archive contains duplicate entry {}",
                file.name()
            )));
        }
        if file.is_dir() || file.size() > MAX_ENTRY_BYTES {
            return Err(BundleError::Invalid(format!(
                "entry {} has unsupported type or size",
                file.name()
            )));
        }
        total = total.saturating_add(file.size());
        if total > MAX_TOTAL_BYTES {
            return Err(BundleError::Invalid(
                "archive exceeds total uncompressed size limit".to_owned(),
            ));
        }
        if file.compressed_size() > 0
            && file.size() / file.compressed_size().max(1) > MAX_COMPRESSION_RATIO
        {
            return Err(BundleError::Invalid(format!(
                "entry {} exceeds compression-ratio limit",
                file.name()
            )));
        }
        if !matches!(
            file.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err(BundleError::Invalid(format!(
                "entry {} uses unsupported compression",
                file.name()
            )));
        }
    }
    Ok(())
}

fn read_zip_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    path: &str,
    limit: u64,
) -> Result<Vec<u8>> {
    let file = archive.by_name(path)?;
    if file.size() > limit || file.size() > MAX_ENTRY_BYTES {
        return Err(BundleError::Invalid(format!(
            "entry {path} exceeds declared or global size limit"
        )));
    }
    let capacity = usize::try_from(file.size())
        .map_err(|_| BundleError::Invalid(format!("entry {path} is too large")))?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(BundleError::Invalid(format!(
            "entry {path} expands beyond its limit"
        )));
    }
    Ok(bytes)
}

fn validate_entry_name(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > MAX_ENTRY_PATH_BYTES
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains('\0')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(BundleError::Invalid(format!(
            "unsafe archive entry path {path:?}"
        )));
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<()> {
    validate_entry_name(path)?;
    if path.len() > MAX_STRING_BYTES {
        return Err(BundleError::Invalid("source path is too long".to_owned()));
    }
    if path.split('/').count() > MAX_SOURCE_PATH_COMPONENTS {
        return Err(BundleError::Invalid(format!(
            "source path exceeds the supported component limit {MAX_SOURCE_PATH_COMPONENTS}"
        )));
    }
    Ok(())
}

fn validate_module_entry(path: &str) -> Result<()> {
    validate_entry_name(path)?;
    if !path.starts_with("design/modules/") || !path.ends_with(".pb") {
        return Err(BundleError::Invalid(format!(
            "module entry has invalid path {path:?}"
        )));
    }
    Ok(())
}

fn validate_debug_name(name: &str) -> Result<()> {
    validate_entry_name(name)?;
    if name.starts_with("debug/") {
        return Err(BundleError::Invalid(
            "debug artifact name is relative to debug/".to_owned(),
        ));
    }
    Ok(())
}

/// Returns the lowercase SHA-256 digest of `bytes`.
pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn proto_build_metadata(value: &BuildMetadata) -> proto::BuildMetadata {
    proto::BuildMetadata {
        filelist: value.filelist.clone(),
        parameters: value
            .parameters
            .iter()
            .map(|(name, value)| proto::NameValue {
                name: name.clone(),
                value: Some(value.clone()),
            })
            .collect(),
        defines: value
            .defines
            .iter()
            .map(|(name, value)| proto::NameValue {
                name: name.clone(),
                value: value.clone(),
            })
            .collect(),
        undefines: value.undefines.clone(),
        tools: value
            .tools
            .iter()
            .map(|tool| proto::Tool {
                name: tool.name.clone(),
                path: tool.path.clone(),
                version: tool.version.clone(),
            })
            .collect(),
    }
}

fn json_entries(values: &BTreeMap<String, Value>) -> Vec<proto::JsonEntry> {
    values
        .iter()
        .map(|(key, value)| proto::JsonEntry {
            key: key.clone(),
            json_value: serde_json::to_string(value).expect("JSON value serialization cannot fail"),
        })
        .collect()
}

fn parse_json_entries(values: Vec<proto::JsonEntry>) -> Result<BTreeMap<String, Value>> {
    let mut parsed = BTreeMap::new();
    for value in values {
        if value.key.len() > MAX_STRING_BYTES || value.json_value.len() > MAX_STRING_BYTES {
            return Err(BundleError::Invalid(
                "JSON metadata is too large".to_owned(),
            ));
        }
        let json = serde_json::from_str(&value.json_value)?;
        if parsed.insert(value.key.clone(), json).is_some() {
            return Err(BundleError::Invalid(format!(
                "duplicate JSON metadata key {:?}",
                value.key
            )));
        }
    }
    Ok(parsed)
}

impl From<&SourceOrigin> for proto::SourceOrigin {
    fn from(value: &SourceOrigin) -> Self {
        Self {
            file: value.file.clone(),
            start_line: value.start_line,
            start_column: value.start_column,
            end_line: value.end_line,
            end_column: value.end_column,
        }
    }
}

impl From<proto::SourceOrigin> for SourceOrigin {
    fn from(value: proto::SourceOrigin) -> Self {
        Self {
            file: value.file,
            start_line: value.start_line,
            start_column: value.start_column,
            end_line: value.end_line,
            end_column: value.end_column,
        }
    }
}

impl From<&SourceElaborationRange> for proto::SourceElaborationRange {
    fn from(value: &SourceElaborationRange) -> Self {
        Self {
            start_line: value.start_line,
            start_column: value.start_column,
            end_line: value.end_line,
            end_column: value.end_column,
            active: value.active,
            file: value.file.clone(),
        }
    }
}

impl From<proto::SourceElaborationRange> for SourceElaborationRange {
    fn from(value: proto::SourceElaborationRange) -> Self {
        Self {
            start_line: value.start_line,
            start_column: value.start_column,
            end_line: value.end_line,
            end_column: value.end_column,
            active: value.active,
            file: value.file,
        }
    }
}

impl From<&GraphPort> for proto::GraphPort {
    fn from(value: &GraphPort) -> Self {
        Self {
            id: value.id.clone(),
            name: value.name.clone(),
            direction: match value.direction {
                PortDirection::Input => proto::PortDirection::Input,
                PortDirection::Output => proto::PortDirection::Output,
                PortDirection::Inout => proto::PortDirection::Inout,
                PortDirection::Unknown => proto::PortDirection::Unknown,
            } as i32,
            index: value.index,
            role: value.role.clone(),
            width: value.width,
        }
    }
}

impl TryFrom<proto::GraphPort> for GraphPort {
    type Error = BundleError;

    fn try_from(value: proto::GraphPort) -> Result<Self> {
        Ok(Self {
            id: value.id,
            name: value.name,
            direction: match proto::PortDirection::try_from(value.direction) {
                Ok(proto::PortDirection::Input) => PortDirection::Input,
                Ok(proto::PortDirection::Output) => PortDirection::Output,
                Ok(proto::PortDirection::Inout) => PortDirection::Inout,
                Ok(proto::PortDirection::Unknown) | Err(_) => PortDirection::Unknown,
            },
            index: value.index,
            role: value.role,
            width: value.width,
        })
    }
}

impl From<&GraphNode> for proto::GraphNode {
    fn from(value: &GraphNode) -> Self {
        Self {
            id: value.id.clone(),
            kind: match value.kind {
                NodeKind::Input => proto::NodeKind::Input,
                NodeKind::Output => proto::NodeKind::Output,
                NodeKind::Inout => proto::NodeKind::Inout,
                NodeKind::Operator => proto::NodeKind::Operator,
                NodeKind::Mux => proto::NodeKind::Mux,
                NodeKind::Register => proto::NodeKind::Register,
                NodeKind::Latch => proto::NodeKind::Latch,
                NodeKind::Memory => proto::NodeKind::Memory,
                NodeKind::ModuleInstance => proto::NodeKind::ModuleInstance,
                NodeKind::Constant => proto::NodeKind::Constant,
                NodeKind::Primitive => proto::NodeKind::Primitive,
                NodeKind::Unknown => proto::NodeKind::Unknown,
            } as i32,
            label: value.label.clone(),
            definition_name: value.definition_name.clone(),
            parameters: json_entries(&value.parameters),
            attributes: json_entries(&value.attributes),
            ports: value.ports.iter().map(Into::into).collect(),
            origins: value.origins.iter().map(Into::into).collect(),
        }
    }
}

impl TryFrom<proto::GraphNode> for GraphNode {
    type Error = BundleError;

    fn try_from(value: proto::GraphNode) -> Result<Self> {
        Ok(Self {
            id: value.id,
            kind: match proto::NodeKind::try_from(value.kind) {
                Ok(proto::NodeKind::Input) => NodeKind::Input,
                Ok(proto::NodeKind::Output) => NodeKind::Output,
                Ok(proto::NodeKind::Inout) => NodeKind::Inout,
                Ok(proto::NodeKind::Operator) => NodeKind::Operator,
                Ok(proto::NodeKind::Mux) => NodeKind::Mux,
                Ok(proto::NodeKind::Register) => NodeKind::Register,
                Ok(proto::NodeKind::Latch) => NodeKind::Latch,
                Ok(proto::NodeKind::Memory) => NodeKind::Memory,
                Ok(proto::NodeKind::ModuleInstance) => NodeKind::ModuleInstance,
                Ok(proto::NodeKind::Constant) => NodeKind::Constant,
                Ok(proto::NodeKind::Primitive) => NodeKind::Primitive,
                Ok(proto::NodeKind::Unknown) | Err(_) => NodeKind::Unknown,
            },
            label: value.label,
            definition_name: value.definition_name,
            parameters: parse_json_entries(value.parameters)?,
            attributes: parse_json_entries(value.attributes)?,
            ports: value
                .ports
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_>>()?,
            origins: value.origins.into_iter().map(Into::into).collect(),
        })
    }
}

impl From<&GraphEdge> for proto::GraphEdge {
    fn from(value: &GraphEdge) -> Self {
        Self {
            id: value.id.clone(),
            source_node: value.source_node.clone(),
            source_port: value.source_port.clone(),
            target_node: value.target_node.clone(),
            target_port: value.target_port.clone(),
            label: value.label.clone(),
            width: value.width,
            signal_type: value.signal_type.clone(),
            origins: value.origins.iter().map(Into::into).collect(),
        }
    }
}

impl From<proto::GraphEdge> for GraphEdge {
    fn from(value: proto::GraphEdge) -> Self {
        Self {
            id: value.id,
            source_node: value.source_node,
            source_port: value.source_port,
            target_node: value.target_node,
            target_port: value.target_port,
            label: value.label,
            width: value.width,
            signal_type: value.signal_type,
            origins: value.origins.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<&GraphModule> for proto::GraphModule {
    fn from(value: &GraphModule) -> Self {
        Self {
            id: value.id.clone(),
            name: value.name.clone(),
            instance_path: value.instance_path.clone(),
            definition_name: value.definition_name.clone(),
            parameters: json_entries(&value.parameters),
            attributes: json_entries(&value.attributes),
        }
    }
}

impl TryFrom<proto::GraphModule> for GraphModule {
    type Error = BundleError;

    fn try_from(value: proto::GraphModule) -> Result<Self> {
        Ok(Self {
            id: value.id,
            name: value.name,
            instance_path: value.instance_path,
            definition_name: value.definition_name,
            parameters: parse_json_entries(value.parameters)?,
            attributes: parse_json_entries(value.attributes)?,
        })
    }
}

impl From<&GraphGroup> for proto::GraphGroup {
    fn from(value: &GraphGroup) -> Self {
        Self {
            id: value.id.clone(),
            name: value.name.clone(),
            definition_name: value.definition_name.clone(),
            parameters: json_entries(&value.parameters),
            origins: value.origins.iter().map(Into::into).collect(),
            child_node_ids: value.child_node_ids.clone(),
        }
    }
}

impl TryFrom<proto::GraphGroup> for GraphGroup {
    type Error = BundleError;

    fn try_from(value: proto::GraphGroup) -> Result<Self> {
        Ok(Self {
            id: value.id,
            name: value.name,
            definition_name: value.definition_name,
            parameters: parse_json_entries(value.parameters)?,
            origins: value.origins.into_iter().map(Into::into).collect(),
            child_node_ids: value.child_node_ids,
        })
    }
}

impl From<&SourceFileRef> for proto::SourceFileRef {
    fn from(value: &SourceFileRef) -> Self {
        Self {
            id: value.id.clone(),
            path: value.path.clone(),
        }
    }
}

impl From<proto::SourceFileRef> for SourceFileRef {
    fn from(value: proto::SourceFileRef) -> Self {
        Self {
            id: value.id,
            path: value.path,
        }
    }
}

impl From<&GraphSlice> for proto::GraphSlice {
    fn from(value: &GraphSlice) -> Self {
        Self {
            snapshot_id: value.snapshot_id.clone(),
            module: Some((&value.module).into()),
            nodes: value.nodes.iter().map(Into::into).collect(),
            edges: value.edges.iter().map(Into::into).collect(),
            groups: value.groups.iter().map(Into::into).collect(),
            files: value
                .files
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(Into::into)
                .collect(),
            elaboration_ranges: value.elaboration_ranges.iter().map(Into::into).collect(),
        }
    }
}

impl TryFrom<proto::GraphSlice> for GraphSlice {
    type Error = BundleError;

    fn try_from(value: proto::GraphSlice) -> Result<Self> {
        let module = value
            .module
            .ok_or_else(|| BundleError::Invalid("graph slice has no module".to_owned()))?;
        Ok(Self {
            snapshot_id: value.snapshot_id,
            module: module.try_into()?,
            nodes: value
                .nodes
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_>>()?,
            edges: value.edges.into_iter().map(Into::into).collect(),
            groups: value
                .groups
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_>>()?,
            files: (!value.files.is_empty())
                .then(|| value.files.into_iter().map(Into::into).collect()),
            elaboration_ranges: value
                .elaboration_ranges
                .into_iter()
                .map(Into::into)
                .collect(),
        })
    }
}

impl From<&Diagnostic> for proto::Diagnostic {
    fn from(value: &Diagnostic) -> Self {
        Self {
            severity: match value.severity {
                DiagnosticSeverity::Info => proto::DiagnosticSeverity::Info,
                DiagnosticSeverity::Warning => proto::DiagnosticSeverity::Warning,
                DiagnosticSeverity::Error => proto::DiagnosticSeverity::Error,
            } as i32,
            message: value.message.clone(),
            origin: value.origin.as_ref().map(Into::into),
        }
    }
}

impl TryFrom<proto::Diagnostic> for Diagnostic {
    type Error = BundleError;

    fn try_from(value: proto::Diagnostic) -> Result<Self> {
        Ok(Self {
            severity: match proto::DiagnosticSeverity::try_from(value.severity) {
                Ok(proto::DiagnosticSeverity::Info) => DiagnosticSeverity::Info,
                Ok(proto::DiagnosticSeverity::Warning) => DiagnosticSeverity::Warning,
                Ok(proto::DiagnosticSeverity::Error) => DiagnosticSeverity::Error,
                Err(_) => {
                    return Err(BundleError::Invalid(format!(
                        "unknown diagnostic severity {}",
                        value.severity
                    )));
                }
            },
            message: value.message,
            origin: value.origin.map(Into::into),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::Cursor;

    use crate::ir::{GraphEdge, GraphModule, GraphSlice};

    use super::*;

    fn fixture_snapshot() -> DesignSnapshot {
        let slice = GraphSlice {
            snapshot_id: "snapshot-1".to_owned(),
            module: GraphModule {
                id: "module-1".to_owned(),
                name: "top".to_owned(),
                instance_path: "top".to_owned(),
                definition_name: "top".to_owned(),
                parameters: BTreeMap::from([("WIDTH".to_owned(), Value::from(8))]),
                attributes: BTreeMap::new(),
            },
            nodes: vec![],
            edges: vec![],
            groups: vec![],
            files: Some(vec![SourceFileRef {
                id: "file-1".to_owned(),
                path: "rtl/top.sv".to_owned(),
            }]),
            elaboration_ranges: vec![],
        };
        DesignSnapshot {
            snapshot_id: "snapshot-1".to_owned(),
            top: "top".to_owned(),
            tops: vec!["top".to_owned()],
            modules: BTreeMap::from([("top".to_owned(), slice)]),
        }
    }

    fn encode_fixture() -> Vec<u8> {
        let mut snapshot = fixture_snapshot();
        snapshot.modules.get_mut("top").unwrap().elaboration_ranges =
            vec![SourceElaborationRange {
                file: "rtl/top.sv".to_owned(),
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: 7,
                active: true,
            }];
        let sources = vec![BundleSource {
            id: "file-1".to_owned(),
            path: "rtl/top.sv".to_owned(),
            contents: b"module top; endmodule\n".to_vec(),
        }];
        let build = BuildMetadata {
            filelist: "top.f".to_owned(),
            ..BuildMetadata::default()
        };
        let mut output = Cursor::new(Vec::new());
        write_bundle_to(
            &mut output,
            &BundleContents {
                snapshot: &snapshot,
                sources: &sources,
                diagnostics: &[],
                build: &build,
                debug_artifacts: &[],
            },
        )
        .unwrap();
        output.into_inner()
    }

    fn rewrite_fixture(
        mutate_manifest: impl FnOnce(&mut Manifest),
        compression_override: Option<(&str, CompressionMethod)>,
    ) -> Vec<u8> {
        let mut archive = ZipArchive::new(Cursor::new(encode_fixture())).unwrap();
        let mut entries = BTreeMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let compression = entry.compression();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            entries.insert(name, (compression, bytes));
        }
        let manifest_bytes = &mut entries.get_mut(MANIFEST_ENTRY).unwrap().1;
        let mut manifest: Manifest = serde_json::from_slice(manifest_bytes).unwrap();
        mutate_manifest(&mut manifest);
        *manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();

        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut output);
            for (name, (compression, bytes)) in entries {
                let compression = compression_override
                    .filter(|(path, _)| *path == name)
                    .map_or(compression, |(_, method)| method);
                writer
                    .start_file(
                        name,
                        FileOptions::default()
                            .compression_method(compression)
                            .last_modified_time(zip::DateTime::default()),
                    )
                    .unwrap();
                writer.write_all(&bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        output.into_inner()
    }

    fn encode_test_varint(mut value: usize, output: &mut Vec<u8>) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            output.push(byte);
            if value == 0 {
                return;
            }
        }
    }

    fn repeated_empty_messages(field: u8, count: u64) -> Vec<u8> {
        let count = usize::try_from(count).unwrap();
        let mut bytes = Vec::with_capacity(count * 2);
        for _ in 0..count {
            bytes.extend_from_slice(&[(field << 3) | 2, 0]);
        }
        bytes
    }

    fn test_message(field: u8, payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![(field << 3) | 2];
        encode_test_varint(payload.len(), &mut bytes);
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn deterministic_round_trip() {
        let first = encode_fixture();
        let second = encode_fixture();
        assert_eq!(first, second);

        let mut reader = BundleReader::from_bytes(first).unwrap();
        reader.validate_all().unwrap();
        let index = reader.design_index().unwrap();
        assert_eq!(index.top, "top");
        let graph = reader.graph_slice(&index.modules[0].entry).unwrap();
        assert_eq!(graph.module.parameters["WIDTH"], 8);
        let source_index = reader.source_index().unwrap();
        assert_eq!(
            reader.source(&source_index.files[0].entry).unwrap(),
            b"module top; endmodule\n"
        );
        assert_eq!(
            graph.elaboration_ranges,
            vec![SourceElaborationRange {
                file: "rtl/top.sv".to_owned(),
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: 7,
                active: true,
            }]
        );
        assert!(source_index.files[0].elaboration_ranges.is_empty());
    }

    #[test]
    fn rejects_digest_mismatch() {
        let mut archive = ZipArchive::new(Cursor::new(encode_fixture())).unwrap();
        let mut entries = BTreeMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let compression = entry.compression();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            entries.insert(name, (compression, bytes));
        }
        let manifest_bytes = &mut entries.get_mut(MANIFEST_ENTRY).unwrap().1;
        let mut manifest: Manifest = serde_json::from_slice(manifest_bytes).unwrap();
        manifest
            .entries
            .iter_mut()
            .find(|entry| entry.path == DESIGN_INDEX_ENTRY)
            .unwrap()
            .sha256 = "0".repeat(64);
        *manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();

        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut output);
            for (name, (compression, bytes)) in entries {
                writer
                    .start_file(
                        name,
                        FileOptions::default()
                            .compression_method(compression)
                            .last_modified_time(zip::DateTime::default()),
                    )
                    .unwrap();
                writer.write_all(&bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        let mut reader = BundleReader::from_bytes(output.into_inner()).unwrap();
        let error = reader.validate_all().unwrap_err().to_string();
        assert!(error.contains("digest does not match"), "{error}");
    }

    #[test]
    fn rejects_unknown_required_features() {
        let bytes = rewrite_fixture(
            |manifest| manifest.features.push("unknownRequiredFeature".to_owned()),
            None,
        );
        let error = match BundleReader::from_bytes(bytes) {
            Ok(_) => panic!("unknown required feature was accepted"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("unsupported feature"), "{error}");
    }

    #[test]
    fn rejects_manifest_compression_mismatch() {
        let bytes = rewrite_fixture(
            |_| {},
            Some((DESIGN_INDEX_ENTRY, CompressionMethod::Deflated)),
        );
        let error = match BundleReader::from_bytes(bytes) {
            Ok(_) => panic!("compression mismatch was accepted"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("compression does not match"), "{error}");
    }

    #[test]
    fn rejects_module_count_before_protobuf_decode() {
        let bytes = repeated_empty_messages(6, MAX_MODULES + 1);
        let error = preflight_protobuf(DESIGN_INDEX_ENTRY, &bytes)
            .unwrap_err()
            .to_string();
        assert!(error.contains("module count exceeds"), "{error}");
    }

    #[test]
    fn rejects_nested_port_count_before_protobuf_decode() {
        let node = repeated_empty_messages(7, MAX_PORTS + 1);
        let bytes = test_message(3, &node);
        let error = preflight_protobuf("design/modules/top.pb", &bytes)
            .unwrap_err()
            .to_string();
        assert!(error.contains("graph port count exceeds"), "{error}");
    }

    #[test]
    fn rejects_source_elaboration_range_count_before_protobuf_decode() {
        let source = repeated_empty_messages(6, MAX_ORIGINS + 1);
        let bytes = test_message(1, &source);
        let error = preflight_protobuf(SOURCE_INDEX_ENTRY, &bytes)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("source elaboration range count exceeds"),
            "{error}"
        );
    }

    #[test]
    fn rejects_slice_elaboration_range_count_before_protobuf_decode() {
        let bytes = repeated_empty_messages(7, MAX_ORIGINS + 1);
        let error = preflight_protobuf("design/modules/test.pb", &bytes)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("source elaboration range count exceeds"),
            "{error}"
        );
    }

    #[test]
    fn rejects_oversized_strings_before_protobuf_decode() {
        let oversized = vec![0; MAX_STRING_BYTES + 1];
        let cases = [
            (DESIGN_INDEX_ENTRY, test_message(3, &oversized)),
            (
                SOURCE_INDEX_ENTRY,
                test_message(1, &test_message(1, &oversized)),
            ),
            (
                DIAGNOSTICS_ENTRY,
                test_message(1, &test_message(2, &oversized)),
            ),
            (
                "design/modules/top.pb",
                test_message(3, &test_message(3, &oversized)),
            ),
        ];
        for (entry, bytes) in cases {
            let error = preflight_protobuf(entry, &bytes).unwrap_err().to_string();
            assert!(error.contains("string byte limit"), "{entry}: {error}");
        }
    }

    #[test]
    fn rejects_group_child_ids_before_protobuf_decode() {
        let group = repeated_empty_messages(6, MAX_NODES + 1);
        let bytes = test_message(5, &group);
        let error = preflight_protobuf("design/modules/top.pb", &bytes)
            .unwrap_err()
            .to_string();
        assert!(error.contains("child node ID count exceeds"), "{error}");
    }

    #[test]
    fn accepts_small_protobuf_collections_during_preflight() {
        preflight_protobuf(DESIGN_INDEX_ENTRY, &repeated_empty_messages(6, 2)).unwrap();
        let node = repeated_empty_messages(7, 2);
        preflight_protobuf("design/modules/top.pb", &test_message(3, &node)).unwrap();
    }

    #[test]
    fn rejects_duplicate_module_identities() {
        let first = proto::ModuleSummary {
            id: "module-1".to_owned(),
            name: "top".to_owned(),
            entry: "design/modules/module-1.pb".to_owned(),
            ..proto::ModuleSummary::default()
        };
        let mut duplicate_id = first.clone();
        duplicate_id.name = "other".to_owned();
        duplicate_id.entry = "design/modules/other.pb".to_owned();
        let error = validate_module_identities(&[first.clone(), duplicate_id])
            .unwrap_err()
            .to_string();
        assert!(error.contains("duplicate module id"), "{error}");

        let mut duplicate_name = first.clone();
        duplicate_name.id = "module-2".to_owned();
        duplicate_name.entry = "design/modules/module-2.pb".to_owned();
        let error = validate_module_identities(&[first, duplicate_name])
            .unwrap_err()
            .to_string();
        assert!(error.contains("duplicate module name"), "{error}");
    }

    #[test]
    fn rejects_duplicate_source_identities() {
        let first = proto::SourceFile {
            id: "file-1".to_owned(),
            path: "rtl/top.sv".to_owned(),
            ..proto::SourceFile::default()
        };
        let mut duplicate_id = first.clone();
        duplicate_id.path = "rtl/other.sv".to_owned();
        let error = validate_source_identities(&[first.clone(), duplicate_id])
            .unwrap_err()
            .to_string();
        assert!(error.contains("duplicate source id"), "{error}");

        let mut duplicate_path = first.clone();
        duplicate_path.id = "file-2".to_owned();
        let error = validate_source_identities(&[first, duplicate_path])
            .unwrap_err()
            .to_string();
        assert!(error.contains("duplicate source path"), "{error}");
    }

    #[test]
    fn preserves_valid_legacy_source_elaboration_ranges() {
        let mut source = proto::SourceFile {
            id: "file-1".to_owned(),
            path: "rtl/top.sv".to_owned(),
            elaboration_ranges: vec![proto::SourceElaborationRange {
                start_line: 2,
                start_column: 3,
                end_line: 4,
                end_column: 6,
                active: false,
                file: String::new(),
            }],
            ..proto::SourceFile::default()
        };
        validate_source_identities(&[source.clone()]).unwrap();
        normalize_legacy_source_elaboration_ranges(std::slice::from_mut(&mut source)).unwrap();
        assert_eq!(source.elaboration_ranges[0].file, source.path);

        source.elaboration_ranges[0].file = source.path.clone();
        validate_source_identities(&[source]).unwrap();
    }

    #[test]
    fn rejects_invalid_legacy_source_elaboration_ranges() {
        let source = proto::SourceFile {
            id: "file-1".to_owned(),
            path: "rtl/top.sv".to_owned(),
            elaboration_ranges: vec![proto::SourceElaborationRange {
                start_line: 7,
                start_column: 3,
                end_line: 6,
                end_column: 9,
                active: false,
                file: String::new(),
            }],
            ..proto::SourceFile::default()
        };
        let error = validate_source_identities(&[source])
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("invalid legacy elaboration range"),
            "{error}"
        );
    }

    #[test]
    fn rejects_mismatched_legacy_source_elaboration_range_paths() {
        let source = proto::SourceFile {
            id: "file-1".to_owned(),
            path: "rtl/top.sv".to_owned(),
            elaboration_ranges: vec![proto::SourceElaborationRange {
                start_line: 2,
                start_column: 3,
                end_line: 4,
                end_column: 6,
                active: false,
                file: "rtl/other.sv".to_owned(),
            }],
            ..proto::SourceFile::default()
        };
        let error = validate_source_identities(std::slice::from_ref(&source))
            .unwrap_err()
            .to_string();
        assert!(error.contains("mismatched file"), "{error}");

        let mut sources = vec![source];
        let error = normalize_legacy_source_elaboration_ranges(&mut sources)
            .unwrap_err()
            .to_string();
        assert!(error.contains("mismatched file"), "{error}");
    }

    #[test]
    fn shares_the_writer_origin_budget_with_elaboration_ranges() {
        let mut slice = fixture_snapshot().modules.remove("top").unwrap();
        slice.groups.push(GraphGroup {
            id: "group-1".to_owned(),
            name: "group".to_owned(),
            definition_name: "child".to_owned(),
            parameters: BTreeMap::new(),
            origins: vec![SourceOrigin {
                file: "rtl/top.sv".to_owned(),
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: Some(2),
            }],
            child_node_ids: vec![],
        });
        slice.elaboration_ranges.push(SourceElaborationRange {
            file: "rtl/top.sv".to_owned(),
            start_line: 2,
            start_column: 1,
            end_line: 4,
            end_column: 2,
            active: true,
        });

        validate_graph_origin_budget(&slice, 2).unwrap();
        let error = validate_graph_origin_budget(&slice, 1)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("origin and elaboration range count exceeds"),
            "{error}"
        );
    }

    #[test]
    fn rejects_module_slice_snapshot_mismatch() {
        let slice = fixture_snapshot().modules.remove("top").unwrap();
        let module = proto::ModuleSummary {
            id: slice.module.id.clone(),
            name: slice.module.name.clone(),
            node_count: slice.nodes.len() as u64,
            edge_count: slice.edges.len() as u64,
            entry: "design/modules/module-1.pb".to_owned(),
            ..proto::ModuleSummary::default()
        };
        let error = validate_module_index_entry("different-snapshot", &module, &slice)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("snapshot identity does not match"),
            "{error}"
        );
    }

    #[test]
    fn rejects_dangling_graph_references() {
        let mut slice = fixture_snapshot().modules.remove("top").unwrap();
        slice.edges.push(GraphEdge {
            id: "dangling-edge".to_owned(),
            source_node: "missing-source".to_owned(),
            source_port: None,
            target_node: "missing-target".to_owned(),
            target_port: None,
            label: None,
            width: None,
            signal_type: None,
            origins: vec![],
        });
        let error = validate_graph_references(&slice, &[], &[])
            .unwrap_err()
            .to_string();
        assert!(error.contains("missing source node"), "{error}");
    }

    #[test]
    fn file_writer_replaces_atomically_without_leaving_temporary_files() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("design.nettle");
        fs::write(&output, b"stale partial output").unwrap();

        let snapshot = fixture_snapshot();
        let sources = vec![BundleSource {
            id: "file-1".to_owned(),
            path: "rtl/top.sv".to_owned(),
            contents: b"module top; endmodule\n".to_vec(),
        }];
        let build = BuildMetadata::default();
        write_bundle(
            &output,
            &BundleContents {
                snapshot: &snapshot,
                sources: &sources,
                diagnostics: &[],
                build: &build,
                debug_artifacts: &[],
            },
        )
        .unwrap();

        BundleReader::open(&output).unwrap().validate_all().unwrap();
        let names: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [std::ffi::OsString::from("design.nettle")]);
    }

    #[test]
    fn rejects_unsafe_paths() {
        assert!(validate_entry_name("../secret").is_err());
        assert!(validate_entry_name("/absolute").is_err());
        assert!(validate_entry_name("safe/path").is_ok());
        let deep = std::iter::repeat_n("d", MAX_SOURCE_PATH_COMPONENTS + 1)
            .collect::<Vec<_>>()
            .join("/");
        assert!(validate_relative_path(&deep).is_err());
    }
}
