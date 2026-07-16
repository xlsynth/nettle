// SPDX-License-Identifier: Apache-2.0

//! Builds a Nettle bundle from an Azure RTL directory.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

use crate::{BuildOptions, ElaborationOverrides, build_project};

const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS: u64 = 600;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AzureBuildRequest {
    azure_path: String,
    top: String,
}

struct ApiError {
    status: StatusCode,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

pub(crate) fn router() -> Router {
    Router::new().route("/api/build", post(build_azure))
}

async fn build_azure(Json(request): Json<AzureBuildRequest>) -> Result<Response, ApiError> {
    validate_request(&request).map_err(bad_request)?;
    let top = request.top.clone();
    let bytes = tokio::task::spawn_blocking(move || build_bundle(&request))
        .await
        .map_err(|error| internal_error(format!("Azure build task failed: {error}")))?
        .map_err(|error| internal_error(format!("{error:#}")))?;
    let mut response = Body::from(bytes).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{top}.nettle\""))
            .map_err(|error| internal_error(format!("invalid top module name: {error}")))?,
    );
    Ok(response)
}

fn validate_request(request: &AzureBuildRequest) -> Result<()> {
    if request.top.is_empty()
        || !request
            .top
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.$".contains(character))
    {
        bail!("top must be a simple SystemVerilog identifier");
    }
    if !request.azure_path.starts_with("az://") || request.azure_path.contains(['\0', '\n', '\r']) {
        bail!("azurePath must be an az:// directory");
    }
    let allowed =
        std::env::var("NETTLE_AZURE_ROOTS").context("NETTLE_AZURE_ROOTS is not configured")?;
    if !allowed
        .split(',')
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .any(|root| azure_path_is_allowed(&request.azure_path, root))
    {
        bail!("Azure path is outside NETTLE_AZURE_ROOTS");
    }
    Ok(())
}

fn azure_path_is_allowed(path: &str, root: &str) -> bool {
    path == root.trim_end_matches('/')
        || path.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

fn build_bundle(request: &AzureBuildRequest) -> Result<Vec<u8>> {
    let workspace = tempfile::Builder::new()
        .prefix("nettle-azure-")
        .tempdir()
        .context("creating Azure build workspace")?;
    let source_root = workspace.path().join("source");
    fs::create_dir(&source_root).context("creating source directory")?;
    copy_azure_directory(&request.azure_path, &source_root)?;

    let source_files = collect_source_files(&source_root)?;
    if source_files.is_empty() {
        bail!("Azure path contains no .v or .sv files");
    }
    let filelist = write_filelist(&source_root, &source_files, &request.top)?;
    let output = workspace.path().join("design.nettle");
    build_project(&BuildOptions {
        filelist,
        project_root: Some(source_root),
        top: Some(request.top.clone()),
        elaboration: ElaborationOverrides::default(),
        slang_bin: std::env::var_os("NETTLE_SLANG_BIN").map(PathBuf::from),
        yosys_bin: std::env::var_os("NETTLE_YOSYS_BIN").map(PathBuf::from),
        debug_artifacts: false,
    })?
    .write(&output)
    .with_context(|| format!("writing bundle {}", output.display()))?;
    fs::read(&output).with_context(|| format!("reading bundle {}", output.display()))
}

fn copy_azure_directory(remote: &str, destination: &Path) -> Result<()> {
    let program = std::env::var_os("NETTLE_AZURE_FETCH_BIN")
        .context("NETTLE_AZURE_FETCH_BIN is not configured")?;
    let mut command = Command::new(program);
    command
        .arg("cptree")
        .arg("--quiet")
        .arg(remote)
        .arg(destination)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout(command, download_timeout()).context("downloading Azure directory")
}

fn run_with_timeout(mut command: Command, timeout: Duration) -> Result<()> {
    let mut child = command.spawn().context("starting Azure copy helper")?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().context("waiting for Azure copy helper")? {
            let output = child.wait_with_output().context("reading copy output")?;
            if status.success() {
                return Ok(());
            }
            bail!(
                "Azure copy helper exited with {status}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Azure copy timed out after {} seconds", timeout.as_secs());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn download_timeout() -> Duration {
    Duration::from_secs(
        std::env::var("NETTLE_AZURE_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_DOWNLOAD_TIMEOUT_SECONDS),
    )
}

fn collect_source_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("reading source directory {}", directory.display()))?
        {
            let path = entry?.path();
            if path.is_dir() {
                pending.push(path);
            } else if path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| matches!(extension, "v" | "sv"))
            {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn write_filelist(root: &Path, source_files: &[PathBuf], top: &str) -> Result<PathBuf> {
    let filelist = root.join("nettle-generated.f");
    let directories: BTreeSet<&Path> = source_files
        .iter()
        .filter_map(|path| path.parent())
        .collect();
    let mut contents = format!("--top {top}\n");
    for directory in directories {
        contents.push_str(&format!("+incdir+{}\n", directory.display()));
    }
    for path in source_files {
        contents.push_str(&format!("{}\n", path.display()));
    }
    fs::write(&filelist, contents)
        .with_context(|| format!("writing filelist {}", filelist.display()))?;
    Ok(filelist)
}

fn bad_request(error: anyhow::Error) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: error.to_string(),
    }
}

fn internal_error(message: String) -> ApiError {
    ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_roots_require_a_path_boundary() {
        assert!(azure_path_is_allowed(
            "az://account/container/project/rtl/",
            "az://account/container/project/"
        ));
        assert!(!azure_path_is_allowed(
            "az://account/container/project-other/",
            "az://account/container/project/"
        ));
    }
}
