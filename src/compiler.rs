// SPDX-License-Identifier: Apache-2.0

//! Discovers and runs Slang and yosys-slang with the same validated settings.

use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::ir::{Diagnostic, DiagnosticSeverity, SourceOrigin, normalize_filelist};
use crate::resource_limits::native::compiler::{
    DIAGNOSTICS_JSON_BYTES as MAX_DIAGNOSTICS_JSON_BYTES,
    ERROR_OUTPUT_BYTES as MAX_ERROR_OUTPUT_BYTES, MODEL_JSON_BYTES as MAX_COMPILER_MODEL_BYTES,
    PROCESS_OUTPUT_BYTES as MAX_PROCESS_OUTPUT_BYTES,
};
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

static TEMP_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
/// External compiler invocation inputs after project normalization.
pub struct CompilerOptions {
    /// Canonical root filelist.
    pub filelist: PathBuf,
    /// Explicit top module compiled by both tool paths.
    pub top: String,
    /// Shared elaboration overrides.
    pub elaboration: ElaborationOverrides,
    /// Optional standalone Slang executable override.
    pub slang_bin: Option<PathBuf>,
    /// Optional Yosys executable override.
    pub yosys_bin: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// User overrides applied consistently to Slang and yosys-slang.
pub struct ElaborationOverrides {
    #[serde(default)]
    /// Top-level parameter overrides.
    pub parameters: Vec<ParameterOverride>,
    #[serde(default)]
    /// Preprocessor definitions.
    pub defines: Vec<DefineOverride>,
    #[serde(default)]
    /// Preprocessor macro names to undefine.
    pub undefines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// One raw top-level SystemVerilog parameter override.
pub struct ParameterOverride {
    /// Parameter identifier.
    pub name: String,
    /// Raw single-line SystemVerilog expression.
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// One preprocessor macro definition override.
pub struct DefineOverride {
    /// Macro identifier.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Optional raw macro value; `None` represents a valueless definition.
    pub value: Option<String>,
}

impl ElaborationOverrides {
    /// Validates names, values, duplicates, and define/undefine conflicts.
    pub fn validate(&self) -> Result<()> {
        let mut parameter_names = std::collections::BTreeSet::new();
        for parameter in &self.parameters {
            validate_identifier("parameter", &parameter.name)?;
            validate_value("parameter", &parameter.name, &parameter.value, false)?;
            if !parameter_names.insert(parameter.name.as_str()) {
                bail!("duplicate parameter override {:?}", parameter.name);
            }
        }
        let mut define_names = std::collections::BTreeSet::new();
        for define in &self.defines {
            validate_identifier("preprocessor define", &define.name)?;
            if let Some(value) = &define.value {
                validate_value("preprocessor define", &define.name, value, false)?;
            }
            if !define_names.insert(define.name.as_str()) {
                bail!("duplicate preprocessor define {:?}", define.name);
            }
        }
        let mut undefine_names = std::collections::BTreeSet::new();
        for name in &self.undefines {
            validate_identifier("preprocessor undefine", name)?;
            if !undefine_names.insert(name.as_str()) {
                bail!("duplicate preprocessor undefine {name:?}");
            }
            if define_names.contains(name.as_str()) {
                bail!("preprocessor macro {name:?} cannot be both defined and undefined");
            }
        }
        Ok(())
    }

