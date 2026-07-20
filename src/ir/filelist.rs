// SPDX-License-Identifier: Apache-2.0

//! Expands nested Slang-compatible filelists into explicit compiler inputs.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::resource_limits::native::filelist::{
    BYTES as MAX_FILELIST_BYTES, DEPTH as MAX_FILELIST_DEPTH, FILES as MAX_FILELIST_FILES,
    TOKENS as MAX_FILELIST_TOKENS,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Exact filelist token and source position that produced a normalized input.
pub struct TokenOrigin {
    /// Filelist containing the token.
    pub file: String,
    /// One-based source line.
    pub line: u32,
    /// One-based source column.
    pub column: u32,
    /// Original token text.
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Normalized path together with the filelist token that declared it.
pub struct InputPath {
    /// Lexically normalized path passed to the compilers.
    pub path: String,
    /// Declaring token and location.
    pub origin: TokenOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Preprocessor definition declared by a filelist.
pub struct Define {
    /// Macro name.
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional raw macro value.
    pub value: Option<String>,
    /// Declaring token and location.
    pub origin: TokenOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Top-level parameter assignment declared by a filelist.
pub struct ParameterAssignment {
    /// Parameter name.
    pub name: String,
    /// Raw SystemVerilog expression.
    pub value: String,
    /// Declaring token and location.
    pub origin: TokenOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Preprocessor macro removal declared by a filelist.
pub struct Undefine {
    /// Macro name.
    pub name: String,
    /// Declaring token and location.
    pub origin: TokenOrigin,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Semantic category assigned to one normalized compiler argument.
pub enum NormalizedArgumentKind {
    /// HDL source path.
    Source,
    /// Include search directory.
    IncludeDirectory,
    /// Library search directory.
    LibraryDirectory,
    /// Explicit library source file.
    LibraryFile,
    /// Preprocessor definition.
    Define,
    /// Preprocessor undefinition.
    Undefine,
    /// Top-level parameter assignment.
    Parameter,
    /// Language-standard selection.
    Language,
    /// Top-module selection.
    Top,
    /// Nested filelist expansion.
    NestedFilelist,
    /// Argument not interpreted by Nettle. Normalization rejects this kind.
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// One compiler argument after nested-filelist expansion and path normalization.
pub struct NormalizedArgument {
    /// Argument category.
    pub kind: NormalizedArgumentKind,
    /// Canonical argument value.
    pub value: String,
    /// Filelist token that produced the argument.
    pub origin: TokenOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Fully expanded, compiler-independent representation of a root filelist.
pub struct NormalizedProject {
    /// Canonical root filelist path.
    pub root_filelist: String,
    /// Ordered HDL source inputs.
    pub sources: Vec<InputPath>,
    /// Ordered include search directories.
    pub include_directories: Vec<InputPath>,
    /// Ordered library search directories.
    pub library_directories: Vec<InputPath>,
    /// Explicit library source files.
    pub library_files: Vec<InputPath>,
    /// Effective filelist preprocessor definitions.
    pub defines: Vec<Define>,
    #[serde(default)]
    /// Effective filelist preprocessor undefinitions.
    pub undefines: Vec<Undefine>,
    #[serde(default)]
    /// Effective filelist top-level parameter assignments.
    pub parameters: Vec<ParameterAssignment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional language-standard selection.
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional selected top module.
    pub top: Option<String>,
    /// Preserved arguments that Nettle did not interpret.
    pub unknown_arguments: Vec<NormalizedArgument>,
    /// Complete normalized argument stream in compiler order.
    pub arguments: Vec<NormalizedArgument>,
}

#[derive(Debug, Error)]
/// Failure encountered while reading or tokenizing a nested filelist graph.
pub enum FileListError {
    /// A caller-requested interruption stopped filelist expansion.
    #[error("filelist normalization interrupted: {source}")]
    Interrupted {
        #[source]
        /// Reason supplied by the caller's interruption check.
        source: std::io::Error,
    },
    /// A filelist could not be read.
    #[error("cannot read filelist {path}: {source}")]
    Read {
        /// Filelist path.
        path: PathBuf,
        #[source]
        /// Underlying filesystem error.
        source: std::io::Error,
    },
    /// A root or nested filelist resolves outside a caller-provided boundary.
    #[error("filelist {path} is outside project root {root}")]
    OutsideRoot {
        /// Filelist path that escaped the boundary.
        path: PathBuf,
        /// Canonical project-root boundary.
        root: PathBuf,
    },
    /// Nested filelists contain a recursion cycle.
    #[error("nested filelist cycle: {path}")]
    Cycle {
        /// Filelist that re-entered the active expansion stack.
        path: PathBuf,
    },
    /// Acyclic nested filelists exceed the supported recursion depth.
    #[error("nested filelist depth exceeds the supported limit {limit}: {path}")]
    DepthLimit {
        /// Filelist that would exceed the expansion depth.
        path: PathBuf,
        /// Maximum number of simultaneously active filelists.
        limit: usize,
    },
    /// The expanded filelist graph exceeds a cumulative resource budget.
    #[error("filelist expansion exceeds the supported {resource} limit {limit}")]
    ResourceLimit {
        /// Resource whose cumulative budget was exceeded.
        resource: &'static str,
        /// Maximum accepted cumulative amount.
        limit: usize,
    },
    /// An option that requires a following value reached end of input.
    #[error("{file}:{line}:{column}: option {option} requires a value")]
    MissingValue {
        /// Filelist containing the option.
        file: String,
        /// One-based source line.
        line: u32,
        /// One-based source column.
        column: u32,
        /// Option missing its value.
        option: String,
    },
    /// A filelist option is outside Nettle's supported, side-effect-free subset.
    #[error("{file}:{line}:{column}: unsupported filelist option {option:?}")]
    UnsupportedOption {
        /// Filelist containing the unsupported option.
        file: String,
        /// One-based source line.
        line: u32,
        /// One-based source column.
        column: u32,
        /// Unsupported option token.
        option: String,
    },
    /// A quoted token reached end of input without a closing quote.
    #[error("{file}:{line}:{column}: unterminated quoted token")]
    UnterminatedQuote {
        /// Filelist containing the token.
        file: String,
        /// One-based source line.
        line: u32,
        /// One-based source column.
        column: u32,
    },
}

#[derive(Debug, Clone)]
struct Token {
    value: String,
    origin: TokenOrigin,
}

/// Expands a Slang-style filelist and preserves Slang's path rules. Paths in a
/// `-F` file are relative to that file; paths in a `-f` file are relative to
/// the compiler working directory. Tokens from nested lists keep their origins.
pub fn normalize_filelist(
    filelist: impl AsRef<Path>,
    cli_top: Option<&str>,
) -> Result<NormalizedProject, FileListError> {
    normalize_filelist_impl(filelist.as_ref(), cli_top, None, &mut || Ok(()))
}

/// Expands a filelist while rejecting every root or nested filelist outside `project_root`.
///
/// The boundary is checked before any filelist is opened. This is intended for
/// untrusted projects whose command files must not read files from the host.
pub fn normalize_filelist_within_root(
    filelist: impl AsRef<Path>,
    cli_top: Option<&str>,
    project_root: impl AsRef<Path>,
) -> Result<NormalizedProject, FileListError> {
    normalize_filelist_within_root_cancellable(filelist, cli_top, project_root, || Ok(()))
}

/// Expands a contained filelist while periodically checking for caller-requested interruption.
pub(crate) fn normalize_filelist_within_root_cancellable(
    filelist: impl AsRef<Path>,
    cli_top: Option<&str>,
    project_root: impl AsRef<Path>,
    mut check_interrupted: impl FnMut() -> io::Result<()>,
) -> Result<NormalizedProject, FileListError> {
    let root = absolute_lexical(project_root.as_ref(), &current_dir());
    let root = fs::canonicalize(&root).unwrap_or(root);
    normalize_filelist_impl(
        filelist.as_ref(),
        cli_top,
        Some(root),
        &mut check_interrupted,
    )
}

fn normalize_filelist_impl(
    filelist: &Path,
    cli_top: Option<&str>,
    containment_root: Option<PathBuf>,
    check_interrupted: &mut dyn FnMut() -> io::Result<()>,
) -> Result<NormalizedProject, FileListError> {
    check_filelist_interrupted(check_interrupted)?;
    let initial = absolute_lexical(filelist, &current_dir());
    let root = fs::canonicalize(&initial).unwrap_or(initial);
    // The compiler adapter runs both Slang processes from the root filelist's
    // directory. Slang's `-f` form resolves paths inside the nested command
    // file from that process working directory, while `-F` resolves them from
    // the nested file itself.
    let compiler_cwd = root
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let mut parser = Parser {
        active: HashSet::new(),
        files_parsed: 0,
        bytes_read: 0,
        tokens_parsed: 0,
        compiler_cwd,
        containment_root,
        check_interrupted,
        project: NormalizedProject {
            root_filelist: path_string(&root),
            sources: vec![],
            include_directories: vec![],
            library_directories: vec![],
            library_files: vec![],
            defines: vec![],
            undefines: vec![],
            parameters: vec![],
            language: None,
            top: cli_top.map(str::to_owned),
            unknown_arguments: vec![],
            arguments: vec![],
        },
    };
    let root_base = root
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    parser.parse_file(&root, &root_base)?;
    parser.check_interrupted()?;
    if let Some(top) = cli_top {
        parser.project.arguments.push(NormalizedArgument {
            kind: NormalizedArgumentKind::Top,
            value: top.to_owned(),
            origin: TokenOrigin {
                file: "<command-line>".to_owned(),
                line: 1,
                column: 1,
                token: top.to_owned(),
            },
        });
    }
    Ok(parser.project)
}

struct Parser<'a> {
    active: HashSet<PathBuf>,
    files_parsed: usize,
    bytes_read: usize,
    tokens_parsed: usize,
    compiler_cwd: PathBuf,
    containment_root: Option<PathBuf>,
    check_interrupted: &'a mut dyn FnMut() -> io::Result<()>,
    project: NormalizedProject,
}

impl Parser<'_> {
    fn check_interrupted(&mut self) -> Result<(), FileListError> {
        check_filelist_interrupted(self.check_interrupted)
    }

