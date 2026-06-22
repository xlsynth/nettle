// SPDX-License-Identifier: Apache-2.0

//! Builds deterministic bundles from compiler output and referenced sources.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::bundle::{
    BuildMetadata, BundleContents, BundleSource, DebugArtifact, ToolMetadata, write_bundle,
};
use crate::ir::{
    DesignSnapshot, Diagnostic, DiagnosticSeverity, NormalizedArgumentKind, NormalizedProject,
    SourceFileRef, import_yosys_json, merge_slang_instance_parameters, normalize_filelist,
    stable_id,
};
use anyhow::{Context, Result, anyhow, bail};

use crate::compiler::{
    CompilerOptions, DefineOverride, ElaborationOverrides, ParameterOverride, compile_filelist,
};
use crate::resource_limits::native::builder::SOURCE_BYTES as MAX_SOURCE_BYTES;

#[derive(Debug, Clone)]
/// Inputs for one source-to-bundle build.
pub struct BuildOptions {
    /// Root Slang-compatible filelist.
    pub filelist: PathBuf,
    /// Optional containment boundary; defaults to the filelist parent.
    pub project_root: Option<PathBuf>,
    /// Optional explicit top module overriding the filelist.
    pub top: Option<String>,
    /// Parameter and preprocessor overrides applied to both compilers.
    pub elaboration: ElaborationOverrides,
    /// Optional standalone Slang executable override.
    pub slang_bin: Option<PathBuf>,
    /// Optional Yosys executable override.
    pub yosys_bin: Option<PathBuf>,
    /// Whether to retain raw compiler outputs and transcripts in the bundle.
    pub debug_artifacts: bool,
}

/// In-memory result of compilation, normalization, and source collection.
pub struct BuiltProject {
    /// Compiler-neutral elaborated design.
    pub snapshot: DesignSnapshot,
    /// Referenced source files within the project root.
    pub sources: Vec<BundleSource>,
    /// Normalized diagnostics emitted during compilation.
    pub diagnostics: Vec<Diagnostic>,
    /// Effective elaboration inputs and compiler provenance.
    pub build: BuildMetadata,
    /// Optional raw outputs requested for debugging.
    pub debug_artifacts: Vec<DebugArtifact>,
}

impl BuiltProject {
    /// Atomically writes this project as a deterministic `.nettle` bundle.
    pub fn write(&self, output: &Path) -> crate::bundle::Result<crate::bundle::Manifest> {
        write_bundle(
            output,
            &BundleContents {
                snapshot: &self.snapshot,
                sources: &self.sources,
                diagnostics: &self.diagnostics,
                build: &self.build,
                debug_artifacts: &self.debug_artifacts,
            },
        )
    }
}