    fn is_empty(&self) -> bool {
        self.parameters.is_empty() && self.defines.is_empty() && self.undefines.is_empty()
    }
}

/// Parses a `NAME=SV_EXPR` command-line parameter override.
pub fn parse_parameter_override(value: &str) -> Result<ParameterOverride, String> {
    let (name, value) = value
        .split_once('=')
        .ok_or_else(|| "expected NAME=SYSTEMVERILOG_EXPRESSION".to_owned())?;
    let parsed = ParameterOverride {
        name: name.to_owned(),
        value: value.to_owned(),
    };
    ElaborationOverrides {
        parameters: vec![parsed.clone()],
        ..ElaborationOverrides::default()
    }
    .validate()
    .map_err(|error| error.to_string())?;
    Ok(parsed)
}

/// Parses a `NAME` or `NAME=VALUE` command-line macro definition.
pub fn parse_define_override(value: &str) -> Result<DefineOverride, String> {
    let (name, value) = value
        .split_once('=')
        .map_or((value, None), |(name, value)| {
            (name, Some(value.to_owned()))
        });
    let parsed = DefineOverride {
        name: name.to_owned(),
        value,
    };
    ElaborationOverrides {
        defines: vec![parsed.clone()],
        ..ElaborationOverrides::default()
    }
    .validate()
    .map_err(|error| error.to_string())?;
    Ok(parsed)
}

/// Parses and validates a command-line macro undefinition.
pub fn parse_undefine(value: &str) -> Result<String, String> {
    ElaborationOverrides {
        undefines: vec![value.to_owned()],
        ..ElaborationOverrides::default()
    }
    .validate()
    .map_err(|error| error.to_string())?;
    Ok(value.to_owned())
}

fn validate_identifier(kind: &str, name: &str) -> Result<()> {
    let mut characters = name.chars();
    let valid = characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && characters
            .all(|character| character.is_ascii_alphanumeric() || "_$".contains(character));
    if !valid {
        bail!(
            "{kind} name {name:?} must be a simple SystemVerilog identifier beginning with a letter or underscore"
        );
    }
    Ok(())
}

fn validate_value(kind: &str, name: &str, value: &str, allow_empty: bool) -> Result<()> {
    if (!allow_empty && value.is_empty()) || value.contains(['\0', '\n', '\r']) {
        bail!(
            "{kind} {name:?} has an invalid value; values must be single-line{}",
            if allow_empty { "" } else { " and non-empty" }
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
/// Discovered compiler identity reported to bundle metadata.
pub struct ToolReport {
    /// Compiler name.
    pub name: String,
    /// Resolved executable path used during the build.
    pub path: String,
    /// Compiler-reported version.
    pub version: String,
}

#[derive(Debug)]
/// Raw outputs returned by the paired compiler execution.
pub struct CompilerArtifacts {
    /// Yosys connectivity JSON.
    pub yosys_json: String,
    /// Elaborated Slang AST JSON with source information.
    pub slang_ast_json: String,
    /// Base used by yosys-slang when it relativized source attributes. This
    /// can name a private command-file directory after that directory has been
    /// removed, so callers normalize `..` lexically before canonicalizing.
    pub source_path_base: PathBuf,
    /// Normalized standalone Slang diagnostics.
    pub diagnostics: Vec<Diagnostic>,
    /// Compiler identities and versions.
    pub tools: Vec<ToolReport>,
    /// Captured standard streams for optional debug bundles.
    pub transcripts: Vec<CompilerTranscript>,
}

#[derive(Debug, Clone)]
/// Captured output from one compiler subprocess.
pub struct CompilerTranscript {
    /// Compiler name.
    pub tool: String,
    /// Captured standard output.
    pub stdout: String,
    /// Captured standard error.
    pub stderr: String,
}

#[derive(Debug)]
struct ProcessCapture {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

#[derive(Debug)]
struct SlangOutput {
    capture: ProcessCapture,
    diagnostics: Vec<Diagnostic>,
    ast_json: String,
}

/// Probes the external compilers, then runs them concurrently from the same
/// root `-F` filelist and with the same elaboration settings.
pub fn compile_filelist(options: &CompilerOptions) -> Result<CompilerArtifacts> {
    compile_filelist_with_timeout(options, None)
}

/// Compiles a filelist, terminating each compiler process after an optional deadline.
pub fn compile_filelist_with_timeout(
    options: &CompilerOptions,
    compiler_timeout: Option<Duration>,
) -> Result<CompilerArtifacts> {
    let filelist = fs::canonicalize(&options.filelist)
        .with_context(|| format!("locating root filelist {}", options.filelist.display()))?;
    // Parse before discovering or launching either compiler. The normalizer
    // rejects options outside Nettle's supported, side-effect-free subset, so
    // a project command file cannot activate compiler output paths or other
    // vendor-specific side effects under the invoking user's privileges.
    normalize_filelist(&filelist, Some(&options.top)).context("validating compiler filelist")?;
    let project_root = filelist
        .parent()
        .ok_or_else(|| anyhow!("root filelist has no parent directory"))?;
    let slang = discover_binary(options.slang_bin.as_deref(), "slang").with_context(|| {
        "standalone Slang is required in compiler mode; install Slang v11+ or pass --slang-bin /path/to/slang"
    })?;
    let yosys = discover_binary(options.yosys_bin.as_deref(), "yosys").with_context(|| {
        "Yosys with the yosys-slang plugin is required in compiler mode; install OSS CAD Suite or pass --yosys-bin /path/to/yosys"
    })?;

    let (slang_report, yosys_report) = std::thread::scope(|scope| {
        let slang_probe = scope.spawn(|| probe_slang(&slang, project_root, compiler_timeout));
        let yosys_probe = scope.spawn(|| probe_yosys(&yosys, project_root, compiler_timeout));
        (
            join_worker("Slang capability probe", slang_probe),
            join_worker("Yosys capability probe", yosys_probe),
        )
    });
    let slang_report = slang_report?;
    let yosys_report = yosys_report?;

    let output_dir = PrivateTempDir::create()?;
    options.elaboration.validate()?;
    let compiler_filelist = prepare_compiler_filelist(
        &filelist,
        project_root,
        &options.elaboration,
        output_dir.path(),
    )?;
    let diagnostics_path = output_dir.path().join("slang-diagnostics.json");
    let ast_path = output_dir.path().join("slang-ast.json");
    let yosys_json_path = output_dir.path().join("netlist.json");
    let yosys_script_path = output_dir.path().join("compile.ys");
    write_private_file(
        &yosys_script_path,
        &yosys_script(&compiler_filelist.path, &options.top, &yosys_json_path)?,
    )?;

    let (slang_output, yosys_output) = std::thread::scope(|scope| {
        let slang_worker = scope.spawn(|| {
            run_slang(
                &slang,
                project_root,
                &compiler_filelist.path,
                &options.top,
                &diagnostics_path,
                &ast_path,
                compiler_timeout,
            )
        });
        let yosys_worker = scope.spawn(|| {
            run_yosys(
                &yosys,
                &compiler_filelist.yosys_cwd,
                &yosys_script_path,
                &yosys_json_path,
                compiler_timeout,
            )
        });
        (
            join_worker("standalone Slang compilation", slang_worker),
            join_worker("Yosys lowering", yosys_worker),
        )
    });

    // Report both failures when possible; one compiler often has the more
    // actionable diagnostic for a shared source problem.
    let (slang_output, yosys_output) = match (slang_output, yosys_output) {
        (Ok(slang), Ok(yosys)) => (slang, yosys),
        (Err(slang), Err(yosys)) => {
            bail!("both compiler passes failed:\n\nSlang: {slang:#}\n\nYosys: {yosys:#}")
        }
        (Err(error), Ok(_)) => return Err(error),
        (Ok(_), Err(error)) => return Err(error),
    };
    let yosys_json = read_text_file_with_limit(
        &yosys_json_path,
        MAX_COMPILER_MODEL_BYTES,
        "Yosys JSON netlist",
    )?;

    Ok(CompilerArtifacts {
        yosys_json,
        slang_ast_json: slang_output.ast_json,
        source_path_base: compiler_filelist.yosys_cwd,
        diagnostics: slang_output.diagnostics,
        tools: vec![slang_report, yosys_report],
        transcripts: vec![
            CompilerTranscript {
                tool: "slang".to_owned(),
                stdout: slang_output.capture.stdout,
                stderr: slang_output.capture.stderr,
            },
            CompilerTranscript {
                tool: "yosys".to_owned(),
                stdout: yosys_output.stdout,
                stderr: yosys_output.stderr,
            },
        ],
    })
}

fn discover_binary(explicit: Option<&Path>, default_name: &str) -> Result<PathBuf> {
    let requested = explicit.unwrap_or_else(|| Path::new(default_name));
    if requested.components().count() > 1 || requested.is_absolute() {
        return fs::canonicalize(requested)
            .with_context(|| format!("cannot access executable {}", requested.display()));
    }

    let path = env::var_os("PATH").unwrap_or_default();
    let candidate_names = executable_names(requested);
    for directory in env::split_paths(&path) {
        for name in &candidate_names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return fs::canonicalize(&candidate).or(Ok(candidate));
            }
        }
    }
    bail!(
        "executable {:?} was not found in PATH",
        requested.to_string_lossy()
    )
}

fn executable_names(requested: &Path) -> Vec<OsString> {
    let name = requested.as_os_str().to_owned();
    #[cfg(windows)]
    {
        if requested.extension().is_some() {
            return vec![name];
        }
        let extensions = env::var_os("PATHEXT").unwrap_or_else(|| ".EXE;.CMD;.BAT".into());
        let mut names = vec![name.clone()];
        names.extend(
            extensions
                .to_string_lossy()
                .split(';')
                .filter(|extension| !extension.is_empty())
                .map(|extension| {
                    let mut candidate = name.clone();
                    candidate.push(extension);
                    candidate
                }),
        );
        names
    }
    #[cfg(not(windows))]
    {
        vec![name]
    }
}

fn probe_slang(program: &Path, cwd: &Path, timeout: Option<Duration>) -> Result<ToolReport> {
    let version = run_checked(
        program,
        [OsStr::new("--version")],
        cwd,
        "Slang version probe",
        timeout,
    )?;
    let help = run_checked(
        program,
        [OsStr::new("--help")],
        cwd,
        "Slang help probe",
        timeout,
    )?;
    let capabilities = combined_output(&help);
    for required in ["-F", "--top", "--diag-json", "--ast-json", "-D", "-U", "-G"] {
        if !capabilities.contains(required) {
            bail!(
                "standalone Slang at {} does not advertise required option {required}; install Slang v11+ or select a compatible binary with --slang-bin",
                program.display()
            );
        }
    }
    Ok(ToolReport {
        name: "slang".to_owned(),
        path: program.to_string_lossy().into_owned(),
        version: first_nonempty_line(&combined_output(&version)),
    })
}

fn probe_yosys(program: &Path, cwd: &Path, timeout: Option<Duration>) -> Result<ToolReport> {
    let version = run_checked(
        program,
        [OsStr::new("-V")],
        cwd,
        "Yosys version probe",
        timeout,
    )?;
    let plugin_args = [
        OsStr::new("-Q"),
        OsStr::new("-m"),
        OsStr::new("slang"),
        OsStr::new("-p"),
        OsStr::new("help read_slang"),
    ];
    let plugin = run_checked(
        program,
        plugin_args,
        cwd,
        "yosys-slang plugin capability probe",
        timeout,
    )
    .with_context(|| {
        format!(
            "Yosys at {} could not load the yosys-slang plugin; install a current OSS CAD Suite or select a compatible binary with --yosys-bin",
            program.display()
        )
    })?;
    let capabilities = combined_output(&plugin);
    for required in [
        "read_slang",
        "best-effort-hierarchy",
        "no-synthesis-define",
        "-D",
        "-U",
        "-G",
    ] {
        if !capabilities.contains(required) {
            bail!(
                "yosys-slang at {} does not advertise required capability {required:?}; install a compatible plugin build",
                program.display()
            );
        }
    }
    Ok(ToolReport {
        name: "yosys".to_owned(),
        path: program.to_string_lossy().into_owned(),
        version: first_nonempty_line(&combined_output(&version)),
    })
}

fn run_slang(
    program: &Path,
    cwd: &Path,
    filelist: &Path,
    top: &str,
    diagnostics_path: &Path,
    ast_path: &Path,
    timeout: Option<Duration>,
) -> Result<SlangOutput> {
    let args = vec![
        OsString::from("-F"),
        filelist.as_os_str().to_owned(),
        OsString::from("--top"),
        OsString::from(top),
        OsString::from("--diag-json"),
        diagnostics_path.as_os_str().to_owned(),
        OsString::from("--diag-abs-paths"),
        OsString::from("--ast-json"),
        ast_path.as_os_str().to_owned(),
        OsString::from("--ast-json-source-info"),
        OsString::from("--quiet"),
    ];
    let capture = run_checked(
        program,
        args.iter().map(OsString::as_os_str),
        cwd,
        "standalone Slang full elaboration",
        timeout,
    )
    .with_context(|| {
        "Slang rejected the project; inspect the captured diagnostics above, or rerun the displayed command directly"
    })?;
    let diagnostics_json = read_text_file_with_limit(
        diagnostics_path,
        MAX_DIAGNOSTICS_JSON_BYTES,
        "Slang JSON diagnostics",
    )?;
    let ast_json =
        read_text_file_with_limit(ast_path, MAX_COMPILER_MODEL_BYTES, "Slang elaborated AST")?;
    let diagnostics = parse_slang_diagnostics(&diagnostics_json)
        .context("parsing standalone Slang JSON diagnostics")?;
    Ok(SlangOutput {
        capture,
        diagnostics,
        ast_json,
    })
}

fn run_yosys(
    program: &Path,
    cwd: &Path,
    script_path: &Path,
    output_path: &Path,
    timeout: Option<Duration>,
) -> Result<ProcessCapture> {
    let args = [
        OsStr::new("-Q"),
        OsStr::new("-m"),
        OsStr::new("slang"),
        OsStr::new("-s"),
        script_path.as_os_str(),
    ];
    let capture = run_checked(program, args, cwd, "Yosys + yosys-slang lowering", timeout)
        .with_context(|| {
            "Yosys failed to lower the project; verify that the selected Yosys and slang plugin versions are compatible"
        })?;
    fs::metadata(output_path).with_context(|| {
        format!(
            "Yosys exited successfully but did not write {}",
            output_path.display()
        )
    })?;
    Ok(capture)
}

fn run_checked<'a>(
    program: &Path,
    args: impl IntoIterator<Item = &'a OsStr>,
    cwd: &Path,
    purpose: &str,
    timeout: Option<Duration>,
) -> Result<ProcessCapture> {
    let args: Vec<OsString> = args.into_iter().map(OsStr::to_owned).collect();
    let mut command = Command::new(program);
    command
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        command.process_group(0);
    }
    let mut child = command.spawn().with_context(|| {
        format!(
            "could not start {purpose}: {}",
            format_command(program, &args)
        )
    })?;
    let stdout = child.stdout.take().expect("stdout was configured as piped");
    let stderr = child.stderr.take().expect("stderr was configured as piped");
    let stdout_reader = thread::spawn(move || read_bounded_output(stdout));
    let stderr_reader = thread::spawn(move || read_bounded_output(stderr));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().with_context(|| {
            format!(
                "could not wait for {purpose}: {}",
                format_command(program, &args)
            )
        })? {
            break status;
        }
        if timeout.is_some_and(|deadline| started.elapsed() >= deadline) {
            terminate_process_group(&mut child);
            let _ = child.wait();
            let stdout = stdout_reader
                .join()
                .map_err(|_| anyhow!("stdout reader panicked while running {purpose}"))??;
            let stderr = stderr_reader
                .join()
                .map_err(|_| anyhow!("stderr reader panicked while running {purpose}"))??;
            bail!(
                "{purpose} timed out after {} seconds\ncommand: {}\nstdout:\n{}\nstderr:\n{}",
                timeout.expect("timeout was checked").as_secs(),
                format_command(program, &args),
                truncate_output(&stdout),
                truncate_output(&stderr)
            );
        }
        thread::sleep(Duration::from_millis(50));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| anyhow!("stdout reader panicked while running {purpose}"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| anyhow!("stderr reader panicked while running {purpose}"))??;
    let capture = ProcessCapture {
        status,
        stdout,
        stderr,
    };
    if !capture.status.success() {
        bail!(
            "{purpose} failed with {}\ncommand: {}\nstdout:\n{}\nstderr:\n{}",
            display_status(capture.status),
            format_command(program, &args),
            truncate_output(&capture.stdout),
            truncate_output(&capture.stderr)
        );
    }
    Ok(capture)
}

#[cfg(unix)]
fn terminate_process_group(child: &mut std::process::Child) {
    let _ = Command::new("/bin/kill")
        .arg("-KILL")
        .arg(format!("-{}", child.id()))
        .status();
    let _ = child.kill();
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut std::process::Child) {
    let _ = child.kill();
}

fn read_bounded_output(mut reader: impl Read) -> io::Result<String> {
    let mut retained = Vec::with_capacity(MAX_PROCESS_OUTPUT_BYTES);
    let mut omitted = 0usize;
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = MAX_PROCESS_OUTPUT_BYTES.saturating_sub(retained.len());
        let keep = remaining.min(count);
        retained.extend_from_slice(&buffer[..keep]);
        omitted = omitted.saturating_add(count - keep);
    }
    let mut output = String::from_utf8_lossy(&retained).into_owned();
    if omitted > 0 {
        output.push_str(&format!(
            "\n... <{omitted} bytes omitted from compiler output>"
        ));
    }
    Ok(output)
}

fn read_text_file_with_limit(path: &Path, limit: usize, description: &str) -> Result<String> {
    let file = fs::File::open(path)
        .with_context(|| format!("{description} was not produced at {}", path.display()))?;
    let read_limit = u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1);
    let mut bytes = Vec::new();
    file.take(read_limit)
        .read_to_end(&mut bytes)
        .with_context(|| format!("could not read {description} at {}", path.display()))?;
    if bytes.len() > limit {
        bail!(
            "{description} at {} exceeds the supported size limit of {limit} bytes",
            path.display()
        );
    }
    String::from_utf8(bytes)
        .with_context(|| format!("{description} at {} is not valid UTF-8", path.display()))
}

fn format_command(program: &Path, args: &[OsString]) -> String {
    std::iter::once(program.as_os_str())
        .chain(args.iter().map(OsString::as_os_str))
        .map(|argument| format!("{:?}", argument.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ")
}

fn display_status(status: ExitStatus) -> String {
    status.code().map_or_else(
        || "termination by signal".to_owned(),
        |code| format!("exit code {code}"),
    )
}

fn truncate_output(output: &str) -> String {
    if output.len() <= MAX_ERROR_OUTPUT_BYTES {
        return output.to_owned();
    }
    let mut end = MAX_ERROR_OUTPUT_BYTES;
    while !output.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n... <{} bytes omitted>",
        &output[..end],
        output.len() - end
    )
}

fn combined_output(capture: &ProcessCapture) -> String {
    format!("{}\n{}", capture.stdout, capture.stderr)
}

fn first_nonempty_line(output: &str) -> String {
    output
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .unwrap_or("unknown version")
        .to_owned()
}

#[derive(Debug)]
struct PreparedCompilerFilelist {
    path: PathBuf,
    yosys_cwd: PathBuf,
}

fn prepare_compiler_filelist(
    filelist: &Path,
    project_root: &Path,
    elaboration: &ElaborationOverrides,
    output_dir: &Path,
) -> Result<PreparedCompilerFilelist> {
    if elaboration.is_empty() {
        return Ok(PreparedCompilerFilelist {
            path: filelist.to_path_buf(),
            yosys_cwd: project_root.to_path_buf(),
        });
    }

    // Nest the user's original filelist instead of flattening it. This retains
    // every Slang option and its operand exactly, including vendor options that
    // Nettle records as unknown metadata. Slang keeps the first -D / -G value
    // for a name, while -U applies globally, so explicit entries precede the
    // nested list to take precedence without shell interpolation.
    let path = output_dir.join("normalized-project.f");
    write_private_file(&path, &render_override_filelist(filelist, elaboration)?)?;
    Ok(PreparedCompilerFilelist {
        path,
        // yosys-slang does not strip quotes around command-file paths, so the
        // Yosys script uses the safe basename and runs beside the private file.
        yosys_cwd: output_dir.to_path_buf(),
    })
}

fn render_override_filelist(filelist: &Path, elaboration: &ElaborationOverrides) -> Result<String> {
    let filelist = filelist.to_str().ok_or_else(|| {
        anyhow!(
            "root filelist path is not valid UTF-8 and cannot be nested in a Slang command file"
        )
    })?;
    let mut lines = vec![];
    for define in &elaboration.defines {
        let definition = define.value.as_ref().map_or_else(
            || define.name.clone(),
            |value| format!("{}={value}", define.name),
        );
        lines.push(format!("-D {}", command_file_token(&definition)?));
    }
    for name in &elaboration.undefines {
        lines.push(format!("-U {}", command_file_token(name)?));
    }
    for parameter in &elaboration.parameters {
        lines.push(format!(
            "-G {}",
            command_file_token(&format!("{}={}", parameter.name, parameter.value))?
        ));
    }
    lines.push(format!("-F {}", command_file_token(filelist)?));
    Ok(format!("{}\n", lines.join("\n")))
}

fn command_file_token(value: &str) -> Result<String> {
    if value.contains(['\0', '\n', '\r']) {
        bail!("Slang command-file arguments cannot contain NUL or newline characters");
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn yosys_script(filelist: &Path, top: &str, output: &Path) -> Result<String> {
    let filelist_name = filelist
        .file_name()
        .ok_or_else(|| anyhow!("root filelist has no filename"))?;
    Ok(format!(
        "read_slang --best-effort-hierarchy --no-synthesis-define -F {} --top {}\nhierarchy -top {}\nproc -noopt\nwrite_json {}\n",
        yosys_slang_token(Path::new(filelist_name))?,
        yosys_identifier_token(top)?,
        yosys_identifier_token(top)?,
        yosys_quote(output.as_os_str())?
    ))
}

fn yosys_identifier_token(identifier: &str) -> Result<&str> {
    if identifier.is_empty()
        || !identifier
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.$\\".contains(character))
    {
        bail!(
            "top module name {:?} cannot be represented safely in a Yosys script; use a simple SystemVerilog identifier",
            identifier
        );
    }
    Ok(identifier)
}

fn yosys_slang_token(path: &Path) -> Result<&str> {
    // Unlike native Yosys commands, read_slang passes quote characters through
    // to Slang instead of stripping them. Emit an unquoted token only after a
    // strict injection-safe validation. The Yosys process runs in the root
    // filelist's directory, so only its basename is needed and spaces in parent
    // directories remain supported. Unusual filelist names receive an
    // actionable error instead of becoming a malformed or injectable script.
    let path = path.to_str().ok_or_else(|| {
        anyhow!("root filelist path is not valid UTF-8 and cannot be passed safely to yosys-slang")
    })?;
    if path.is_empty()
        || !path
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "/._-+:".contains(character))
    {
        bail!(
            "root filelist path {:?} contains characters that yosys-slang cannot safely quote; rename the filelist or move the project to a path using letters, digits, '/', '.', '_', '-', '+', and ':'",
            path
        );
    }
    Ok(path)
}

fn yosys_quote(value: &OsStr) -> Result<String> {
    let value = value.to_string_lossy();
    if value.contains(['\0', '\n', '\r']) {
        bail!("Yosys arguments cannot contain NUL or newline characters");
    }
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!("\"{escaped}\""))
}

fn write_private_file(path: &Path, contents: &str) -> Result<()> {
    fs::write(path, contents)
        .with_context(|| format!("writing private file {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("setting private permissions on {}", path.display()))?;
    }
    Ok(())
}

fn make_private_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("setting private permissions on {}", path.display()))?;
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct PrivateTempDir {
    path: PathBuf,
}

impl PrivateTempDir {
    fn create() -> Result<Self> {
        let base = env::temp_dir();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for _ in 0..100 {
            let counter = TEMP_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = base.join(format!(
                "nettle-compile-{}-{timestamp:x}-{counter:x}",
                std::process::id()
            ));
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&path) {
                Ok(()) => {
                    make_private_directory(&path)?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(error).context("creating private compiler output directory");
                }
            }
        }
        bail!("could not allocate a unique private compiler output directory")
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PrivateTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn join_worker<T>(name: &str, worker: std::thread::ScopedJoinHandle<'_, Result<T>>) -> Result<T> {
    worker
        .join()
        .map_err(|_| anyhow!("{name} worker panicked"))?
}

/// Parses Slang's JSON diagnostic envelope into normalized diagnostics.
pub fn parse_slang_diagnostics(contents: &str) -> Result<Vec<Diagnostic>> {
    if contents.trim().is_empty() {
        return Ok(vec![]);
    }
    let value: Value = serde_json::from_str(contents)?;
    let candidates: Vec<&Value> = match &value {
        Value::Array(values) => values.iter().collect(),
        Value::Object(object) => object
            .get("diagnostics")
            .and_then(Value::as_array)
            .map_or_else(|| vec![&value], |values| values.iter().collect()),
        _ => bail!("Slang diagnostic JSON must be an array or object"),
    };
    Ok(candidates
        .into_iter()
        .filter_map(Value::as_object)
        .filter_map(parse_diagnostic_object)
        .collect())
}

fn parse_diagnostic_object(object: &Map<String, Value>) -> Option<Diagnostic> {
    let message = string_field(object, &["message", "formattedMessage", "text"])?;
    let severity = string_field(object, &["severity", "level"])
        .map(|severity| match severity.to_ascii_lowercase().as_str() {
            "fatal" | "error" => DiagnosticSeverity::Error,
            "warning" | "warn" => DiagnosticSeverity::Warning,
            _ => DiagnosticSeverity::Info,
        })
        .unwrap_or(DiagnosticSeverity::Info);
    Some(Diagnostic {
        severity,
        message: message.to_owned(),
        origin: diagnostic_origin(object),
    })
}

fn diagnostic_origin(object: &Map<String, Value>) -> Option<SourceOrigin> {
    if let Some(location) = object.get("location").and_then(Value::as_str) {
        return parse_compact_location(location);
    }
    let location = object
        .get("location")
        .and_then(Value::as_object)
        .or_else(|| object.get("sourceLocation").and_then(Value::as_object))
        .unwrap_or(object);
    let file = string_field(location, &["fileName", "filename", "file", "path"])?;
    let start = location
        .get("start")
        .and_then(Value::as_object)
        .unwrap_or(location);
    let end = location
        .get("end")
        .and_then(Value::as_object)
        .unwrap_or(start);
    let start_line = integer_field(start, &["line", "lineNumber", "startLine"])?;
    let start_column =
        integer_field(start, &["column", "columnNumber", "startColumn"]).unwrap_or(1);
    let end_line = integer_field(end, &["line", "lineNumber", "endLine"]).unwrap_or(start_line);
    let end_column = integer_field(end, &["column", "columnNumber", "endColumn"]);
    Some(SourceOrigin {
        file: file.to_owned(),
        start_line,
        start_column,
        end_line,
        end_column,
    })
}

fn parse_compact_location(location: &str) -> Option<SourceOrigin> {
    // Slang v11 emits locations as "path:line:column". Split from the right so
    // drive-letter paths on Windows remain intact.
    let (file_and_line, column) = location.rsplit_once(':')?;
    let (file, line) = file_and_line.rsplit_once(':')?;
    let line = line.parse().ok()?;
    let column = column.parse().ok()?;
    Some(SourceOrigin {
        file: file.to_owned(),
        start_line: line,
        start_column: column,
        end_line: line,
        end_column: Some(column),
    })
}

fn string_field<'a>(object: &'a Map<String, Value>, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| object.get(*name).and_then(Value::as_str))
}

fn integer_field(object: &Map<String, Value>, names: &[&str]) -> Option<u32> {
    names.iter().find_map(|name| {
        object
            .get(*name)
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ir::import_yosys_json;

    #[test]
    fn bounds_captured_compiler_output() {
        let input = vec![b'x'; MAX_PROCESS_OUTPUT_BYTES + 17];
        let output = read_bounded_output(std::io::Cursor::new(input)).unwrap();
        assert!(output.starts_with(&"x".repeat(128)));
        assert!(output.contains("<17 bytes omitted from compiler output>"));
        assert!(output.len() < MAX_PROCESS_OUTPUT_BYTES + 128);
    }

    #[test]
    fn rejects_oversized_compiler_artifacts_before_full_read() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("artifact.json");
        fs::write(&path, b"12345").unwrap();
        let error = read_text_file_with_limit(&path, 4, "test artifact")
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("exceeds the supported size limit"),
            "{error}"
        );
        assert_eq!(
            read_text_file_with_limit(&path, 5, "test artifact").unwrap(),
            "12345"
        );
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, contents).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn compiler_timeout_terminates_the_process_group() {
        let directory = tempfile::tempdir().unwrap();
        let program = directory.path().join("slow-compiler");
        write_executable(&program, "#!/bin/sh\nsleep 30 &\nwait\n");

        let error = run_checked(
            &program,
            std::iter::empty::<&OsStr>(),
            directory.path(),
            "test compiler",
            Some(Duration::from_millis(50)),
        )
        .unwrap_err();
        assert!(error.to_string().contains("timed out after 0 seconds"));
    }

    #[cfg(unix)]
    pub(crate) fn fake_compilers(fail_slang: bool) -> (PrivateTempDir, PathBuf, PathBuf, PathBuf) {
        let directory = PrivateTempDir::create().unwrap();
        let root = directory.path().to_string_lossy();
        let slang = directory.path().join("fake-slang");
        let yosys = directory.path().join("fake-yosys");
        let filelist = directory.path().join("project.f");
        fs::write(&filelist, "top.sv\n").unwrap();
        fs::write(directory.path().join("top.sv"), "module top; endmodule\n").unwrap();

        let failure = if fail_slang {
            "echo slang-stdout-marker; echo slang-stderr-marker >&2; exit 7"
        } else {
            ""
        };
        let slang_script = r#"#!/bin/sh
echo "$*" >> "@ROOT@/slang.log"
if [ "$1" = "--version" ]; then
  echo "slang version 11.0.0"
  exit 0
fi
if [ "$1" = "--help" ]; then
  printf '%s\n' '-F --top --diag-json --ast-json -D -U -G'
  exit 0
fi
touch "@ROOT@/slang.started"
i=0
while [ ! -f "@ROOT@/yosys.started" ]; do
  sleep 0.01
  i=$((i + 1))
  if [ "$i" -gt 200 ]; then
    echo "Yosys was not started concurrently" >&2
    exit 91
  fi
done
@FAIL@
diag=""
ast=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --diag-json) diag="$2"; shift 2 ;;
    --ast-json) ast="$2"; shift 2 ;;
    *) shift ;;
  esac