    fn parse_file(&mut self, file: &Path, relative_base: &Path) -> Result<(), FileListError> {
        self.check_interrupted()?;
        let file = fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
        if let Some(root) = &self.containment_root
            && !file.starts_with(root)
        {
            return Err(FileListError::OutsideRoot {
                path: file,
                root: root.clone(),
            });
        }
        if self.active.len() >= MAX_FILELIST_DEPTH {
            return Err(FileListError::DepthLimit {
                path: file,
                limit: MAX_FILELIST_DEPTH,
            });
        }
        if !self.active.insert(file.clone()) {
            return Err(FileListError::Cycle { path: file });
        }
        if let Err(error) =
            consume_budget(&mut self.files_parsed, 1, MAX_FILELIST_FILES, "file count")
        {
            self.active.remove(&file);
            return Err(error);
        }
        let result = self.parse_file_inner(&file, relative_base);
        self.active.remove(&file);
        result
    }

    fn parse_file_inner(&mut self, file: &Path, relative_base: &Path) -> Result<(), FileListError> {
        self.check_interrupted()?;
        let remaining = MAX_FILELIST_BYTES.saturating_sub(self.bytes_read);
        let input = fs::File::open(file).map_err(|source| FileListError::Read {
            path: file.to_path_buf(),
            source,
        })?;
        let mut input = input.take(
            u64::try_from(remaining)
                .unwrap_or(u64::MAX)
                .saturating_add(1),
        );
        let mut bytes = Vec::new();
        let mut chunk = vec![0_u8; 64 * 1024];
        loop {
            self.check_interrupted()?;
            let count = input
                .read(&mut chunk)
                .map_err(|source| FileListError::Read {
                    path: file.to_path_buf(),
                    source,
                })?;
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..count]);
        }
        self.check_interrupted()?;
        consume_budget(
            &mut self.bytes_read,
            bytes.len(),
            MAX_FILELIST_BYTES,
            "byte count",
        )?;
        let contents = String::from_utf8(bytes).map_err(|source| FileListError::Read {
            path: file.to_path_buf(),
            source: io::Error::new(io::ErrorKind::InvalidData, source),
        })?;
        self.check_interrupted()?;
        let tokens = tokenize(&contents, file, self.check_interrupted)?;
        self.check_interrupted()?;
        consume_budget(
            &mut self.tokens_parsed,
            tokens.len(),
            MAX_FILELIST_TOKENS,
            "token count",
        )?;
        let mut index = 0;
        while index < tokens.len() {
            self.check_interrupted()?;
            let token = &tokens[index];
            let value = token.value.as_str();

            if value == "-f" || value == "-F" {
                let nested = required_next(&tokens, index, token)?;
                self.record_nested(nested, relative_base, value == "-F")?;
                index += 2;
                continue;
            }
            if let Some(nested) = value.strip_prefix("-f=") {
                let nested = Token {
                    value: nested.to_owned(),
                    origin: token.origin.clone(),
                };
                self.record_nested(&nested, relative_base, false)?;
                index += 1;
                continue;
            }
            if let Some(nested) = value.strip_prefix("-F=") {
                let nested = Token {
                    value: nested.to_owned(),
                    origin: token.origin.clone(),
                };
                self.record_nested(&nested, relative_base, true)?;
                index += 1;
                continue;
            }
            if value == "-I" || value == "--include-directory" {
                let path = required_next(&tokens, index, token)?;
                self.record_path(
                    path,
                    relative_base,
                    NormalizedArgumentKind::IncludeDirectory,
                );
                index += 2;
                continue;
            }
            if let Some(path) =
                attached_option(value, "-I").or_else(|| value.strip_prefix("--include-directory="))
            {
                let path = Token {
                    value: path.to_owned(),
                    origin: token.origin.clone(),
                };
                self.record_path(
                    &path,
                    relative_base,
                    NormalizedArgumentKind::IncludeDirectory,
                );
                index += 1;
                continue;
            }
            if let Some(paths) = value.strip_prefix("+incdir+") {
                for path in paths.split('+').filter(|part| !part.is_empty()) {
                    let path = Token {
                        value: path.to_owned(),
                        origin: token.origin.clone(),
                    };
                    self.record_path(
                        &path,
                        relative_base,
                        NormalizedArgumentKind::IncludeDirectory,
                    );
                }
                index += 1;
                continue;
            }
            if value == "-y" || value == "--libdir" {
                let path = required_next(&tokens, index, token)?;
                self.record_path(
                    path,
                    relative_base,
                    NormalizedArgumentKind::LibraryDirectory,
                );
                index += 2;
                continue;
            }
            if let Some(path) =
                attached_option(value, "-y").or_else(|| value.strip_prefix("--libdir="))
            {
                let path = Token {
                    value: path.to_owned(),
                    origin: token.origin.clone(),
                };
                self.record_path(
                    &path,
                    relative_base,
                    NormalizedArgumentKind::LibraryDirectory,
                );
                index += 1;
                continue;
            }
            if value == "-v" || value == "--libfile" {
                let path = required_next(&tokens, index, token)?;
                self.record_path(path, relative_base, NormalizedArgumentKind::LibraryFile);
                index += 2;
                continue;
            }
            if let Some(path) = value
                .strip_prefix("-v=")
                .or_else(|| value.strip_prefix("--libfile="))
            {
                let path = Token {
                    value: path.to_owned(),
                    origin: token.origin.clone(),
                };
                self.record_path(&path, relative_base, NormalizedArgumentKind::LibraryFile);
                index += 1;
                continue;
            }
            if matches!(value, "-D" | "--define" | "--define-macro") {
                let define = required_next(&tokens, index, token)?;
                self.record_define(define);
                index += 2;
                continue;
            }
            if let Some(define) = attached_option(value, "-D")
                .or_else(|| value.strip_prefix("--define="))
                .or_else(|| value.strip_prefix("--define-macro="))
            {
                let define = Token {
                    value: define.to_owned(),
                    origin: token.origin.clone(),
                };
                self.record_define(&define);
                index += 1;
                continue;
            }
            if let Some(defines) = value.strip_prefix("+define+") {
                for define in defines.split('+').filter(|part| !part.is_empty()) {
                    let define = Token {
                        value: define.to_owned(),
                        origin: token.origin.clone(),
                    };
                    self.record_define(&define);
                }
                index += 1;
                continue;
            }
            if value == "-U" || value == "--undefine-macro" {
                let undefine = required_next(&tokens, index, token)?;
                self.record_undefine(undefine);
                index += 2;
                continue;
            }
            if let Some(name) =
                attached_option(value, "-U").or_else(|| value.strip_prefix("--undefine-macro="))
            {
                let undefine = Token {
                    value: name.to_owned(),
                    origin: token.origin.clone(),
                };
                self.record_undefine(&undefine);
                index += 1;
                continue;
            }
            if value == "-G" {
                let parameter = required_next(&tokens, index, token)?;
                self.record_parameter(parameter);
                index += 2;
                continue;
            }
            if let Some(assignment) = attached_option(value, "-G") {
                let parameter = Token {
                    value: assignment.to_owned(),
                    origin: token.origin.clone(),
                };
                self.record_parameter(&parameter);
                index += 1;
                continue;
            }
            if matches!(value, "--language" | "-language" | "--std") {
                let language = required_next(&tokens, index, token)?;
                self.record_scalar(language, NormalizedArgumentKind::Language);
                self.project.language = Some(language.value.clone());
                index += 2;
                continue;
            }
            if let Some(language) = value
                .strip_prefix("--language=")
                .or_else(|| value.strip_prefix("-language="))
                .or_else(|| value.strip_prefix("--std="))
                .or_else(|| value.strip_prefix("-std="))
            {
                let language = Token {
                    value: language.to_owned(),
                    origin: token.origin.clone(),
                };
                self.record_scalar(&language, NormalizedArgumentKind::Language);
                self.project.language = Some(language.value);
                index += 1;
                continue;
            }
            if matches!(value, "--top" | "-top") {
                let top = required_next(&tokens, index, token)?;
                self.record_top(top);
                index += 2;
                continue;
            }
            if let Some(top) = value
                .strip_prefix("--top=")
                .or_else(|| value.strip_prefix("-top="))
            {
                let top = Token {
                    value: top.to_owned(),
                    origin: token.origin.clone(),
                };
                self.record_top(&top);
                index += 1;
                continue;
            }
            if value.starts_with('-') || value.starts_with('+') {
                return Err(FileListError::UnsupportedOption {
                    file: token.origin.file.clone(),
                    line: token.origin.line,
                    column: token.origin.column,
                    option: value.to_owned(),
                });
            }

            self.record_path(token, relative_base, NormalizedArgumentKind::Source);
            index += 1;
        }
        Ok(())
    }