/// Compiles a filelist and collects everything needed for a portable bundle.
pub fn build_project(options: &BuildOptions) -> Result<BuiltProject> {
    options
        .elaboration
        .validate()
        .context("validating elaboration overrides")?;
    let filelist = fs::canonicalize(&options.filelist)
        .with_context(|| format!("locating filelist {}", options.filelist.display()))?;
    let inferred_root = filelist
        .parent()
        .ok_or_else(|| anyhow!("root filelist has no parent directory"))?;
    let root = fs::canonicalize(options.project_root.as_deref().unwrap_or(inferred_root))
        .context("canonicalizing project root")?;
    if !root.is_dir() {
        bail!("project root {} is not a directory", root.display());
    }
    require_within(&root, &filelist, "root filelist")?;

    let project =
        normalize_filelist(&filelist, options.top.as_deref()).context("normalizing filelist")?;
    reject_ineffective_define_overrides(&project, &options.elaboration)?;
    let top = options
        .top
        .as_deref()
        .or(project.top.as_deref())
        .ok_or_else(|| anyhow!("pass --top <module> or add --top to the root filelist"))?;
    let effective = effective_elaboration(&project, &options.elaboration);

    let artifacts = compile_filelist(&CompilerOptions {
        filelist: filelist.clone(),
        top: top.to_owned(),
        elaboration: options.elaboration.clone(),
        slang_bin: options.slang_bin.clone(),
        yosys_bin: options.yosys_bin.clone(),
    })?;
    let mut snapshot =
        import_yosys_json(&artifacts.yosys_json, Some(top)).context("importing Yosys JSON")?;
    merge_slang_instance_parameters(&mut snapshot, &artifacts.slang_ast_json)
        .context("merging Slang parameters and source provenance")?;
    rekey_snapshot(&mut snapshot, top, &effective)?;

    let mut diagnostics: Vec<Diagnostic> = project
        .unknown_arguments
        .iter()
        .map(|argument| Diagnostic {
            severity: DiagnosticSeverity::Warning,
            message: format!(
                "preserved unsupported filelist option {:?} at {}:{}:{}",
                argument.value, argument.origin.file, argument.origin.line, argument.origin.column
            ),
            origin: None,
        })
        .collect();
    diagnostics.extend(artifacts.diagnostics.clone());

    let sources = collect_sources(
        &root,
        &project,
        &mut snapshot,
        Some(&artifacts.source_path_base),
    )?;
    let tools = artifacts
        .tools
        .iter()
        .map(|tool| ToolMetadata {
            name: tool.name.clone(),
            path: Path::new(&tool.path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            version: tool.version.clone(),
        })
        .collect();
    let build = BuildMetadata {
        filelist: relative_string(&root, &filelist),
        parameters: effective
            .parameters
            .iter()
            .map(|value| (value.name.clone(), value.value.clone()))
            .collect(),
        defines: effective
            .defines
            .iter()
            .map(|value| (value.name.clone(), value.value.clone()))
            .collect(),
        undefines: effective.undefines.clone(),
        tools,
    };
    let debug_artifacts = if options.debug_artifacts {
        let mut debug = vec![
            DebugArtifact {
                name: "yosys.json".to_owned(),
                contents: artifacts.yosys_json.into_bytes(),
            },
            DebugArtifact {
                name: "slang-ast.json".to_owned(),
                contents: artifacts.slang_ast_json.into_bytes(),
            },
        ];
        for transcript in artifacts.transcripts {
            debug.push(DebugArtifact {
                name: format!("{}-stdout.txt", transcript.tool),
                contents: transcript.stdout.into_bytes(),
            });
            debug.push(DebugArtifact {
                name: format!("{}-stderr.txt", transcript.tool),
                contents: transcript.stderr.into_bytes(),
            });
        }
        debug
    } else {
        Vec::new()
    };

    Ok(BuiltProject {
        snapshot,
        sources,
        diagnostics,
        build,
        debug_artifacts,
    })
}

fn reject_ineffective_define_overrides(
    project: &NormalizedProject,
    overrides: &ElaborationOverrides,
) -> Result<()> {
    for define in &overrides.defines {
        if let Some(undefine) = project
            .undefines
            .iter()
            .find(|undefine| undefine.name == define.name)
        {
            bail!(
                "explicit define {:?} cannot override filelist -U at {}:{}:{} because Slang applies undefines globally",
                define.name,
                undefine.origin.file,
                undefine.origin.line,
                undefine.origin.column
            );
        }
    }
    Ok(())
}

fn effective_elaboration(
    project: &NormalizedProject,
    overrides: &ElaborationOverrides,
) -> ElaborationOverrides {
    let mut parameters = BTreeMap::new();
    let mut defines = BTreeMap::new();
    let mut undefines = BTreeSet::new();
    for argument in &project.arguments {
        match argument.kind {
            NormalizedArgumentKind::Parameter => {
                if let Some((name, value)) = argument.value.split_once('=') {
                    parameters
                        .entry(name.to_owned())
                        .or_insert_with(|| value.to_owned());
                }
            }
            NormalizedArgumentKind::Define => {
                let (name, value) = argument
                    .value
                    .split_once('=')
                    .map_or((argument.value.as_str(), None), |(name, value)| {
                        (name, Some(value.to_owned()))
                    });
                defines.entry(name.to_owned()).or_insert(value);
            }
            NormalizedArgumentKind::Undefine => {
                undefines.insert(argument.value.clone());
            }
            _ => {}
        }
    }
    for parameter in &overrides.parameters {
        parameters.insert(parameter.name.clone(), parameter.value.clone());
    }
    for name in &undefines {
        defines.remove(name);
    }
    for define in &overrides.defines {
        defines.insert(define.name.clone(), define.value.clone());
        undefines.remove(&define.name);
    }
    for name in &overrides.undefines {
        defines.remove(name);
        undefines.insert(name.clone());
    }
    ElaborationOverrides {
        parameters: parameters
            .into_iter()
            .map(|(name, value)| ParameterOverride { name, value })
            .collect(),
        defines: defines
            .into_iter()
            .map(|(name, value)| DefineOverride { name, value })
            .collect(),
        undefines: undefines.into_iter().collect(),
    }
}

fn rekey_snapshot(
    snapshot: &mut DesignSnapshot,
    top: &str,
    elaboration: &ElaborationOverrides,
) -> Result<()> {
    let identity = serde_json::to_string(&(top, elaboration))?;
    let snapshot_id = stable_id("snapshot", &format!("{}\n{identity}", snapshot.snapshot_id));
    snapshot.snapshot_id.clone_from(&snapshot_id);
    for module in snapshot.modules.values_mut() {
        module.snapshot_id.clone_from(&snapshot_id);
    }
    Ok(())
}

fn collect_sources(
    root: &Path,
    project: &NormalizedProject,
    snapshot: &mut DesignSnapshot,
    compiler_source_base: Option<&Path>,
) -> Result<Vec<BundleSource>> {
    let mut spellings = BTreeSet::new();
    spellings.extend(project.sources.iter().map(|source| source.path.clone()));
    spellings.extend(
        project
            .library_files
            .iter()
            .map(|source| source.path.clone()),
    );
    for graph in snapshot.modules.values() {
        if let Some(files) = &graph.files {
            spellings.extend(files.iter().map(|file| file.path.clone()));
        }
    }

    let filelist_directory = Path::new(&project.root_filelist).parent();
    let mut by_relative = BTreeMap::<String, BundleSource>::new();
    let mut spelling_to_ref = BTreeMap::<String, SourceFileRef>::new();
    for spelling in spellings {
        let Some(canonical) =
            resolve_source_path(root, compiler_source_base.or(filelist_directory), &spelling)
        else {
            continue;
        };
        require_within(root, &canonical, "declared source")?;
        let metadata = fs::metadata(&canonical)?;
        if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
            continue;
        }
        let contents = fs::read(&canonical)?;
        if std::str::from_utf8(&contents).is_err() || contents.contains(&0) {
            continue;
        }
        let relative = relative_string(root, &canonical);
        let file_ref = SourceFileRef {
            id: stable_id("file", &relative),
            path: relative.clone(),
        };
        spelling_to_ref.insert(spelling, file_ref.clone());
        by_relative.entry(relative.clone()).or_insert(BundleSource {
            id: file_ref.id,
            path: relative,
            contents,
        });
    }

    for graph in snapshot.modules.values_mut() {
        correlate_graph_sources(graph, &spelling_to_ref);
    }

    Ok(by_relative.into_values().collect())
}

