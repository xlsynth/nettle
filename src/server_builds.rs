// SPDX-License-Identifier: Apache-2.0

//! Builds a Nettle bundle from an Azure RTL directory.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use tokio::sync::Semaphore;

use crate::{BuildOptions, ElaborationOverrides, builder::build_cancelable_untrusted_project};

const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS: u64 = 600;
const DEFAULT_COMPILER_TIMEOUT_SECONDS: u64 = 600;
const MAX_CONCURRENT_AZURE_BUILDS: usize = 2;
const MAX_AZURE_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_AZURE_DOWNLOAD_FILES: usize = 10_000;
const MAX_AZURE_COPY_ERROR_BYTES: usize = 32 * 1024;

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

struct CancelOnDrop {
    cancelled: Arc<AtomicBool>,
    armed: bool,
}

impl CancelOnDrop {
    fn new(cancelled: Arc<AtomicBool>) -> Self {
        Self {
            cancelled,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.cancelled.store(true, Ordering::Relaxed);
        }
    }
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
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut cancel_on_drop = CancelOnDrop::new(cancelled.clone());
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        build_bundle(&request, cancelled)
    });
    let task_result = task.await;
    cancel_on_drop.disarm();
    let bytes = task_result
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
    if !azure_path_has_safe_components(&request.azure_path) {
        bail!("azurePath must be an unambiguous az:// directory without traversal components");
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
    if !azure_path_has_safe_components(path) || !azure_path_has_safe_components(root) {
        return false;
    }
    path.trim_end_matches('/') == root.trim_end_matches('/')
        || path.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

fn azure_path_has_safe_components(path: &str) -> bool {
    let Some(remainder) = path.strip_prefix("az://") else {
        return false;
    };
    if remainder.is_empty()
        || path.contains(['\0', '\n', '\r', '\\', '?', '#', '%'])
        || remainder.starts_with('/')
    {
        return false;
    }
    let mut components = remainder.split('/').peekable();
    let mut component_count = 0_usize;
    while let Some(component) = components.next() {
        if component.is_empty() {
            return components.peek().is_none() && component_count >= 2;
        }
        if matches!(component, "." | "..") {
            return false;
        }
        component_count += 1;
    }
    component_count >= 2
}

fn build_bundle(request: &AzureBuildRequest, cancelled: Arc<AtomicBool>) -> Result<Vec<u8>> {
    let workspace = tempfile::Builder::new()
        .prefix("nettle-azure-")
        .tempdir()
        .context("creating Azure build workspace")?;
    let source_root = workspace.path().join("source");
    fs::create_dir(&source_root).context("creating source directory")?;
    copy_azure_directory(&request.azure_path, &source_root, &cancelled)?;
    ensure_tree_within_limits(
        &source_root,
        MAX_AZURE_DOWNLOAD_BYTES,
        MAX_AZURE_DOWNLOAD_FILES,
        &cancelled,
    )?;

    let filelist = resolve_filelist(&source_root, &request.filelist)?;
    let output = workspace.path().join("design.nettle");
    let project = build_cancelable_untrusted_project(
        &BuildOptions {
            filelist,
            project_root: Some(source_root),
            top: Some(request.top.clone()),
            elaboration: ElaborationOverrides::default(),
            slang_bin: std::env::var_os("NETTLE_SLANG_BIN").map(PathBuf::from),
            yosys_bin: std::env::var_os("NETTLE_YOSYS_BIN").map(PathBuf::from),
            compiler_timeout: Some(compiler_timeout()),
            debug_artifacts: false,
        },
        cancelled.clone(),
    )?;
    require_active_build(&cancelled)?;
    project
        .write(&output)
        .with_context(|| format!("writing bundle {}", output.display()))?;
    require_active_build(&cancelled)?;
    fs::read(&output).with_context(|| format!("reading bundle {}", output.display()))
}

fn copy_azure_directory(remote: &str, destination: &Path, cancelled: &AtomicBool) -> Result<()> {
    let mut command = Command::new("bbb");
    command
        .arg("cptree")
        .arg("--quiet")
        .arg(remote)
        .arg(destination)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    run_with_timeout(command, download_timeout(), cancelled).context("downloading Azure directory")
}

fn run_with_timeout(mut command: Command, timeout: Duration, cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        bail!("Azure build cancelled because the client disconnected");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        command.process_group(0);
    }
    let mut child = command.spawn().context("starting bbb")?;
    let stderr = child.stderr.take().expect("stderr was configured as piped");
    let stderr_reader = thread::spawn(move || read_bounded_copy_error(stderr));
    let start = Instant::now();
    loop {
        let status = match child.try_wait() {
            Ok(status) => status,
            Err(error) => {
                terminate_process_group(&mut child);
                let _ = child.wait();
                let _ = stderr_reader.join();
                return Err(error).context("waiting for bbb");
            }
        };
        if let Some(status) = status {
            if !status.success() {
                terminate_process_group(&mut child);
            }
            let stderr = stderr_reader
                .join()
                .map_err(|_| anyhow::anyhow!("bbb stderr reader panicked"))?
                .context("reading bbb stderr")?;
            if status.success() {
                return Ok(());
            }
            bail!("bbb exited with {status}: {}", stderr.trim());
        }
        if start.elapsed() >= timeout {
            terminate_process_group(&mut child);
            let _ = child.wait();
            let _ = stderr_reader.join();
            bail!("Azure copy timed out after {} seconds", timeout.as_secs());
        }
        if cancelled.load(Ordering::Relaxed) {
            terminate_process_group(&mut child);
            let _ = child.wait();
            let _ = stderr_reader.join();
            bail!("Azure build cancelled because the client disconnected");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn read_bounded_copy_error(mut reader: impl Read) -> io::Result<String> {
    let mut retained = Vec::with_capacity(MAX_AZURE_COPY_ERROR_BYTES);
    let mut omitted = 0_usize;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = MAX_AZURE_COPY_ERROR_BYTES.saturating_sub(retained.len());
        let keep = remaining.min(count);
        retained.extend_from_slice(&buffer[..keep]);
        omitted = omitted.saturating_add(count - keep);
    }
    let mut output = String::from_utf8_lossy(&retained).into_owned();
    if omitted > 0 {
        output.push_str(&format!("\n... <{omitted} bytes omitted from bbb stderr>"));
    }
    Ok(output)
}

#[cfg(unix)]
fn terminate_process_group(child: &mut std::process::Child) {
    if let Ok(process_group) = i32::try_from(child.id()) {
        // SAFETY: the child was placed in a process group whose id is its pid;
        // a negative pid targets that group, and SIGKILL needs no shared data.
        unsafe {
            libc::kill(-process_group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut std::process::Child) {
    let _ = child.kill();
}

fn download_timeout() -> Duration {
    Duration::from_secs(
        std::env::var("NETTLE_AZURE_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_DOWNLOAD_TIMEOUT_SECONDS),
    )
}

fn compiler_timeout() -> Duration {
    Duration::from_secs(
        std::env::var("NETTLE_AZURE_COMPILER_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_COMPILER_TIMEOUT_SECONDS),
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

fn ensure_tree_within_limits(
    root: &Path,
    maximum_bytes: u64,
    maximum_files: usize,
    cancelled: &AtomicBool,
) -> Result<()> {
    let mut pending = vec![root.to_path_buf()];
    let mut total_bytes = 0_u64;
    let mut total_files = 0_usize;

    while let Some(directory) = pending.pop() {
        require_active_build(cancelled)?;
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("reading downloaded directory {}", directory.display()))?
        {
            require_active_build(cancelled)?;
            let entry = entry?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .with_context(|| format!("reading downloaded entry {}", path.display()))?;
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file() {
                bail!(
                    "downloaded tree contains unsupported entry {}",
                    path.display()
                );
            }

            total_files = total_files
                .checked_add(1)
                .context("counting downloaded files")?;
            if total_files > maximum_files {
                bail!("Azure download exceeds the {maximum_files}-file limit");
            }
            total_bytes = total_bytes
                .checked_add(
                    entry
                        .metadata()
                        .with_context(|| format!("reading downloaded file {}", path.display()))?
                        .len(),
                )
                .context("counting downloaded bytes")?;
            if total_bytes > maximum_bytes {
                bail!("Azure download exceeds the {maximum_bytes}-byte limit");
            }
        }
    }

    Ok(())
}

fn require_active_build(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        bail!("Azure build cancelled because the client disconnected");
    }
    Ok(())
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
        assert!(!azure_path_is_allowed(
            "az://account/container/project/../private/",
            "az://account/container/project/"
        ));
        assert!(!azure_path_is_allowed(
            "az://account/container/project/%2e%2e/private/",
            "az://account/container/project/"
        ));
        assert!(!azure_path_is_allowed(
            "az://account//container/project/",
            "az://account/container/project/"
        ));
        assert!(azure_path_has_safe_components(
            "az://account/container/project/"
        ));
        assert!(!azure_path_has_safe_components("az://account/"));
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

    #[test]
    fn downloaded_tree_must_fit_the_configured_limits() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("first.sv"), "1234").unwrap();
        fs::create_dir(root.path().join("nested")).unwrap();
        fs::write(root.path().join("nested/second.sv"), "56").unwrap();

        let cancelled = AtomicBool::new(false);
        assert!(ensure_tree_within_limits(root.path(), 6, 2, &cancelled).is_ok());
        assert!(ensure_tree_within_limits(root.path(), 5, 2, &cancelled).is_err());
        assert!(ensure_tree_within_limits(root.path(), 6, 1, &cancelled).is_err());
    }

    #[test]
    fn dropping_an_armed_request_cancels_its_build() {
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let _guard = CancelOnDrop::new(cancelled.clone());
        }
        assert!(cancelled.load(Ordering::Relaxed));

        let completed = Arc::new(AtomicBool::new(false));
        {
            let mut guard = CancelOnDrop::new(completed.clone());
            guard.disarm();
        }
        assert!(!completed.load(Ordering::Relaxed));
    }

    #[test]
    fn cancelled_download_does_not_start_a_process() {
        let cancelled = AtomicBool::new(true);
        let error = run_with_timeout(
            Command::new("this-command-must-not-run"),
            Duration::from_secs(1),
            &cancelled,
        )
        .unwrap_err();
        assert!(error.to_string().contains("client disconnected"));
    }

    #[test]
    fn bounds_azure_copy_error_output() {
        let input = vec![b'x'; MAX_AZURE_COPY_ERROR_BYTES + 17];
        let output = read_bounded_copy_error(std::io::Cursor::new(input)).unwrap();
        assert!(output.starts_with(&"x".repeat(128)));
        assert!(output.contains("<17 bytes omitted from bbb stderr>"));
        assert!(output.len() < MAX_AZURE_COPY_ERROR_BYTES + 128);
    }
}