done
dirname "$diag" > "@ROOT@/compiler-output-dir"
printf '%s' '{"diagnostics":[{"severity":"warning","message":"fake warning","location":{"fileName":"rtl/top.sv","start":{"line":4,"column":2},"end":{"line":4,"column":7}}}]}' > "$diag"
printf '%s' '{"design":{"members":[{"kind":"Instance","name":"top","body":{"name":"top","members":[{"kind":"Parameter","name":"WIDTH","value":"8","isLocal":false}]}}]}}' > "$ast"
echo slang-stdout-marker
echo slang-stderr-marker >&2
"#
        .replace("@ROOT@", &root)
        .replace("@FAIL@", failure);
        write_executable(&slang, &slang_script);

        let yosys_script = r#"#!/bin/sh
echo "$*" >> "@ROOT@/yosys.log"
if [ "$1" = "-V" ]; then
  echo "Yosys 0.64"
  exit 0
fi
case "$*" in
  *"help read_slang"*)
    echo "read_slang --best-effort-hierarchy --no-synthesis-define -F <file> -D -U -G"
    exit 0
    ;;
esac
script=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-s" ]; then
    script="$2"
    break
  fi
  shift
done
if [ -z "$script" ]; then
  echo "missing -s script" >&2
  exit 92
fi
touch "@ROOT@/yosys.started"
i=0
while [ ! -f "@ROOT@/slang.started" ]; do
  sleep 0.01
  i=$((i + 1))
  if [ "$i" -gt 200 ]; then
    echo "Slang was not started concurrently" >&2
    exit 93
  fi
