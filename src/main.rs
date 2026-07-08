// SPDX-License-Identifier: Apache-2.0

//! Implements the CLI for building, inspecting, validating, and viewing bundles.
#![deny(missing_docs)]

use std::collections::BTreeMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use nettle::bundle::BundleReader;
use nettle::{
    BuildOptions, DefineOverride, ElaborationOverrides, MatchingPolicy, ParameterOverride,
    StartupBundle, StartupWorkspace, build_project, parse_define_override,
    parse_parameter_override, parse_undefine, serve_static,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Parser)]
#[command(
    name = "nettle",
    version,
    about = "Build and view portable Nettle RTL topology bundles"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Compile HDL sources into a deterministic .nettle bundle.
    Build(BuildArgs),
    /// Build a .nettle bundle and immediately serve it in the browser viewer.
    Render(RenderArgs),
    /// Validate a bundle's structure, hashes, schema, and payloads.
    Validate(BundlePath),
    /// Print safe manifest and design-summary metadata.
    Inspect(BundlePath),
    /// Serve the static viewer, optionally exposing one startup bundle.
    View(ViewArgs),
    /// Compare reference and candidate bundles in the browser viewer.
    Compare(CompareArgs),
}

#[derive(Debug, Args)]
struct BuildArgs {
    /// YAML build configuration. Relative paths are resolved from this file.
    #[arg(long, value_name = "PATH")]
    config: Option<PathBuf>,

    /// Slang-compatible root .f filelist.
    #[arg(long, required_unless_present = "config")]
    filelist: Option<PathBuf>,

    /// Output .nettle bundle.
    #[arg(short, long, required_unless_present = "config")]
    output: Option<PathBuf>,

    /// Explicit top module (overrides a top declared by the filelist).
    #[arg(long)]
    top: Option<String>,

    /// Boundary containing the filelist and every source embedded in the bundle.
    #[arg(long, value_name = "PATH")]
    project_root: Option<PathBuf>,

    /// Override a top-level parameter. Repeat as needed.
    #[arg(long = "param", value_name = "NAME=SV_EXPR", value_parser = parse_parameter_override)]
    parameters: Vec<ParameterOverride>,

    /// Define a preprocessor macro. Repeat as needed.
    #[arg(long = "define", value_name = "NAME[=VALUE]", value_parser = parse_define_override)]
    defines: Vec<DefineOverride>,

    /// Undefine a preprocessor macro. Repeat as needed.
    #[arg(long = "undefine", value_name = "NAME", value_parser = parse_undefine)]
    undefines: Vec<String>,

    /// Standalone Slang executable (otherwise discovered in PATH).
    #[arg(long, value_name = "PATH")]
    slang_bin: Option<PathBuf>,

    /// Yosys executable with yosys-slang (otherwise discovered in PATH).
    #[arg(long, value_name = "PATH")]
    yosys_bin: Option<PathBuf>,