    fn record_nested(
        &mut self,
        token: &Token,
        base: &Path,
        paths_relative_to_file: bool,
    ) -> Result<(), FileListError> {
        let path = absolute_lexical(Path::new(&token.value), base);
        self.project.arguments.push(NormalizedArgument {
            kind: NormalizedArgumentKind::NestedFilelist,
            value: path_string(&path),
            origin: token.origin.clone(),
        });
        let nested_base = if paths_relative_to_file {
            path.parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf()
        } else {
            self.compiler_cwd.clone()
        };
        self.parse_file(&path, &nested_base)
    }

    fn record_path(&mut self, token: &Token, base: &Path, kind: NormalizedArgumentKind) {
        let normalized = path_string(&absolute_lexical(Path::new(&token.value), base));
        let input = InputPath {
            path: normalized.clone(),
            origin: token.origin.clone(),
        };
        match kind {
            NormalizedArgumentKind::Source => self.project.sources.push(input),
            NormalizedArgumentKind::IncludeDirectory => {
                self.project.include_directories.push(input)
            }
            NormalizedArgumentKind::LibraryDirectory => {
                self.project.library_directories.push(input)
            }
            NormalizedArgumentKind::LibraryFile => self.project.library_files.push(input),
            _ => unreachable!("record_path called with non-path argument"),
        }
        self.project.arguments.push(NormalizedArgument {
            kind,
            value: normalized,
            origin: token.origin.clone(),
        });
    }