fn correlate_graph_sources(
    graph: &mut crate::ir::GraphSlice,
    spelling_to_ref: &BTreeMap<String, SourceFileRef>,
) {
    let mut files: Vec<SourceFileRef> = graph
        .files
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|file| spelling_to_ref.get(&file.path).cloned())
        .collect();
    for node in &mut graph.nodes {
        correlate_origins(&mut node.origins, spelling_to_ref, &mut files);
    }
    for edge in &mut graph.edges {
        correlate_origins(&mut edge.origins, spelling_to_ref, &mut files);
    }
    for group in &mut graph.groups {
        correlate_origins(&mut group.origins, spelling_to_ref, &mut files);
    }
    files.sort_by(|left, right| left.path.cmp(&right.path).then(left.id.cmp(&right.id)));
    files.dedup();
    graph.files = (!files.is_empty()).then_some(files);
}

fn correlate_origins(
    origins: &mut Vec<crate::ir::SourceOrigin>,
    spelling_to_ref: &BTreeMap<String, SourceFileRef>,
    files: &mut Vec<SourceFileRef>,
) {
    origins.retain_mut(|origin| {
        let Some(file) = spelling_to_ref.get(&origin.file) else {
            return false;
        };
        origin.file.clone_from(&file.path);
        files.push(file.clone());
        true
    });
}