done
cp "$script" "@ROOT@/observed.ys"
command_file=$(sed -n 's/^read_slang .* -F \([^ ]*\) --top .*$/\1/p' "$script")
if [ -n "$command_file" ] && [ -f "$command_file" ]; then
  cp "$command_file" "@ROOT@/observed-filelist.f"
fi
out=$(sed -n 's/^write_json "\(.*\)"$/\1/p' "$script")
if [ -z "$out" ]; then
  echo "missing write_json command" >&2
  exit 94
fi
printf '%s' '{"modules":{"top":{"attributes":{"top":1},"ports":{"i":{"direction":"input","bits":[2]},"o":{"direction":"output","bits":[3]}},"cells":{"not":{"type":"$not","parameters":{},"attributes":{},"port_directions":{"A":"input","Y":"output"},"connections":{"A":[2],"Y":[3]}}},"netnames":{}}}}' > "$out"
echo yosys-stdout-marker
echo yosys-stderr-marker >&2
"#
        .replace("@ROOT@", &root);
        write_executable(&yosys, &yosys_script);
        (directory, slang, yosys, filelist)
    }

    #[test]
    fn quotes_yosys_script_values_without_allowing_commands() {
        let script = yosys_script(
            Path::new("/tmp/project.f"),
            "top",
            Path::new("/tmp/out.json"),
        )
        .unwrap();
        assert_eq!(
            script.lines().next(),
            Some("read_slang --best-effort-hierarchy --no-synthesis-define -F project.f --top top")
        );
        assert!(script.contains("hierarchy -top top"));
        assert_eq!(script.lines().count(), 4);
        assert!(
            yosys_script(
                Path::new("/tmp/project;inject.f"),
                "top",
                Path::new("/tmp/out.json")
            )
            .is_err()
        );
        assert!(
            yosys_script(
                Path::new("/tmp/project.f"),
                "top; shell touch /tmp/nope",
                Path::new("/tmp/out.json")
            )
            .is_err()
        );
    }

    #[test]
    fn parses_slang_diagnostic_envelope() {
        let diagnostics = parse_slang_diagnostics(
            r#"{"diagnostics":[{"severity":"warning","message":"unused signal","location":{"fileName":"rtl/top.sv","start":{"line":7,"column":3},"end":{"line":7,"column":8}}}]}"#,
        )
        .unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Warning);
        assert_eq!(diagnostics[0].origin.as_ref().unwrap().start_line, 7);
        assert_eq!(diagnostics[0].origin.as_ref().unwrap().end_column, Some(8));
    }

    #[test]
    fn parses_slang_v11_compact_locations() {
        let diagnostics = parse_slang_diagnostics(
            r#"[{"severity":"error","message":"undeclared identifier","location":"C:/rtl/top.sv:12:14","symbolPath":"top"}]"#,
        )
        .unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(
            diagnostics[0].origin.as_ref().unwrap(),
            &SourceOrigin {
                file: "C:/rtl/top.sv".to_owned(),
                start_line: 12,
                start_column: 14,
                end_line: 12,
                end_column: Some(14),
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn runs_fake_compilers_concurrently_and_cleans_private_outputs() {
        let (directory, slang, yosys, filelist) = fake_compilers(false);
        let artifacts = compile_filelist(&CompilerOptions {
            filelist: filelist.clone(),
            top: "top".to_owned(),
            elaboration: ElaborationOverrides::default(),
            slang_bin: Some(slang),
            yosys_bin: Some(yosys),
        })
        .unwrap();

        assert_eq!(artifacts.tools.len(), 2);
        assert_eq!(artifacts.tools[0].version, "slang version 11.0.0");
        assert!(
            artifacts.transcripts[0]
                .stdout
                .contains("slang-stdout-marker")
        );
        assert!(
            artifacts.transcripts[1]
                .stderr
                .contains("yosys-stderr-marker")
        );
        assert_eq!(artifacts.diagnostics.len(), 1);
        assert_eq!(artifacts.diagnostics[0].message, "fake warning");
        assert!(artifacts.slang_ast_json.contains("\"design\""));
        let snapshot = import_yosys_json(&artifacts.yosys_json, Some("top")).unwrap();
        assert_eq!(snapshot.modules["top"].edges.len(), 2);

        let observed = fs::read_to_string(directory.path().join("observed.ys")).unwrap();
        assert!(observed.contains(&format!(
            "read_slang --best-effort-hierarchy --no-synthesis-define -F {} --top top",
            filelist.file_name().unwrap().to_string_lossy()
        )));
        assert!(observed.contains("hierarchy -top top"));
        assert!(observed.contains("proc -noopt"));
        assert!(observed.contains("write_json \""));

        let slang_log = fs::read_to_string(directory.path().join("slang.log")).unwrap();
        assert!(slang_log.contains("--diag-json"));
        assert!(slang_log.contains("--ast-json-source-info"));
        assert!(!slang_log.contains("--ast-json-detailed-types"));
        let output_dir = fs::read_to_string(directory.path().join("compiler-output-dir"))
            .unwrap()
            .trim()
            .to_owned();
        assert!(
            !Path::new(&output_dir).exists(),
            "compiler temp directory should be removed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn explicit_top_is_selected_when_filelist_also_names_a_top() {
        let (directory, slang, yosys, filelist) = fake_compilers(false);
        fs::write(&filelist, "--top top\ntop.sv\nchild.sv\n").unwrap();
        fs::write(
            directory.path().join("child.sv"),
            "module child; endmodule\n",
        )
        .unwrap();

        compile_filelist(&CompilerOptions {
            filelist,
            top: "child".to_owned(),
            elaboration: ElaborationOverrides::default(),
            slang_bin: Some(slang),
            yosys_bin: Some(yosys),
        })
        .unwrap();

        let observed_script = fs::read_to_string(directory.path().join("observed.ys")).unwrap();
        assert!(observed_script.contains("-F project.f --top child"));
        assert!(observed_script.contains("hierarchy -top child"));

        let slang_log = fs::read_to_string(directory.path().join("slang.log")).unwrap();
        let compile_invocation = slang_log.lines().last().unwrap();
        assert!(compile_invocation.contains("project.f"));
        assert!(compile_invocation.contains("--top child"));
    }

    #[cfg(unix)]
    #[test]
    fn applies_one_effective_elaboration_configuration_to_both_compilers() {
        let (directory, slang, yosys, filelist) = fake_compilers(false);
        let original_filelist =
            "-D WIDTH=8\n-D TRACE\n-D KEEP=1\n-U OLD\n-G DEPTH=4\n-G KEEP_PARAM=7\ntop.sv\n";
        fs::write(&filelist, original_filelist).unwrap();

        compile_filelist(&CompilerOptions {
            filelist: filelist.clone(),
            top: "top".to_owned(),
            elaboration: ElaborationOverrides {
                parameters: vec![ParameterOverride {
                    name: "DEPTH".to_owned(),
                    value: "2 * 16".to_owned(),
                }],
                defines: vec![DefineOverride {
                    name: "WIDTH".to_owned(),
                    value: Some("32".to_owned()),
                }],
                undefines: vec!["TRACE".to_owned()],
            },
            slang_bin: Some(slang),
            yosys_bin: Some(yosys),
        })
        .unwrap();

        let command_file =
            fs::read_to_string(directory.path().join("observed-filelist.f")).unwrap();
        assert!(command_file.contains("-F \""));
        assert!(command_file.contains("project.f\""));
        assert!(command_file.contains("-D \"WIDTH=32\""));
        assert!(command_file.contains("-U \"TRACE\""));
        assert!(command_file.contains("-G \"DEPTH=2 * 16\""));
        assert!(command_file.find("-D \"WIDTH=32\"").unwrap() < command_file.find("-F ").unwrap());
        assert!(
            command_file.find("-G \"DEPTH=2 * 16\"").unwrap() < command_file.find("-F ").unwrap()
        );
        assert!(!command_file.contains("--timescale"));
        assert_eq!(fs::read_to_string(&filelist).unwrap(), original_filelist);

        let slang_log = fs::read_to_string(directory.path().join("slang.log")).unwrap();
        assert!(
            slang_log
                .lines()
                .last()
                .unwrap()
                .contains("normalized-project.f")
        );
        let yosys_script = fs::read_to_string(directory.path().join("observed.ys")).unwrap();
        assert!(yosys_script.contains("-F normalized-project.f --top top"));
    }

    #[test]
    fn rejects_unsupported_filelist_options_before_tool_discovery() {
        let directory = tempfile::tempdir().unwrap();
        let filelist = directory.path().join("project.f");
        fs::write(&filelist, "--time-trace victim.json\ntop.sv\n").unwrap();
        let error = compile_filelist(&CompilerOptions {
            filelist,
            top: "top".to_owned(),
            elaboration: ElaborationOverrides::default(),
            slang_bin: Some(directory.path().join("missing-slang")),
            yosys_bin: Some(directory.path().join("missing-yosys")),
        })
        .unwrap_err();
        let error = format!("{error:#}");
        assert!(error.contains("unsupported filelist option"), "{error}");
        assert!(!error.contains("missing-slang"), "{error}");
    }

    #[test]
    fn rejects_duplicate_and_conflicting_overrides() {
        let duplicate = ElaborationOverrides {
            parameters: vec![
                ParameterOverride {
                    name: "WIDTH".into(),
                    value: "8".into(),
                },
                ParameterOverride {
                    name: "WIDTH".into(),
                    value: "16".into(),
                },
            ],
            ..ElaborationOverrides::default()
        };
        assert!(
            duplicate
                .validate()
                .unwrap_err()
                .to_string()
                .contains("duplicate parameter")
        );

        let conflict = ElaborationOverrides {
            defines: vec![DefineOverride {
                name: "TRACE".into(),
                value: None,
            }],
            undefines: vec!["TRACE".into()],
            ..ElaborationOverrides::default()
        };
        assert!(
            conflict
                .validate()
                .unwrap_err()
                .to_string()
                .contains("both defined and undefined")
        );
        assert!(parse_parameter_override("WIDTH").is_err());
        assert!(parse_define_override("9INVALID").is_err());
        assert!(parse_define_override("EMPTY=").is_err());
        assert!(parse_undefine("HAS-SPACE").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn compiler_failure_includes_captured_output_and_remediation() {
        let (_directory, slang, yosys, filelist) = fake_compilers(true);
        let error = compile_filelist(&CompilerOptions {
            filelist,
            top: "top".to_owned(),
            elaboration: ElaborationOverrides::default(),
            slang_bin: Some(slang),
            yosys_bin: Some(yosys),
        })
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("exit code 7"), "{message}");
        assert!(message.contains("slang-stdout-marker"), "{message}");
        assert!(message.contains("slang-stderr-marker"), "{message}");
        assert!(
            message.contains("inspect the captured diagnostics"),
            "{message}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn compiler_output_directory_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let directory = PrivateTempDir::create().unwrap();
        let mode = fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn discovers_default_tools_on_path() {
        let shell = discover_binary(None, "sh").unwrap();
        assert!(shell.is_absolute());
    }
}