    fn record_define(&mut self, token: &Token) {
        let (name, value) = token
            .value
            .split_once('=')
            .map_or((token.value.as_str(), None), |(name, value)| {
                (name, Some(value.to_owned()))
            });
        self.project.defines.push(Define {
            name: name.to_owned(),
            value,
            origin: token.origin.clone(),
        });
        self.record_scalar(token, NormalizedArgumentKind::Define);
    }

    fn record_undefine(&mut self, token: &Token) {
        self.project.undefines.push(Undefine {
            name: token.value.clone(),
            origin: token.origin.clone(),
        });
        self.record_scalar(token, NormalizedArgumentKind::Undefine);
    }

    fn record_parameter(&mut self, token: &Token) {
        let (name, value) = token
            .value
            .split_once('=')
            .map_or((token.value.as_str(), ""), |(name, value)| (name, value));
        self.project.parameters.push(ParameterAssignment {
            name: name.to_owned(),
            value: value.to_owned(),
            origin: token.origin.clone(),
        });
        self.record_scalar(token, NormalizedArgumentKind::Parameter);
    }

    fn record_top(&mut self, token: &Token) {
        // A command-line top, if supplied, has precedence over filelist tops.
        if self.project.top.is_none() {
            self.project.top = Some(token.value.clone());
        }
        self.record_scalar(token, NormalizedArgumentKind::Top);
    }

