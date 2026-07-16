// SPDX-License-Identifier: Apache-2.0

//! Builds a Nettle bundle from an Azure RTL directory.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use tokio::sync::Semaphore;

use crate::{BuildOptions, ElaborationOverrides, build_project};

const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS: u64 = 600;
const MAX_CONCURRENT_AZURE_BUILDS: usize = 2;

static AZURE_BUILD_PERMITS: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(MAX_CONCURRENT_AZURE_BUILDS)));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AzureBuildRequest {
    azure_path: String,
    filelist: String,
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

pub(crate) fn enabled() -> bool {
    enabled_value(std::env::var("NETTLE_ENABLE_AZURE_BUNDLES").ok().as_deref())
}

fn enabled_value(value: Option<&str>) -> bool {
    value.is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
}

async fn build_azure(Json(request): Json<AzureBuildRequest>) -> Result<Response, ApiError> {
    validate_request(&request).map_err(bad_request)?;
    let top = request.top.clone();
    let permit = AZURE_BUILD_PERMITS
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| internal_error("Azure build service is shutting down".to_owned()))?;
    let bytes = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        build_bundle(&request)
    })
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

    let filelist = resolve_filelist(&source_root, &request.filelist)?;
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
    let mut command = Command::new("bbb");
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
    let mut child = command.spawn().context("starting bbb")?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().context("waiting for bbb")? {
            let output = child.wait_with_output().context("reading copy output")?;
            if status.success() {
                return Ok(());
            }
            bail!(
                "bbb exited with {status}: {}",
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

fn resolve_filelist(root: &Path, value: &str) -> Result<PathBuf> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        bail!("filelist must be a non-empty relative path inside the Azure directory");
    }
    if path.extension().and_then(|extension| extension.to_str()) != Some("f") {
        bail!("filelist must name a .f file");
    }
    let filelist = root.join(path);
    if !filelist.is_file() {
        bail!("filelist {} does not exist", value);
    }
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

    #[test]
    fn azure_bundles_are_disabled_by_default() {
        assert!(!enabled_value(None));
        assert!(!enabled_value(Some("false")));
        assert!(enabled_value(Some("true")));
    }

    #[test]
    fn filelist_must_stay_inside_the_downloaded_tree() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("design.f"), "top.sv\n").unwrap();

        assert_eq!(
            resolve_filelist(root.path(), "design.f").unwrap(),
            root.path().join("design.f")
        );
        assert!(resolve_filelist(root.path(), "../design.f").is_err());
        assert!(resolve_filelist(root.path(), "/tmp/design.f").is_err());
        assert!(resolve_filelist(root.path(), "top.sv").is_err());
    }
}