fn resolve_source_path(
    root: &Path,
    compiler_working_directory: Option<&Path>,
    spelling: &str,
) -> Option<PathBuf> {
    let unresolved = Path::new(spelling);
    if unresolved.is_absolute() {
        return fs::canonicalize(unresolved).ok();
    }
    compiler_working_directory
        .into_iter()
        .chain(std::iter::once(root))
        .map(|base| lexical_normalize(&base.join(unresolved)))
        .find_map(|candidate| fs::canonicalize(candidate).ok())
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !path.is_absolute() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn require_within(root: &Path, path: &Path, description: &str) -> Result<()> {
    if !path.starts_with(root) {
        bail!(
            "{description} {} is outside project root {}",
            path.display(),
            root.display()
        );
    }
    Ok(())
}

fn relative_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use crate::bundle::BundleReader;
    use crate::ir::{GraphModule, GraphNode, GraphSlice, NodeKind, SourceOrigin};

    use super::*;

    #[cfg(unix)]
    #[test]
    fn fake_toolchain_builds_a_valid_source_correlated_bundle() {
        let (directory, slang, yosys, filelist) = crate::compiler::tests::fake_compilers(false);
        let project = build_project(&BuildOptions {
            filelist,
            project_root: Some(directory.path().to_owned()),
            top: Some("top".to_owned()),
            elaboration: ElaborationOverrides::default(),
            slang_bin: Some(slang),
            yosys_bin: Some(yosys),
            debug_artifacts: false,
        })
        .unwrap();
        assert_eq!(project.snapshot.top, "top");
        assert_eq!(
            project.snapshot.modules["top"].module.parameters["WIDTH"],
            "8"
        );
        assert_eq!(project.sources.len(), 1);
        assert_eq!(project.sources[0].path, "top.sv");
        assert_eq!(project.diagnostics[0].message, "fake warning");
        assert!(project.debug_artifacts.is_empty());

        let output = directory.path().join("design.nettle");
        project.write(&output).unwrap();
        let mut reader = BundleReader::open(&output).unwrap();
        reader.validate_all().unwrap();
        let index = reader.design_index().unwrap();
        assert_eq!(index.build.unwrap().tools.len(), 2);
        let sources = reader.source_index().unwrap();
        assert_eq!(sources.files[0].path, "top.sv");
    }

    #[test]
    fn canonicalizes_graph_origin_paths_with_source_references() {
        let canonical = SourceFileRef {
            id: "file-canonical".to_owned(),
            path: "example-rtl/rtl/top.sv".to_owned(),
        };
        let mut spellings = BTreeMap::new();
        spellings.insert("../example-rtl/rtl/top.sv".to_owned(), canonical.clone());
        let mut graph = GraphSlice {
            snapshot_id: "snapshot".to_owned(),
            module: GraphModule {
                id: "module".to_owned(),
                name: "top".to_owned(),
                instance_path: "top".to_owned(),
                definition_name: "top".to_owned(),
                parameters: BTreeMap::new(),
                attributes: BTreeMap::new(),
            },
            nodes: vec![GraphNode {
                id: "node".to_owned(),
                kind: NodeKind::Operator,
                label: "node".to_owned(),
                definition_name: None,
                parameters: BTreeMap::new(),
                attributes: BTreeMap::new(),
                ports: vec![],
                origins: vec![
                    SourceOrigin {
                        file: "../example-rtl/rtl/top.sv".to_owned(),
                        start_line: 1,
                        start_column: 1,
                        end_line: 1,
                        end_column: None,
                    },
                    SourceOrigin {
                        file: "missing.sv".to_owned(),
                        start_line: 2,
                        start_column: 1,
                        end_line: 2,
                        end_column: None,
                    },
                ],
            }],
            edges: vec![],
            groups: vec![],
            files: Some(vec![SourceFileRef {
                id: "uncorrelated".to_owned(),
                path: "../example-rtl/rtl/top.sv".to_owned(),
            }]),
        };

        correlate_graph_sources(&mut graph, &spellings);

        assert_eq!(graph.nodes[0].origins[0].file, canonical.path);
        assert_eq!(graph.nodes[0].origins.len(), 1);
        assert_eq!(graph.files, Some(vec![canonical]));
    }
}