    /// Include raw compiler JSON and transcripts under debug/.
    #[arg(long)]
    debug_artifacts: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct BuildInputConfig {
    filelist: Option<PathBuf>,
    output: Option<PathBuf>,
    top: Option<String>,
    project_root: Option<PathBuf>,
    parameters: BTreeMap<String, String>,
    defines: BTreeMap<String, Option<String>>,
    undefines: Vec<String>,
    slang_bin: Option<PathBuf>,
    yosys_bin: Option<PathBuf>,
    debug_artifacts: bool,
}

struct BuildInvocation {
    options: BuildOptions,
    output: PathBuf,
}

impl BuildArgs {
    fn resolve(self) -> Result<BuildInvocation> {
        let (config, base) = match &self.config {
            Some(path) => {
                let contents = fs::read_to_string(path)
                    .with_context(|| format!("reading build input config {}", path.display()))?;
                let config: BuildInputConfig = serde_yaml_ng::from_str(&contents)
                    .with_context(|| format!("parsing build input config {}", path.display()))?;
                let base = path
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .to_path_buf();
                (config, base)
            }
            None => (BuildInputConfig::default(), PathBuf::from(".")),
        };

        let config_path = |path: PathBuf| {
            if path.is_absolute() {
                path
            } else {
                base.join(path)
            }
        };
        let filelist = self
            .filelist
            .or_else(|| config.filelist.map(&config_path))
            .context("build requires --filelist or a config filelist")?;
        let output = self
            .output
            .or_else(|| config.output.map(&config_path))
            .context("build requires --output or a config output")?;

        let mut parameters: Vec<_> = config
            .parameters
            .into_iter()
            .map(|(name, value)| ParameterOverride { name, value })
            .collect();
        parameters.extend(self.parameters);
        let mut defines: Vec<_> = config
            .defines
            .into_iter()
            .map(|(name, value)| DefineOverride { name, value })
            .collect();
        defines.extend(self.defines);
        let mut undefines = config.undefines;
        undefines.extend(self.undefines);

        let options = BuildOptions {
            filelist,
            project_root: self
                .project_root
                .or_else(|| config.project_root.map(&config_path)),
            top: self.top.or(config.top),
            elaboration: ElaborationOverrides {
                parameters,
                defines,
                undefines,
            },
            slang_bin: self
                .slang_bin
                .or_else(|| config.slang_bin.map(&config_path)),
            yosys_bin: self
                .yosys_bin
                .or_else(|| config.yosys_bin.map(&config_path)),
            debug_artifacts: self.debug_artifacts || config.debug_artifacts,
        };
        options
            .elaboration
            .validate()
            .context("validating merged CLI and YAML elaboration overrides")?;
        Ok(BuildInvocation { options, output })
    }
}

#[derive(Debug, Args)]
struct BundlePath {
    /// Input .nettle bundle.
    bundle: PathBuf,
}

#[derive(Debug, Args)]
struct ViewArgs {
    /// Optional .nettle bundle to open automatically in the browser.
    bundle: Option<PathBuf>,

    #[command(flatten)]
    server: ViewerServerArgs,
}

#[derive(Debug, Args)]
struct CompareArgs {
    /// Reference .nettle bundle used as the comparison baseline.
    reference: PathBuf,

    /// Candidate .nettle bundle containing the proposed design.
    candidate: PathBuf,

    /// Graph-correspondence policy used to pair schematic objects.
    #[arg(long, value_enum, default_value = "conservative")]
    matching: MatchingPolicy,

    #[command(flatten)]
    server: ViewerServerArgs,
}

#[derive(Debug, Args)]
struct RenderArgs {
    #[command(flatten)]
    build: BuildArgs,

    #[command(flatten)]
    server: ViewerServerArgs,
}

#[derive(Debug, Args)]
struct ViewerServerArgs {
    /// Production Vite build containing index.html and assets/.
    #[arg(long, default_value = "web/dist")]
    web_root: PathBuf,

    /// Loopback address used by the optional local static server.
    #[arg(long, default_value_t = IpAddr::V4(Ipv4Addr::LOCALHOST))]
    bind_address: IpAddr,