    fn record_scalar(&mut self, token: &Token, kind: NormalizedArgumentKind) {
        self.project.arguments.push(NormalizedArgument {
            kind,
            value: token.value.clone(),
            origin: token.origin.clone(),
        });
    }
}

fn consume_budget(
    current: &mut usize,
    amount: usize,
    maximum: usize,
    resource: &'static str,
) -> Result<(), FileListError> {
    *current = current
        .checked_add(amount)
        .filter(|next| *next <= maximum)
        .ok_or(FileListError::ResourceLimit {
            resource,
            limit: maximum,
        })?;
    Ok(())
}

fn required_next<'a>(
    tokens: &'a [Token],
    index: usize,
    option: &Token,
) -> Result<&'a Token, FileListError> {
    tokens
        .get(index + 1)
        .ok_or_else(|| FileListError::MissingValue {
            file: option.origin.file.clone(),
            line: option.origin.line,
            column: option.origin.column,
            option: option.value.clone(),
        })
}

fn attached_option<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .strip_prefix(prefix)
        .filter(|remainder| !remainder.is_empty())
}

fn check_filelist_interrupted(
    check_interrupted: &mut dyn FnMut() -> io::Result<()>,
) -> Result<(), FileListError> {
    check_interrupted().map_err(|source| FileListError::Interrupted { source })
}

