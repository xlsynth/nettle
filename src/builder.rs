// SPDX-License-Identifier: Apache-2.0

//! Builds deterministic bundles from compiler output and referenced sources.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use crate::bundle::{
    BuildMetadata, BundleContents, BundleSource, DebugArtifact, ToolMetadata, write_bundle,
};
use crate::ir::{
    DesignSnapshot, Diagnostic, DiagnosticSeverity, NormalizedArgumentKind, NormalizedProject,
    SourceFileRef, import_yosys_json, merge_slang_instance_parameters, normalize_filelist,
    normalize_filelist_within, stable_id,
};
use anyhow::{Context, Result, anyhow, bail};

use crate::compiler::{
    CompilerOptions, DefineOverride, ElaborationOverrides, ParameterOverride,
    compile_filelist_with_timeout,
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
    /// Optional deadline for each compiler process.
    pub compiler_timeout: Option<Duration>,
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
    build_project_impl(options, false)
}

/// Compiles an untrusted hosted filelist after confining source-level includes.
pub(crate) fn build_untrusted_project(options: &BuildOptions) -> Result<BuiltProject> {
    build_project_impl(options, true)
}

fn build_project_impl(
    options: &BuildOptions,
    confine_untrusted_inputs: bool,
) -> Result<BuiltProject> {
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

    let project = if confine_untrusted_inputs {
        normalize_filelist_within(&filelist, options.top.as_deref(), &root)
    } else {
        normalize_filelist(&filelist, options.top.as_deref())
    }
    .context("normalizing filelist")?;
    if confine_untrusted_inputs {
        require_compiler_inputs_within(&root, &project)?;
        require_source_includes_within(&root, &project)?;
    }
    reject_ineffective_define_overrides(&project, &options.elaboration)?;
    let top = options
        .top
        .as_deref()
        .or(project.top.as_deref())
        .ok_or_else(|| anyhow!("pass --top <module> or add --top to the root filelist"))?;
    let effective = effective_elaboration(&project, &options.elaboration);

    let artifacts = compile_filelist_with_timeout(
        &CompilerOptions {
            filelist: filelist.clone(),
            top: top.to_owned(),
            elaboration: options.elaboration.clone(),
            slang_bin: options.slang_bin.clone(),
            yosys_bin: options.yosys_bin.clone(),
        },
        options.compiler_timeout,
    )?;
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

fn require_compiler_inputs_within(root: &Path, project: &NormalizedProject) -> Result<()> {
    for argument in &project.arguments {
        if !matches!(
            argument.kind,
            NormalizedArgumentKind::Source
                | NormalizedArgumentKind::IncludeDirectory
                | NormalizedArgumentKind::LibraryDirectory
                | NormalizedArgumentKind::LibraryFile
                | NormalizedArgumentKind::NestedFilelist
        ) {
            continue;
        }
        let path = fs::canonicalize(&argument.value).with_context(|| {
            format!(
                "locating {:?} declared at {}:{}:{}",
                argument.value, argument.origin.file, argument.origin.line, argument.origin.column
            )
        })?;
        require_within(root, &path, "filelist input")?;
    }
    Ok(())
}

fn require_source_includes_within(root: &Path, project: &NormalizedProject) -> Result<()> {
    let include_directories = project
        .include_directories
        .iter()
        .map(|directory| {
            fs::canonicalize(&directory.path).with_context(|| {
                format!(
                    "locating include directory {:?} declared at {}:{}:{}",
                    directory.path,
                    directory.origin.file,
                    directory.origin.line,
                    directory.origin.column
                )
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut pending = project
        .sources
        .iter()
        .chain(&project.library_files)
        .map(|source| {
            fs::canonicalize(&source.path).with_context(|| {
                format!(
                    "locating source {:?} declared at {}:{}:{}",
                    source.path, source.origin.file, source.origin.line, source.origin.column
                )
            })
        })
        .collect::<Result<Vec<_>>>()?;
    pending.extend(library_source_files(&project.library_directories)?);
    let mut discovered = pending.into_iter().collect::<BTreeSet<_>>();
    let mut pending = discovered.iter().cloned().collect::<Vec<_>>();

    while let Some(source) = pending.pop() {
        require_within(root, &source, "source include input")?;
        let contents = read_bounded_source_text(&source)?;
        visit_source_include_paths(&contents, |include| {
            let include = Path::new(include);
            if include.is_absolute() {
                bail!(
                    "source include {} in {} is absolute; Azure builds require project-relative includes",
                    include.display(),
                    source.display()
                );
            }
            let mut candidates = std::iter::once(
                source
                    .parent()
                    .ok_or_else(|| anyhow!("source {} has no parent directory", source.display()))?
                    .join(include),
            )
            .chain(
                include_directories
                    .iter()
                    .map(|directory| directory.join(include)),
            );
            if let Some(resolved) =
                candidates.find_map(|candidate| fs::canonicalize(candidate).ok())
            {
                require_within(root, &resolved, "source include")?;
                if discovered.insert(resolved.clone()) {
                    pending.push(resolved);
                }
            }
            Ok(())
        })
        .with_context(|| format!("parsing source {} for includes", source.display()))?;
    }
    Ok(())
}

fn read_bounded_source_text(path: &Path) -> Result<String> {
    let file = fs::File::open(path)
        .with_context(|| format!("opening source {} for includes", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .with_context(|| format!("reading source {} for includes", path.display()))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_SOURCE_BYTES {
        bail!(
            "source {} exceeds the {}-byte hosted include-scan limit",
            path.display(),
            MAX_SOURCE_BYTES
        );
    }
    String::from_utf8(bytes)
        .with_context(|| format!("source {} is not valid UTF-8", path.display()))
}

/// Returns HDL source files that a `-y` / `--libdir` compiler option may load.
///
/// Verilog library lookup searches the directory itself, not its descendants.
/// Restricting this to source extensions keeps unrelated library collateral from
/// becoming an input to the include parser while covering the source suffixes
/// accepted by the supported compiler flow.
fn library_source_files(library_directories: &[crate::ir::InputPath]) -> Result<Vec<PathBuf>> {
    let mut sources = Vec::new();
    for directory in library_directories {
        let directory = fs::canonicalize(&directory.path).with_context(|| {
            format!(
                "locating library directory {:?} declared at {}:{}:{}",
                directory.path,
                directory.origin.file,
                directory.origin.line,
                directory.origin.column
            )
        })?;
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("reading library directory {}", directory.display()))?
        {
            let entry = entry.with_context(|| {
                format!(
                    "reading an entry from library directory {}",
                    directory.display()
                )
            })?;
            let path = entry.path();
            if !matches!(
                path.extension().and_then(OsStr::to_str),
                Some("v" | "sv" | "vh" | "svh")
            ) {
                continue;
            }
            let path = fs::canonicalize(&path)
                .with_context(|| format!("locating library source {}", path.display()))?;
            if path.is_file() {
                sources.push(path);
            }
        }
    }
    sources.sort();
    Ok(sources)
}

fn visit_source_include_paths(
    contents: &str,
    mut visit: impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    let bytes = contents.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index..] {
            [b'/', b'/', ..] => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            [b'/', b'*', ..] => {
                index += 2;
                while index + 1 < bytes.len() && bytes[index..index + 2] != *b"*/" {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
            }
            [b'"', ..] => index = skip_quoted_source_string(bytes, index)?,
            [b'`', ..] => {
                let name_start = index + 1;
                let mut name_end = name_start;
                while name_end < bytes.len()
                    && (bytes[name_end].is_ascii_alphanumeric() || bytes[name_end] == b'_')
                {
                    name_end += 1;
                }
                if &bytes[name_start..name_end] != b"include" {
                    index = name_end;
                    continue;
                }
                index = name_end;
                while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                    index += 1;
                }
                if index == bytes.len() || bytes[index] != b'"' {
                    bail!("source-level `include directives must use literal double-quoted paths");
                }
                let path_start = index + 1;
                let path_end = skip_quoted_source_string(bytes, index)? - 1;
                if bytes[path_start..path_end].contains(&b'\\') {
                    bail!("source-level `include paths must not use escape sequences");
                }
                visit(&contents[path_start..path_end])?;
                index = path_end + 1;
            }
            _ => index += 1,
        }
    }
    Ok(())
}

fn skip_quoted_source_string(bytes: &[u8], quote: usize) -> Result<usize> {
    let mut index = quote + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Ok(index + 1),
            b'\n' | b'\r' => bail!("unterminated source string"),
            _ => index += 1,
        }
    }
    bail!("unterminated source string")
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
            compiler_timeout: None,
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

    #[cfg(unix)]
    #[test]
    fn only_hosted_builds_apply_strict_source_include_confinement() {
        let (directory, slang, yosys, filelist) = crate::compiler::tests::fake_compilers(false);
        fs::write(
            directory.path().join("top.sv"),
            "`include `HEADER\nmodule top; endmodule\n",
        )
        .unwrap();
        let options = BuildOptions {
            filelist,
            project_root: Some(directory.path().to_owned()),
            top: Some("top".to_owned()),
            elaboration: ElaborationOverrides::default(),
            slang_bin: Some(slang),
            yosys_bin: Some(yosys),
            compiler_timeout: None,
            debug_artifacts: false,
        };

        build_project(&options).unwrap();
        let error = match build_untrusted_project(&options) {
            Ok(_) => panic!("hosted builds must reject macro-expanded includes"),
            Err(error) => error,
        };
        assert!(
            format!("{error:#}").contains("literal double-quoted paths"),
            "{error:#}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn only_hosted_builds_confine_nested_filelists() {
        let (directory, slang, yosys, filelist) = crate::compiler::tests::fake_compilers(false);
        let shared = tempfile::tempdir().unwrap();
        let shared_filelist = shared.path().join("options.f");
        fs::write(&shared_filelist, "-D EXTERNAL_OPTIONS=1\n").unwrap();
        fs::write(
            &filelist,
            format!("-F {}\ntop.sv\n", shared_filelist.display()),
        )
        .unwrap();
        let options = BuildOptions {
            filelist,
            project_root: Some(directory.path().to_owned()),
            top: Some("top".to_owned()),
            elaboration: ElaborationOverrides::default(),
            slang_bin: Some(slang),
            yosys_bin: Some(yosys),
            compiler_timeout: None,
            debug_artifacts: false,
        };

        build_project(&options).unwrap();
        let error = match build_untrusted_project(&options) {
            Ok(_) => panic!("hosted builds must confine nested filelists"),
            Err(error) => error,
        };
        assert!(
            format!("{error:#}").contains("outside allowed root"),
            "{error:#}"
        );
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

    #[test]
    fn compiler_inputs_cannot_escape_the_project_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        let outside = directory.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("top.sv"), "module top; endmodule\n").unwrap();
        fs::write(root.join("project.f"), "+incdir+../outside\ntop.sv\n").unwrap();

        let project = crate::ir::normalize_filelist(root.join("project.f"), Some("top")).unwrap();
        let error = require_compiler_inputs_within(&root, &project).unwrap_err();
        assert!(error.to_string().contains("outside project root"));
    }

    #[test]
    fn source_includes_cannot_escape_the_project_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("project.f"), "top.sv\n").unwrap();
        fs::write(
            root.join("top.sv"),
            "// `include \"ignored.svh\"\n`include \"/proc/self/environ\"\nmodule top; endmodule\n",
        )
        .unwrap();

        let project = crate::ir::normalize_filelist(root.join("project.f"), Some("top")).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let error = require_source_includes_within(&root, &project).unwrap_err();
        assert!(format!("{error:#}").contains("absolute"), "{error:#}");
    }

    #[test]
    fn library_source_includes_cannot_escape_the_project_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        let library = root.join("library");
        fs::create_dir_all(&library).unwrap();
        fs::write(root.join("project.f"), "top.sv\n-y library\n").unwrap();
        fs::write(
            root.join("top.sv"),
            "module top; child instance(); endmodule\n",
        )
        .unwrap();
        fs::write(
            library.join("child.sv"),
            "`include \"/proc/self/environ\"\nmodule child; endmodule\n",
        )
        .unwrap();

        let project = crate::ir::normalize_filelist(root.join("project.f"), Some("top")).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let error = require_source_includes_within(&root, &project).unwrap_err();
        assert!(format!("{error:#}").contains("absolute"), "{error:#}");
    }

    #[test]
    fn source_include_parser_ignores_comments_and_strings() {
        let mut includes = Vec::new();
        visit_source_include_paths(
            "// `include \"ignored.svh\"\nstring value = \"`include \\\"also-ignored.svh\\\"\";\n`include \"used.svh\"\n",
            |include| {
                includes.push(include.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(includes, ["used.svh"]);
    }

    #[test]
    fn hosted_source_include_scan_is_size_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("large.sv");
        fs::write(
            &source,
            vec![b' '; usize::try_from(MAX_SOURCE_BYTES).unwrap() + 1],
        )
        .unwrap();

        let error = read_bounded_source_text(&source).unwrap_err();
        assert!(
            error.to_string().contains("hosted include-scan limit"),
            "{error:#}"
        );
    }
}