    /// TCP port. Use 0 to let the operating system select one.
    #[arg(long, default_value_t = 8787)]
    port: u16,
}

fn build_bundle(args: BuildArgs) -> Result<PathBuf> {
    let invocation = args.resolve()?;
    let project = build_project(&invocation.options)?;
    let manifest = project
        .write(&invocation.output)
        .with_context(|| format!("writing {}", invocation.output.display()))?;
    println!(
        "wrote {} (snapshot {}, top {})",
        invocation.output.display(),
        manifest.snapshot_id,
        manifest.top
    );
    Ok(invocation.output)
}

fn validated_startup_bundle(path: &Path, role: &str) -> Result<StartupBundle> {
    StartupBundle::open(path)
        .with_context(|| format!("validating {role} bundle {}", path.display()))
}

fn validated_startup_comparison(
    reference: &Path,
    candidate: &Path,
    matching: MatchingPolicy,
) -> Result<StartupWorkspace> {
    let reference = validated_startup_bundle(reference, "reference")?;
    let candidate = validated_startup_bundle(candidate, "candidate")?;
    Ok(StartupWorkspace::Comparison {
        reference,
        candidate,
        matching,
    })
}

async fn serve_viewer(server: ViewerServerArgs, startup_workspace: StartupWorkspace) -> Result<()> {
    serve_static(
        &server.web_root,
        startup_workspace,
        server.bind_address,
        server.port,
    )
    .await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Build(args) => {
            build_bundle(args)?;
        }
        Command::Render(args) => {
            let output = build_bundle(args.build)?;
            let startup_bundle = validated_startup_bundle(&output, "startup")?;
            serve_viewer(
                args.server,
                StartupWorkspace::SingleBundle {
                    bundle: startup_bundle,
                },
            )
            .await?;
        }
        Command::Validate(args) => {
            let mut bundle = BundleReader::open(&args.bundle)
                .with_context(|| format!("opening {}", args.bundle.display()))?;
            bundle.validate_all()?;
            println!("{} is a valid .nettle bundle", args.bundle.display());
        }
        Command::Inspect(args) => {
            let mut bundle = BundleReader::open(&args.bundle)
                .with_context(|| format!("opening {}", args.bundle.display()))?;
            let manifest = bundle.manifest().clone();
            let index = bundle.design_index()?;
            let sources = bundle.source_index()?;
            let diagnostics = bundle.diagnostics()?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "formatVersion": manifest.format_version,
                    "producer": manifest.producer,
                    "snapshotId": manifest.snapshot_id,
                    "top": manifest.top,
                    "modules": index.modules.len(),
                    "sources": sources.files.len(),
                    "diagnostics": diagnostics.len(),
                    "features": manifest.features,
                }))?
            );
        }
        Command::View(args) => {
            let startup_workspace = match args.bundle {
                Some(bundle) => StartupWorkspace::SingleBundle {
                    bundle: validated_startup_bundle(&bundle, "startup")?,
                },
                None => StartupWorkspace::Empty,
            };
            serve_viewer(args.server, startup_workspace).await?;
        }
        Command::Compare(args) => {
            let startup_workspace =
                validated_startup_comparison(&args.reference, &args.candidate, args.matching)?;
            serve_viewer(args.server, startup_workspace).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser, error::ErrorKind};
    use nettle::bundle::{BuildMetadata, BundleContents, write_bundle};
    use nettle::ir::{DesignSnapshot, GraphEdge, GraphModule, GraphSlice};

    use super::*;

    fn write_test_bundle(path: &Path, snapshot_id: &str, dangling_edge: bool) {
        let edges = dangling_edge
            .then(|| GraphEdge {
                id: "dangling-edge".to_owned(),
                source_node: "missing-source".to_owned(),
                source_port: None,
                target_node: "missing-target".to_owned(),
                target_port: None,
                label: None,
                width: None,
                signal_type: None,
                origins: vec![],
            })
            .into_iter()
            .collect();
        let slice = GraphSlice {
            snapshot_id: snapshot_id.to_owned(),
            module: GraphModule {
                id: format!("{snapshot_id}-module"),
                name: "top".to_owned(),
                instance_path: "top".to_owned(),
                definition_name: "top".to_owned(),
                parameters: BTreeMap::new(),
                attributes: BTreeMap::new(),
            },
            nodes: vec![],
            edges,
            groups: vec![],
            files: None,
        };
        let snapshot = DesignSnapshot {
            snapshot_id: snapshot_id.to_owned(),
            top: "top".to_owned(),
            tops: vec!["top".to_owned()],
            modules: BTreeMap::from([("top".to_owned(), slice)]),
        };
        write_bundle(
            path,
            &BundleContents {
                snapshot: &snapshot,
                sources: &[],
                diagnostics: &[],
                build: &BuildMetadata::default(),
                debug_artifacts: &[],
            },
        )
        .unwrap();
    }

    #[test]
    fn cli_schema_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn requires_an_explicit_subcommand() {
        let error = Cli::try_parse_from(["nettle"]).unwrap_err();
        assert_eq!(
            error.kind(),
            ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
        );
    }

    #[test]
    fn build_requires_filelist_and_output() {
        let error = Cli::try_parse_from(["nettle", "build", "--filelist", "top.f"]).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::MissingRequiredArgument);
        assert!(error.to_string().contains("--output"));

        let error = Cli::try_parse_from(["nettle", "render", "--filelist", "top.f"]).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::MissingRequiredArgument);
        assert!(error.to_string().contains("--output"));
    }

    #[test]
    fn parses_build_overrides_and_debug_mode() {
        let cli = Cli::try_parse_from([
            "nettle",
            "build",
            "--filelist",
            "top.f",
            "--output",
            "top.nettle",
            "--top",
            "top",
            "--param",
            "WIDTH=16",
            "--define",
            "SYNTHESIS",
            "--undefine",
            "SIMULATION",
            "--debug-artifacts",
        ])
        .unwrap();
        let Command::Build(args) = cli.command else {
            panic!("expected build command");
        };
        assert_eq!(args.parameters[0].value, "16");
        assert!(args.debug_artifacts);
    }

    #[test]
    fn resolves_yaml_build_config_relative_paths_and_overrides() {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("build.yaml");
        fs::write(
            &config_path,
            r#"
filelist: rtl/project.f
output: out/design.nettle
project_root: rtl
top: configured_top
parameters:
  DEPTH: "32"
  WIDTH: "16"
defines:
  NUM_HARTS: "4"
  SYNTHESIS: null
undefines: [SIMULATION]
debug_artifacts: true
"#,
        )
        .unwrap();
        let cli = Cli::try_parse_from([
            "nettle",
            "build",
            "--config",
            config_path.to_str().unwrap(),
            "--top",
            "cli_top",
        ])
        .unwrap();
        let Command::Build(args) = cli.command else {
            panic!("expected build command");
        };

        let invocation = args.resolve().unwrap();
        assert_eq!(
            invocation.options.filelist,
            directory.path().join("rtl/project.f")
        );
        assert_eq!(
            invocation.output,
            directory.path().join("out/design.nettle")
        );
        assert_eq!(invocation.options.top.as_deref(), Some("cli_top"));
        assert_eq!(invocation.options.elaboration.parameters.len(), 2);
        assert_eq!(invocation.options.elaboration.defines.len(), 2);
        assert_eq!(invocation.options.elaboration.undefines, ["SIMULATION"]);
        assert!(invocation.options.debug_artifacts);
    }

    #[test]
    fn rejects_unknown_yaml_fields() {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("build.yaml");
        fs::write(
            &config_path,
            "filelist: top.f\noutput: top.nettle\nunknown_setting: true\n",
        )
        .unwrap();
        let cli =
            Cli::try_parse_from(["nettle", "build", "--config", config_path.to_str().unwrap()])
                .unwrap();
        let Command::Build(args) = cli.command else {
            panic!("expected build command");
        };

        let error = args.resolve().err().unwrap();
        assert!(error.to_string().contains("parsing build input config"));
        assert!(format!("{error:#}").contains("unknown field `unknown_setting`"));
    }

    #[test]
    fn parses_an_optional_view_bundle() {
        let cli =
            Cli::try_parse_from(["nettle", "view", "design.nettle", "--port", "9000"]).unwrap();
        let Command::View(args) = cli.command else {
            panic!("expected view command");
        };
        assert_eq!(args.bundle, Some(PathBuf::from("design.nettle")));
        assert_eq!(args.server.port, 9000);
    }

    #[test]
    fn parses_compare_with_conservative_matching_by_default() {
        let cli = Cli::try_parse_from([
            "nettle",
            "compare",
            "reference.nettle",
            "candidate.nettle",
            "--port",
            "9002",
        ])
        .unwrap();
        let Command::Compare(args) = cli.command else {
            panic!("expected compare command");
        };
        assert_eq!(args.reference, PathBuf::from("reference.nettle"));
        assert_eq!(args.candidate, PathBuf::from("candidate.nettle"));
        assert_eq!(args.matching, MatchingPolicy::Conservative);
        assert_eq!(args.server.port, 9002);
    }

    #[test]
    fn parses_compare_with_aggressive_matching() {
        let cli = Cli::try_parse_from([
            "nettle",
            "compare",
            "reference.nettle",
            "candidate.nettle",
            "--matching",
            "aggressive",
        ])
        .unwrap();
        let Command::Compare(args) = cli.command else {
            panic!("expected compare command");
        };
        assert_eq!(args.matching, MatchingPolicy::Aggressive);
    }

    #[test]
    fn compare_requires_two_bundles_and_a_known_policy() {
        let missing_candidate =
            Cli::try_parse_from(["nettle", "compare", "reference.nettle"]).unwrap_err();
        assert_eq!(missing_candidate.kind(), ErrorKind::MissingRequiredArgument);

        let unknown_policy = Cli::try_parse_from([
            "nettle",
            "compare",
            "reference.nettle",
            "candidate.nettle",
            "--matching",
            "speculative",
        ])
        .unwrap_err();
        assert_eq!(unknown_policy.kind(), ErrorKind::InvalidValue);
        assert!(unknown_policy.to_string().contains("conservative"));
        assert!(unknown_policy.to_string().contains("aggressive"));
    }

    #[test]
    fn comparison_validates_and_snapshots_both_bundles() {
        let directory = tempfile::tempdir().unwrap();
        let reference = directory.path().join("reference.nettle");
        let candidate = directory.path().join("candidate.nettle");
        write_test_bundle(&reference, "reference-snapshot", false);
        write_test_bundle(&candidate, "candidate-snapshot", false);

        let workspace =
            validated_startup_comparison(&reference, &candidate, MatchingPolicy::Aggressive)
                .unwrap();
        let StartupWorkspace::Comparison {
            reference: reference_snapshot,
            candidate: candidate_snapshot,
            matching,
        } = workspace
        else {
            panic!("expected comparison workspace");
        };
        assert_eq!(matching, MatchingPolicy::Aggressive);
        assert_eq!(reference_snapshot.name(), "reference.nettle");
        assert_eq!(candidate_snapshot.name(), "candidate.nettle");
        assert_eq!(
            reference_snapshot.byte_len(),
            fs::metadata(reference).unwrap().len()
        );
        assert_eq!(
            candidate_snapshot.byte_len(),
            fs::metadata(candidate).unwrap().len()
        );
    }

    #[test]
    fn comparison_rejects_a_candidate_that_fails_full_bundle_validation() {
        let directory = tempfile::tempdir().unwrap();
        let reference = directory.path().join("reference.nettle");
        let candidate = directory.path().join("candidate.nettle");
        write_test_bundle(&reference, "reference-snapshot", false);
        write_test_bundle(&candidate, "candidate-snapshot", true);

        let error =
            validated_startup_comparison(&reference, &candidate, MatchingPolicy::Conservative)
                .unwrap_err();
        assert!(
            error.to_string().contains("validating candidate bundle"),
            "{error:#}"
        );
        assert!(format!("{error:#}").contains("missing source node"));
    }

    #[test]
    fn parses_render_as_combined_build_and_view() {
        let cli = Cli::try_parse_from([
            "nettle",
            "render",
            "--filelist",
            "top.f",
            "--output",
            "top.nettle",
            "--top",
            "top",
            "--web-root",
            "dist",
            "--bind-address",
            "127.0.0.1",
            "--port",
            "9001",
        ])
        .unwrap();
        let Command::Render(args) = cli.command else {
            panic!("expected render command");
        };
        let invocation = args.build.resolve().unwrap();
        assert_eq!(invocation.options.filelist, PathBuf::from("top.f"));
        assert_eq!(invocation.options.top.as_deref(), Some("top"));
        assert_eq!(invocation.output, PathBuf::from("top.nettle"));
        assert_eq!(args.server.web_root, PathBuf::from("dist"));
        assert_eq!(args.server.port, 9001);
    }
}