fn tokenize(
    contents: &str,
    file: &Path,
    check_interrupted: &mut dyn FnMut() -> io::Result<()>,
) -> Result<Vec<Token>, FileListError> {
    check_filelist_interrupted(check_interrupted)?;
    let mut tokens = vec![];
    let mut current = String::new();
    let mut token_line = 1_u32;
    let mut token_column = 1_u32;
    let mut line = 1_u32;
    let mut column = 1_u32;
    let mut quote: Option<char> = None;
    let chars: Vec<char> = contents.chars().collect();
    let mut index = 0;

    let push = |tokens: &mut Vec<Token>, current: &mut String, line, column| {
        if !current.is_empty() {
            tokens.push(Token {
                value: std::mem::take(current),
                origin: TokenOrigin {
                    file: path_string(file),
                    line,
                    column,
                    token: String::new(),
                },
            });
            let last = tokens.last_mut().expect("just pushed");
            last.origin.token = last.value.clone();
        }
    };

    while index < chars.len() {
        if index.is_multiple_of(4096) {
            check_filelist_interrupted(check_interrupted)?;
        }
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if quote.is_none() && current.is_empty() && (ch == '#' || (ch == '/' && next == Some('/')))
        {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
                column += 1;
                if index.is_multiple_of(4096) {
                    check_filelist_interrupted(check_interrupted)?;
                }
            }
            continue;
        }
        if quote.is_none() && ch.is_whitespace() {
            push(&mut tokens, &mut current, token_line, token_column);
            if ch == '\n' {
                line += 1;
                column = 1;
            } else {
                column += 1;
            }
            index += 1;
            continue;
        }
        if ch == '\\' && next == Some('\n') {
            index += 2;
            line += 1;
            column = 1;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            if current.is_empty() {
                token_line = line;
                token_column = column;
            }
            if let Some(escaped) = next {
                current.push(escaped);
                index += 2;
                if escaped == '\n' {
                    line += 1;
                    column = 1;
                } else {
                    column += 2;
                }
                continue;
            }
        }
        if ch == '\'' || ch == '"' {
            if quote == Some(ch) {
                quote = None;
                index += 1;
                column += 1;
                continue;
            }
            if quote.is_none() {
                if current.is_empty() {
                    token_line = line;
                    token_column = column;
                }
                quote = Some(ch);
                index += 1;
                column += 1;
                continue;
            }
        }
        if current.is_empty() {
            token_line = line;
            token_column = column;
        }
        current.push(ch);
        index += 1;
        column += 1;
    }
    check_filelist_interrupted(check_interrupted)?;
    if quote.is_some() {
        return Err(FileListError::UnterminatedQuote {
            file: path_string(file),
            line: token_line,
            column: token_column,
        });
    }
    push(&mut tokens, &mut current, token_line, token_column);
    Ok(tokens)
}

