// SPDX-License-Identifier: Apache-2.0

//! Compiler-neutral data model and importers for Nettle.

mod filelist;
mod model;
mod slang;
mod yosys;

pub(crate) use filelist::normalize_filelist_within;
pub use filelist::{
    Define, FileListError, InputPath, NormalizedArgument, NormalizedArgumentKind,
    NormalizedProject, ParameterAssignment, TokenOrigin, Undefine, normalize_filelist,
};
pub use model::{
    DesignSnapshot, Diagnostic, DiagnosticSeverity, GraphEdge, GraphGroup, GraphModule, GraphNode,
    GraphPort, GraphProjectionError, GraphSlice, GraphSliceRequest, ModuleSummary, NodeKind,
    PortDirection, ProjectSummary, SCHEMA_VERSION, SourceFileRef, SourceOrigin, stable_id,
};
pub use slang::{SlangMetadataError, SlangParameterMergeReport, merge_slang_instance_parameters};
pub use yosys::{YosysImportError, import_yosys_json, import_yosys_value};