fn current_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn absolute_lexical(path: &Path, base: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut result = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    result.push(component.as_os_str());
                }
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nettle-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn tokenization_checks_for_interruption_inside_long_comments() {
        let contents = format!("#{}\n", "x".repeat(8192));
        let mut checks = 0_usize;
        let error = tokenize(&contents, Path::new("project.f"), &mut || {
            checks = checks.saturating_add(1);
            if checks == 3 {
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "test deadline expired",
                ))
            } else {
                Ok(())
            }
        })
        .unwrap_err();

        assert!(matches!(
            error,
            FileListError::Interrupted { ref source }
                if source.kind() == io::ErrorKind::TimedOut
        ));
        assert_eq!(checks, 3);
    }

    #[test]
    fn normalizes_parameter_overrides_and_undefines_without_treating_values_as_sources() {
        let dir = test_dir("filelist-elaboration");
        let filelist = dir.join("project.f");
        fs::write(
            &filelist,
            "-G WIDTH=32 -GDEPTH=16 -U TRACE -ULEGACY --undefine-macro=SIM --define-macro FEATURE=1 top.sv\n",
        )
        .unwrap();

        let project = normalize_filelist(&filelist, None).unwrap();
        assert_eq!(
            project
                .parameters
                .iter()
                .map(|parameter| (parameter.name.as_str(), parameter.value.as_str()))
                .collect::<Vec<_>>(),
            [("WIDTH", "32"), ("DEPTH", "16")]
        );
        assert_eq!(
            project
                .undefines
                .iter()
                .map(|undefine| undefine.name.as_str())
                .collect::<Vec<_>>(),
            ["TRACE", "LEGACY", "SIM"]
        );
        assert_eq!(project.sources.len(), 1);
        assert!(project.sources[0].path.ends_with("top.sv"));
        assert_eq!(project.defines[0].name, "FEATURE");
        assert_eq!(project.defines[0].value.as_deref(), Some("1"));
        assert_eq!(
            project
                .arguments
                .iter()
                .filter(|argument| argument.kind == NormalizedArgumentKind::Parameter)
                .count(),
            2
        );
        assert_eq!(
            project
                .arguments
                .iter()
                .filter(|argument| argument.kind == NormalizedArgumentKind::Undefine)
                .count(),
            3
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn expands_nested_lists_and_preserves_origins() {
        let dir = test_dir("filelist");
        fs::create_dir_all(dir.join("rtl/include")).unwrap();
        fs::write(
            dir.join("project.f"),
            "+define+WIDTH=8+TRACE -I rtl/include -F rtl/nested.f\n",
        )
        .unwrap();
        fs::write(
            dir.join("rtl/nested.f"),
            "// source lives relative to this list\n../top.sv\n-y cells -v cells/lib.v --top top\n",
        )
        .unwrap();

        let project = normalize_filelist(dir.join("project.f"), None).unwrap();
        assert_eq!(project.defines[0].name, "WIDTH");
        assert_eq!(project.defines[0].value.as_deref(), Some("8"));
        assert_eq!(project.defines[1].name, "TRACE");
        assert!(project.sources[0].path.ends_with("/top.sv"));
        assert!(
            project.include_directories[0]
                .path
                .ends_with("/rtl/include")
        );
        assert!(project.library_directories[0].path.ends_with("/rtl/cells"));
        assert_eq!(project.sources[0].origin.line, 2);
        assert_eq!(project.top.as_deref(), Some("top"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn command_line_top_wins() {
        let dir = test_dir("top");
        fs::write(dir.join("project.f"), "--top from_file top.sv\n").unwrap();
        let project = normalize_filelist(dir.join("project.f"), Some("from_cli")).unwrap();
        assert_eq!(project.top.as_deref(), Some("from_cli"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn detects_recursive_filelists() {
        let dir = test_dir("cycle");
        fs::write(dir.join("a.f"), "-f b.f\n").unwrap();
        fs::write(dir.join("b.f"), "-f a.f\n").unwrap();
        let error = normalize_filelist(dir.join("a.f"), None).unwrap_err();
        assert!(matches!(error, FileListError::Cycle { .. }));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_excessive_acyclic_filelist_depth() {
        let dir = test_dir("depth");
        for depth in 0..=MAX_FILELIST_DEPTH {
            let contents = if depth == MAX_FILELIST_DEPTH {
                "top.sv\n".to_owned()
            } else {
                format!("-f {}.f\n", depth + 1)
            };
            fs::write(dir.join(format!("{depth}.f")), contents).unwrap();
        }
        let error = normalize_filelist(dir.join("0.f"), None).unwrap_err();
        assert!(matches!(error, FileListError::DepthLimit { .. }));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_cumulative_filelist_budget_overflow() {
        let mut consumed = 3;
        consume_budget(&mut consumed, 2, 5, "test units").unwrap();
        let error = consume_budget(&mut consumed, 1, 5, "test units").unwrap_err();
        assert!(matches!(
            error,
            FileListError::ResourceLimit {
                resource: "test units",
                limit: 5
            }
        ));
    }

    #[test]
    fn rejects_unsupported_options_before_compiler_execution() {
        let dir = test_dir("unsupported-option");
        fs::write(
            dir.join("project.f"),
            "--time-trace /tmp/should-not-be-written top.sv\n",
        )
        .unwrap();
        let error = normalize_filelist(dir.join("project.f"), Some("top")).unwrap_err();
        assert!(matches!(
            error,
            FileListError::UnsupportedOption { ref option, .. } if option == "--time-trace"
        ));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn accepts_quotes_and_line_continuations() {
        let dir = test_dir("quotes");
        fs::write(
            dir.join("project.f"),
            "'rtl/file with space.sv' \\\n+incdir+inc\n",
        )
        .unwrap();
        let project = normalize_filelist(dir.join("project.f"), None).unwrap();
        assert!(project.sources[0].path.ends_with("/rtl/file with space.sv"));
        assert!(project.include_directories[0].path.ends_with("/inc"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn distinguishes_lowercase_and_uppercase_nested_filelist_bases() {
        let dir = test_dir("nested-bases");
        fs::create_dir_all(dir.join("lists/deeper")).unwrap();
        fs::write(dir.join("project.f"), "-F lists/outer.f\n").unwrap();
        fs::write(
            dir.join("lists/outer.f"),
            "-f deeper/from-cwd.f\n-F deeper/from-file.f\n",
        )
        .unwrap();
        fs::write(dir.join("lists/deeper/from-cwd.f"), "cwd_source.sv\n").unwrap();
        fs::write(
            dir.join("lists/deeper/from-file.f"),
            "file_relative_source.sv\n",
        )
        .unwrap();

        let project = normalize_filelist(dir.join("project.f"), None).unwrap();
        assert_eq!(project.sources.len(), 2);
        assert!(project.sources[0].path.ends_with("/cwd_source.sv"));
        assert!(
            project.sources[1]
                .path
                .ends_with("/lists/deeper/file_relative_source.sv")
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
