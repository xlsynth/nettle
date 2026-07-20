// SPDX-License-Identifier: Apache-2.0

//! Hosts the browser viewer, durable shareable sessions, and a bounded build queue.

use std::collections::{BTreeSet, VecDeque};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use zip::ZipArchive;

use crate::bundle::BundleReader;
use crate::ir::{NormalizedArgumentKind, normalize_filelist_within_root_cancellable};
use crate::resource_limits::bundle::archive::ENTRY_COUNT as MAX_BUNDLE_ENTRY_COUNT;

const HOST_SCHEMA_VERSION: u32 = 1;
const MULTIPART_OVERHEAD_BYTES: u64 = 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MAX_ARCHIVE_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_COMPRESSION_RATIO: u64 = 200;
const MAX_ARCHIVE_PATH_BYTES: usize = 1024;
const MAX_ARCHIVE_PATH_COMPONENTS: usize = 64;
const MAX_TAR_EXTENSION_BYTES: u64 = 1024 * 1024;
const MAX_ZIP_CENTRAL_DIRECTORY_BYTES: u64 = MAX_ARCHIVE_ENTRY_BYTES;
const ZIP_EOCD_BYTES: usize = 22;
const ZIP_EOCD_SEARCH_BYTES: usize = ZIP_EOCD_BYTES + u16::MAX as usize;
const ZIP64_LOCATOR_BYTES: u64 = 20;
const ZIP64_EOCD_MIN_BYTES: usize = 56;
const ENOSPC_METADATA_COMMIT_ATTEMPTS: usize = 3;
const TERMINAL_METADATA_COMMIT_ATTEMPTS: usize = 3;
const TERMINAL_METADATA_RETRY_DELAY: Duration = Duration::from_millis(100);
const SCRATCH_CLEANUP_ATTEMPTS: usize = 3;
const SCRATCH_CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(100);
const TERMINAL_CLEANUP_ATTEMPTS: usize = 3;
const TERMINAL_CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(100);
const MAX_RETAINED_ERROR_BYTES: usize = 32 * 1024;
const STREAM_CHUNK_BYTES: usize = 64 * 1024;
const RETENTION_SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy)]
struct BuildDeadline {
    expires_at: Instant,
    limit: Duration,
}

impl BuildDeadline {
    fn new(limit: Duration) -> Result<Self> {
        let expires_at = Instant::now()
            .checked_add(limit)
            .ok_or_else(|| anyhow!("source-build deadline is outside the supported range"))?;
        Ok(Self { expires_at, limit })
    }

    fn check(self, stage: &str) -> Result<()> {
        if Instant::now() >= self.expires_at {
            bail!(
                "source build exceeded the {}-second deadline during {stage}",
                self.limit.as_secs()
            );
        }
        Ok(())
    }

    fn check_io(self, stage: &str) -> io::Result<()> {
        self.check(stage)
            .map_err(|error| io::Error::new(io::ErrorKind::TimedOut, error))
    }

    fn remaining(self, stage: &str) -> Result<Duration> {
        self.check(stage)?;
        Ok(self.expires_at.saturating_duration_since(Instant::now()))
    }
}

/// Runtime settings for the single-process hosted Nettle service.
#[derive(Debug, Clone)]
pub struct HostOptions {
    /// Production Vite build containing `index.html` and assets.
    pub web_root: PathBuf,
    /// Browser-facing bind address.
    pub bind_address: IpAddr,
    /// Browser-facing TCP port.
    pub port: u16,
    /// Persistent filesystem root for queue state and completed sessions.
    pub storage_root: PathBuf,
    /// Ephemeral filesystem root used for extraction and compiler output.
    pub scratch_root: PathBuf,
    /// Maximum number of source builds waiting behind any active build.
    pub max_queued_builds: usize,
    /// Hard deadline for one source build.
    pub build_timeout: Duration,
    /// Optional age after which terminal sessions are removed.
    pub evict_after: Option<Duration>,
    /// Maximum compressed upload size.
    pub max_upload_bytes: u64,
}

impl HostOptions {
    fn validate(&self) -> Result<()> {
        if self.max_queued_builds == 0 {
            bail!("--max-queued-builds must be greater than zero");
        }
        if self.build_timeout.is_zero() {
            bail!("--build-timeout must be greater than zero");
        }
        if self.max_upload_bytes == 0 {
            bail!("--max-upload-bytes must be greater than zero");
        }
        if self.evict_after.is_some_and(|duration| duration.is_zero()) {
            bail!("--evict-after must be greater than zero when provided");
        }
        if !self.web_root.join("index.html").is_file() {
            bail!("web root {} has no index.html", self.web_root.display());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SessionKind {
    Bundle,
    Sources,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SessionState {
    Queued,
    Building,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SourceFormat {
    Zip,
    Tar,
    TarGz,
}

impl SourceFormat {
    fn from_filename(filename: &str) -> Option<Self> {
        let lower = filename.to_ascii_lowercase();
        if lower.ends_with(".zip") {
            Some(Self::Zip)
        } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
            Some(Self::TarGz)
        } else if lower.ends_with(".tar") {
            Some(Self::Tar)
        } else {
            None
        }
    }

    fn stored_filename(self) -> &'static str {
        match self {
            Self::Zip => "sources.zip",
            Self::Tar => "sources.tar",
            Self::TarGz => "sources.tar.gz",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionMetadata {
    schema_version: u32,
    token: String,
    kind: SessionKind,
    state: SessionState,
    original_name: String,
    upload_bytes: u64,
    admitted_at_ms: u64,
    queue_order: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    build_started_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at_ms: Option<u64>,
    interruptions: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_format: Option<SourceFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug)]
struct QueueState {
    jobs: VecDeque<String>,
    next_order: u64,
}

#[derive(Debug)]
struct HostStateInner {
    options: HostOptions,
    sessions_root: PathBuf,
    staging_root: PathBuf,
    queue: Mutex<QueueState>,
    // Counts queued jobs plus source uploads that reserved capacity before streaming.
    // The active build is excluded once the worker pops it from `queue.jobs`.
    source_queue_slots: AtomicUsize,
    notify: Notify,
}

#[derive(Clone, Debug)]
struct HostState(Arc<HostStateInner>);

struct SourceQueueReservation {
    state: HostState,
    committed: bool,
}

impl SourceQueueReservation {
    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for SourceQueueReservation {
    fn drop(&mut self) {
        if !self.committed {
            release_source_queue_slot(&self.state);
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionResponse {
    token: String,
    url: String,
    status_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusResponse {
    state: SessionState,
    admitted_at_ms: u64,
    server_time_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    build_started_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue_position: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn invalid_upload(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            message: message.into(),
        }
    }

    fn internal() -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "The server could not complete this request.".to_owned(),
        }
    }

    fn from_storage(error: &io::Error) -> Self {
        if error.raw_os_error() == Some(libc::ENOSPC) {
            return Self {
                status: StatusCode::INSUFFICIENT_STORAGE,
                message: "This Nettle server is out of storage space. Try again after old sessions are removed or contact the admin.".to_owned(),
            };
        }
        Self::internal()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
            Json(json!({ "error": self.message })),
        )
            .into_response()
    }
}

/// Serves the hosted viewer and processes the durable source-build queue.
pub async fn serve_host(options: HostOptions) -> Result<SocketAddr> {
    options.validate()?;
    let state = initialize_state(options)?;
    let app = host_router(state.clone())?;
    let listener =
        tokio::net::TcpListener::bind((state.0.options.bind_address, state.0.options.port))
            .await
            .with_context(|| {
                format!(
                    "binding hosted Nettle to {}:{}",
                    state.0.options.bind_address, state.0.options.port
                )
            })?;
    let address = listener.local_addr()?;
    println!("Nettle host listening on {address}");

    let worker = tokio::spawn(build_worker(state.clone()));
    let retention = tokio::spawn(retention_worker(state));
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    worker.abort();
    retention.abort();
    let _ = worker.await;
    let _ = retention.await;
    serve_result?;
    Ok(address)
}

fn initialize_state(mut options: HostOptions) -> Result<HostState> {
    fs::create_dir_all(&options.storage_root).with_context(|| {
        format!(
            "creating hosted storage root {}",
            options.storage_root.display()
        )
    })?;
    fs::create_dir_all(&options.scratch_root).with_context(|| {
        format!(
            "creating hosted scratch root {}",
            options.scratch_root.display()
        )
    })?;
    let storage_root =
        fs::canonicalize(&options.storage_root).context("canonicalizing hosted storage root")?;
    let scratch_base =
        fs::canonicalize(&options.scratch_root).context("canonicalizing hosted scratch root")?;
    let web_root = fs::canonicalize(&options.web_root).context("canonicalizing hosted web root")?;
    if paths_overlap(&storage_root, &scratch_base) {
        bail!("--storage-root and --scratch-root must be separate, non-nested directories");
    }
    if paths_overlap(&web_root, &storage_root) {
        bail!("--web-root and --storage-root must be separate, non-nested directories");
    }
    if paths_overlap(&web_root, &scratch_base) {
        bail!("--web-root and --scratch-root must be separate, non-nested directories");
    }
    options.storage_root = storage_root;
    options.scratch_root = scratch_base.join("nettle-host");
    fs::create_dir_all(&options.scratch_root)?;
    let sessions_root = options.storage_root.join("sessions");
    let staging_root = options.storage_root.join(".staging");
    fs::create_dir_all(&sessions_root)?;
    fs::create_dir_all(&staging_root)?;
    sync_directory(&options.storage_root)?;
    clear_directory(&staging_root)?;
    clear_directory(&options.scratch_root)?;
    sweep_retention_root(&sessions_root, options.evict_after)?;

    let mut queued = Vec::new();
    let mut deferred_terminal_metadata = Vec::new();
    let mut max_order = 0_u64;
    for entry in fs::read_dir(&sessions_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(directory_token) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !validate_token(&directory_token) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = read_metadata(&path) else {
            continue;
        };
        if metadata.token != directory_token {
            continue;
        }
        max_order = max_order.max(metadata.queue_order);
        match reconcile_startup_session(&path, metadata, write_metadata)? {
            StartupSessionDisposition::Queue { order, token } => queued.push((order, token)),
            StartupSessionDisposition::Terminal => {}
            StartupSessionDisposition::Deferred(metadata) => {
                deferred_terminal_metadata.push((path, metadata));
            }
        }
    }
    queued.sort();
    let queued_builds = queued.len();
    let state = HostState(Arc::new(HostStateInner {
        options,
        sessions_root,
        staging_root,
        queue: Mutex::new(QueueState {
            jobs: queued.into_iter().map(|(_, token)| token).collect(),
            next_order: max_order.saturating_add(1),
        }),
        source_queue_slots: AtomicUsize::new(queued_builds),
        notify: Notify::new(),
    }));
    for (session_path, metadata) in deferred_terminal_metadata {
        spawn_terminal_metadata_retry(state.clone(), session_path, metadata);
    }
    Ok(state)
}

enum StartupSessionDisposition {
    Queue { order: u64, token: String },
    Terminal,
    Deferred(SessionMetadata),
}

fn reconcile_startup_session(
    session_path: &Path,
    mut metadata: SessionMetadata,
    mut commit_metadata: impl FnMut(&Path, &SessionMetadata) -> io::Result<()>,
) -> Result<StartupSessionDisposition> {
    if matches!(metadata.state, SessionState::Ready | SessionState::Failed) {
        cleanup_terminal_artifacts_once(session_path, &metadata);
        return Ok(StartupSessionDisposition::Terminal);
    }

    let archive_exists = metadata
        .source_format
        .is_some_and(|format| session_path.join(format.stored_filename()).is_file());
    let design_path = session_path.join("design.nettle");
    let valid_design = design_path.is_file() && validate_bundle(&design_path).is_ok();
    if metadata.state == SessionState::Building && valid_design {
        metadata.state = SessionState::Ready;
        metadata.completed_at_ms = Some(now_ms());
        metadata.error = None;
        return commit_startup_terminal_metadata(session_path, metadata, &mut commit_metadata);
    }

    if !archive_exists {
        metadata.state = SessionState::Failed;
        metadata.build_started_at_ms = None;
        metadata.completed_at_ms = Some(now_ms());
        metadata.error =
            Some("Build could not resume because its source upload is unavailable.".to_owned());
        return commit_startup_terminal_metadata(session_path, metadata, &mut commit_metadata);
    }

    if metadata.state == SessionState::Queued {
        return Ok(StartupSessionDisposition::Queue {
            order: metadata.queue_order,
            token: metadata.token,
        });
    }

    if metadata.interruptions == 0 {
        metadata.interruptions = 1;
        metadata.state = SessionState::Queued;
        metadata.build_started_at_ms = None;
        match commit_metadata(session_path, &metadata) {
            Ok(()) => {
                return Ok(StartupSessionDisposition::Queue {
                    order: metadata.queue_order,
                    token: metadata.token,
                });
            }
            Err(error) if error.raw_os_error() == Some(libc::ENOSPC) => {
                metadata.state = SessionState::Failed;
                metadata.completed_at_ms = Some(now_ms());
                metadata.error = Some(
                    "Build could not resume because the Nettle server is out of storage space."
                        .to_owned(),
                );
                return commit_startup_terminal_metadata(
                    session_path,
                    metadata,
                    &mut commit_metadata,
                );
            }
            Err(error) => return Err(error).context("committing hosted restart recovery"),
        }
    }

    metadata.state = SessionState::Failed;
    metadata.completed_at_ms = Some(now_ms());
    metadata.error = Some("Build interrupted repeatedly while the server restarted.".to_owned());
    commit_startup_terminal_metadata(session_path, metadata, &mut commit_metadata)
}

fn commit_startup_terminal_metadata(
    session_path: &Path,
    metadata: SessionMetadata,
    commit_metadata: &mut impl FnMut(&Path, &SessionMetadata) -> io::Result<()>,
) -> Result<StartupSessionDisposition> {
    cleanup_terminal_artifacts_once(session_path, &metadata);
    for _ in 0..ENOSPC_METADATA_COMMIT_ATTEMPTS {
        match commit_metadata(session_path, &metadata) {
            Ok(()) => return Ok(StartupSessionDisposition::Terminal),
            Err(error) if error.raw_os_error() == Some(libc::ENOSPC) => {
                cleanup_terminal_artifacts_once(session_path, &metadata);
            }
            Err(error) => return Err(error).context("committing hosted terminal recovery"),
        }
    }
    Ok(StartupSessionDisposition::Deferred(metadata))
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn host_router(state: HostState) -> Result<Router> {
    let index = state.0.options.web_root.join("index.html");
    let body_limit = usize::try_from(
        state
            .0
            .options
            .max_upload_bytes
            .saturating_add(MULTIPART_OVERHEAD_BYTES),
    )
    .unwrap_or(usize::MAX);
    let static_service = ServeDir::new(&state.0.options.web_root)
        .not_found_service(ServeFile::new(index.clone()))
        .append_index_html_on_directories(true);
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(|| async { "ok" }))
        .route("/api/v1/config", get(get_config))
        .route("/api/v1/sessions", post(create_session))
        .route("/api/v1/sessions/{token}/status", get(get_status))
        .route("/api/v1/sessions/{token}/bundle", get(get_bundle))
        .route(
            "/api/v1/sessions/{token}/download",
            get(download_bundle),
        )
        .route_service("/s/{token}", ServeFile::new(index))
        .fallback_service(static_service)
        .with_state(state)
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::HeaderName::from_static("x-robots-tag"),
            HeaderValue::from_static("noindex"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            ),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        ));
    Ok(app)
}

async fn shutdown_signal() {
    let control_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = control_c => {}
        () = terminate => {}
    }
}

async fn get_config(State(state): State<HostState>) -> impl IntoResponse {
    let retention = match state.0.options.evict_after {
        Some(duration) => json!({
            "mode": "expires",
            "seconds": duration.as_secs(),
            "display": retention_display(duration),
        }),
        None => json!({
            "mode": "forever",
            "display": "Retained until an admin removes it",
        }),
    };
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(json!({
            "hostingEnabled": true,
            "retention": retention,
            "limits": {
                "maxUploadBytes": state.0.options.max_upload_bytes,
                "maxQueuedBuilds": state.0.options.max_queued_builds,
            },
            "sourceFormats": [".zip", ".tar", ".tar.gz", ".tgz"],
        })),
    )
}

fn storage_retry<T>(
    state: &HostState,
    mut operation: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    match operation() {
        Err(error) if error.raw_os_error() == Some(libc::ENOSPC) => {
            let _ = sweep_retention(state);
            operation()
        }
        result => result,
    }
}

fn commit_staged_session(
    state: &HostState,
    staged_path: &Path,
    session_path: &Path,
) -> io::Result<()> {
    commit_staged_session_with_sync(state, staged_path, session_path, |parent| {
        storage_retry(state, || sync_directory(parent))
    })
}

fn commit_staged_session_with_sync(
    state: &HostState,
    staged_path: &Path,
    session_path: &Path,
    mut sync_parent: impl FnMut(&Path) -> io::Result<()>,
) -> io::Result<()> {
    storage_retry(state, || fs::rename(staged_path, session_path))?;
    let sync_result =
        sync_parent(&state.0.staging_root).and_then(|()| sync_parent(&state.0.sessions_root));
    if let Err(error) = sync_result {
        rollback_session_admission(state, session_path);
        return Err(error);
    }
    Ok(())
}

fn rollback_session_admission(state: &HostState, session_path: &Path) {
    if fs::remove_dir_all(session_path).is_ok() {
        let _ = sync_directory(&state.0.sessions_root);
    }
    // Retry confirmation that the rename source is absent. This is best effort:
    // the original sync error remains the request's result.
    let _ = sync_directory(&state.0.staging_root);
}

async fn create_upload_file(
    state: &HostState,
    path: &Path,
) -> std::result::Result<tokio::fs::File, ApiError> {
    match tokio::fs::File::create(path).await {
        Err(error) if error.raw_os_error() == Some(libc::ENOSPC) => {
            let _ = sweep_retention(state);
            tokio::fs::File::create(path)
                .await
                .map_err(|retry| ApiError::from_storage(&retry))
        }
        Err(error) => Err(ApiError::from_storage(&error)),
        Ok(file) => Ok(file),
    }
}

async fn write_upload_chunk(
    state: &HostState,
    output: &mut tokio::fs::File,
    chunk: &[u8],
) -> std::result::Result<(), ApiError> {
    let mut offset = 0_usize;
    let mut retried = false;
    while offset < chunk.len() {
        match output.write(&chunk[offset..]).await {
            Ok(0) => return Err(ApiError::internal()),
            Ok(written) => offset += written,
            Err(error) if error.raw_os_error() == Some(libc::ENOSPC) && !retried => {
                let _ = sweep_retention(state);
                retried = true;
            }
            Err(error) => return Err(ApiError::from_storage(&error)),
        }
    }
    Ok(())
}

async fn sync_upload_file(
    state: &HostState,
    output: &tokio::fs::File,
) -> std::result::Result<(), ApiError> {
    match output.sync_all().await {
        Err(error) if error.raw_os_error() == Some(libc::ENOSPC) => {
            let _ = sweep_retention(state);
            output
                .sync_all()
                .await
                .map_err(|retry| ApiError::from_storage(&retry))
        }
        Err(error) => Err(ApiError::from_storage(&error)),
        Ok(()) => Ok(()),
    }
}

async fn create_session(
    State(state): State<HostState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> std::result::Result<impl IntoResponse, ApiError> {
    if headers
        .get("x-nettle-upload")
        .and_then(|value| value.to_str().ok())
        != Some("1")
    {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Hosted uploads require a same-origin Nettle client.".to_owned(),
        });
    }
    let staging = storage_retry(&state, || {
        tempfile::Builder::new()
            .prefix("upload-")
            .tempdir_in(&state.0.staging_root)
    })
    .map_err(|error| ApiError::from_storage(&error))?;
    let upload_path = staging.path().join("upload");
    let mut kind = None;
    let mut source_reservation = None;
    let mut original_name = None;
    let mut upload_bytes = None;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::bad_request("Malformed multipart upload."))?
    {
        match field.name() {
            Some("kind") => {
                if kind.is_some() {
                    return Err(ApiError::bad_request(
                        "Upload contains duplicate kind fields.",
                    ));
                }
                let bytes = read_small_field(&mut field, 16).await?;
                let parsed_kind = match bytes.as_slice() {
                    b"bundle" => SessionKind::Bundle,
                    b"sources" => SessionKind::Sources,
                    _ => {
                        return Err(ApiError::bad_request(
                            "Upload kind must be bundle or sources.",
                        ));
                    }
                };
                if parsed_kind == SessionKind::Sources {
                    source_reservation = Some(try_reserve_source_queue_slot(&state)?);
                }
                kind = Some(parsed_kind);
            }
            Some("file") => {
                if upload_bytes.is_some() {
                    return Err(ApiError::bad_request("Upload contains duplicate files."));
                }
                if kind.is_none() {
                    return Err(ApiError::bad_request(
                        "Upload kind must precede the file field.",
                    ));
                }
                let filename = field
                    .file_name()
                    .map(safe_display_filename)
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| ApiError::bad_request("Uploaded file has no filename."))?;
                let mut output = create_upload_file(&state, &upload_path).await?;
                let mut total = 0_u64;
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|_| ApiError::bad_request("Could not read uploaded file."))?
                {
                    total = total
                        .checked_add(
                            u64::try_from(chunk.len())
                                .map_err(|_| ApiError::bad_request("Upload is too large."))?,
                        )
                        .ok_or_else(|| ApiError::bad_request("Upload is too large."))?;
                    if total > state.0.options.max_upload_bytes {
                        return Err(ApiError {
                            status: StatusCode::PAYLOAD_TOO_LARGE,
                            message: format!(
                                "Upload exceeds the {}-byte limit.",
                                state.0.options.max_upload_bytes
                            ),
                        });
                    }
                    write_upload_chunk(&state, &mut output, &chunk).await?;
                }
                if total == 0 {
                    return Err(ApiError::bad_request("Uploaded file is empty."));
                }
                sync_upload_file(&state, &output).await?;
                original_name = Some(filename);
                upload_bytes = Some(total);
            }
            Some(_) | None => {
                return Err(ApiError::bad_request(
                    "Upload contains an unsupported multipart field.",
                ));
            }
        }
    }

    let kind = kind.ok_or_else(|| ApiError::bad_request("Upload is missing kind."))?;
    let original_name =
        original_name.ok_or_else(|| ApiError::bad_request("Upload is missing file."))?;
    let upload_bytes =
        upload_bytes.ok_or_else(|| ApiError::bad_request("Upload is missing file."))?;

    match kind {
        SessionKind::Bundle if !original_name.to_ascii_lowercase().ends_with(".nettle") => {
            return Err(ApiError::bad_request(
                "A bundle upload must have a .nettle filename.",
            ));
        }
        SessionKind::Sources if SourceFormat::from_filename(&original_name).is_none() => {
            return Err(ApiError::bad_request(
                "A source upload must be .zip, .tar, .tar.gz, or .tgz.",
            ));
        }
        SessionKind::Bundle | SessionKind::Sources => {}
    }

    if kind == SessionKind::Bundle {
        let validation_path = upload_path.clone();
        tokio::task::spawn_blocking(move || validate_bundle(&validation_path))
            .await
            .map_err(|_| ApiError::internal())?
            .map_err(|error| {
                ApiError::invalid_upload(format!("Invalid .nettle bundle: {error}"))
            })?;
    }

    let token = generate_token().map_err(|_| ApiError::internal())?;
    let mut queue = state.0.queue.lock().await;
    let queue_order = queue.next_order;
    queue.next_order = queue.next_order.saturating_add(1);
    let admitted_at_ms = now_ms();
    let source_format = (kind == SessionKind::Sources)
        .then(|| SourceFormat::from_filename(&original_name))
        .flatten();
    let completed_at_ms = (kind == SessionKind::Bundle).then_some(admitted_at_ms);
    let metadata = SessionMetadata {
        schema_version: HOST_SCHEMA_VERSION,
        token: token.clone(),
        kind,
        state: if kind == SessionKind::Bundle {
            SessionState::Ready
        } else {
            SessionState::Queued
        },
        original_name,
        upload_bytes,
        admitted_at_ms,
        queue_order,
        build_started_at_ms: None,
        completed_at_ms,
        interruptions: 0,
        source_format,
        error: None,
    };
    let staged_path = staging.path().to_owned();
    let stored_file = match kind {
        SessionKind::Bundle => "design.nettle",
        SessionKind::Sources => source_format
            .expect("source uploads were assigned a format")
            .stored_filename(),
    };
    storage_retry(&state, || {
        fs::rename(staged_path.join("upload"), staged_path.join(stored_file))
    })
    .map_err(|error| ApiError::from_storage(&error))?;
    storage_retry(&state, || write_metadata(&staged_path, &metadata))
        .map_err(|error| ApiError::from_storage(&error))?;
    let staged_path = staging.into_path();
    let session_path = state.0.sessions_root.join(&token);
    if let Err(error) = commit_staged_session(&state, &staged_path, &session_path) {
        let _ = fs::remove_dir_all(&staged_path);
        return Err(ApiError::from_storage(&error));
    }
    if kind == SessionKind::Sources {
        queue.jobs.push_back(token.clone());
        source_reservation
            .take()
            .expect("source uploads reserve queue capacity before streaming")
            .commit();
        state.0.notify.notify_one();
    }
    drop(queue);

    let response = CreateSessionResponse {
        url: format!("/s/{token}"),
        status_url: format!("/api/v1/sessions/{token}/status"),
        token,
    };
    Ok((
        if kind == SessionKind::Bundle {
            StatusCode::CREATED
        } else {
            StatusCode::ACCEPTED
        },
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(response),
    ))
}

async fn read_small_field(
    field: &mut axum::extract::multipart::Field<'_>,
    limit: usize,
) -> std::result::Result<Vec<u8>, ApiError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|_| ApiError::bad_request("Could not read multipart field."))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(ApiError::bad_request("Multipart field is too long."));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn try_reserve_source_queue_slot(
    state: &HostState,
) -> std::result::Result<SourceQueueReservation, ApiError> {
    let max_queued_builds = state.0.options.max_queued_builds;
    state
        .0
        .source_queue_slots
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |slots| {
            (slots < max_queued_builds).then_some(slots + 1)
        })
        .map_err(|_| ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "The source build queue is full. Try again later.".to_owned(),
        })?;
    Ok(SourceQueueReservation {
        state: state.clone(),
        committed: false,
    })
}

fn release_source_queue_slot(state: &HostState) {
    state
        .0
        .source_queue_slots
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |slots| {
            slots.checked_sub(1)
        })
        .expect("source queue slot counter underflowed");
}

fn retain_requeued_source_slot(state: &HostState) {
    state.0.source_queue_slots.fetch_add(1, Ordering::AcqRel);
}

async fn get_status(
    State(state): State<HostState>,
    AxumPath(token): AxumPath<String>,
) -> std::result::Result<impl IntoResponse, ApiError> {
    let metadata = load_visible_metadata(&state, &token)?;
    let queue_position = if metadata.state == SessionState::Queued {
        let queue = state.0.queue.lock().await;
        queue
            .jobs
            .iter()
            .position(|queued| queued == &token)
            .map(|index| index + 1)
    } else {
        None
    };
    let expires_at_ms = expiration_ms(&state, &metadata);
    Ok((
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(SessionStatusResponse {
            state: metadata.state,
            admitted_at_ms: metadata.admitted_at_ms,
            server_time_ms: now_ms(),
            build_started_at_ms: metadata.build_started_at_ms,
            completed_at_ms: metadata.completed_at_ms,
            expires_at_ms,
            queue_position,
            error: metadata.error,
        }),
    ))
}

async fn get_bundle(
    State(state): State<HostState>,
    AxumPath(token): AxumPath<String>,
) -> std::result::Result<Response, ApiError> {
    serve_session_bundle(&state, &token, false).await
}

async fn download_bundle(
    State(state): State<HostState>,
    AxumPath(token): AxumPath<String>,
) -> std::result::Result<Response, ApiError> {
    serve_session_bundle(&state, &token, true).await
}

async fn serve_session_bundle(
    state: &HostState,
    token: &str,
    attachment: bool,
) -> std::result::Result<Response, ApiError> {
    let metadata = load_visible_metadata(state, token)?;
    if metadata.state != SessionState::Ready {
        return Err(not_found());
    }
    let path = session_path(state, token)?.join("design.nettle");
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| not_found())?;
    let byte_len = file.metadata().await.map_err(|_| not_found())?.len();
    let stream = async_stream::stream! {
        let mut buffer = vec![0_u8; STREAM_CHUNK_BYTES];
        loop {
            match file.read(&mut buffer).await {
                Ok(0) => break,
                Ok(count) => yield Ok::<Vec<u8>, io::Error>(buffer[..count].to_vec()),
                Err(error) => {
                    yield Err::<Vec<u8>, io::Error>(error);
                    break;
                }
            }
        }
    };
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, byte_len);
    if attachment {
        builder = builder.header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"design.nettle\"",
        );
    }
    builder
        .body(Body::from_stream(stream))
        .map_err(|_| ApiError::internal())
}

fn safe_display_filename(filename: &str) -> String {
    Path::new(filename)
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned())
        .chars()
        .filter(|character| !character.is_control())
        .take(255)
        .collect()
}

fn generate_token() -> Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| anyhow!("generating session capability token: {error}"))?;
    Ok(hex::encode(bytes))
}

fn now_ms() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

fn retention_display(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds.is_multiple_of(24 * 60 * 60) {
        let days = seconds / (24 * 60 * 60);
        format!(
            "Retained for {days} day{} after completion",
            if days == 1 { "" } else { "s" }
        )
    } else if seconds.is_multiple_of(60 * 60) {
        let hours = seconds / (60 * 60);
        format!(
            "Retained for {hours} hour{} after completion",
            if hours == 1 { "" } else { "s" }
        )
    } else {
        format!("Retained for {seconds} seconds after completion")
    }
}

fn validate_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn session_path(state: &HostState, token: &str) -> std::result::Result<PathBuf, ApiError> {
    if !validate_token(token) {
        return Err(not_found());
    }
    Ok(state.0.sessions_root.join(token))
}

fn load_visible_metadata(
    state: &HostState,
    token: &str,
) -> std::result::Result<SessionMetadata, ApiError> {
    let path = session_path(state, token)?;
    let metadata = read_metadata(&path).map_err(|_| not_found())?;
    if metadata.token != token || metadata.schema_version != HOST_SCHEMA_VERSION {
        return Err(not_found());
    }
    if expiration_ms(state, &metadata).is_some_and(|expires| expires <= now_ms()) {
        return Err(not_found());
    }
    Ok(metadata)
}

fn expiration_ms(state: &HostState, metadata: &SessionMetadata) -> Option<u64> {
    let retention_ms = state
        .0
        .options
        .evict_after?
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    metadata
        .completed_at_ms
        .map(|completed| completed.saturating_add(retention_ms))
}

fn not_found() -> ApiError {
    ApiError {
        status: StatusCode::NOT_FOUND,
        message: "Session not found or expired.".to_owned(),
    }
}

fn metadata_path(session_path: &Path) -> PathBuf {
    session_path.join("metadata.json")
}

fn read_metadata(session_path: &Path) -> Result<SessionMetadata> {
    let bytes = fs::read(metadata_path(session_path))?;
    let metadata: SessionMetadata = serde_json::from_slice(&bytes)?;
    if metadata.schema_version != HOST_SCHEMA_VERSION {
        bail!(
            "unsupported hosted session metadata schema {}",
            metadata.schema_version
        );
    }
    Ok(metadata)
}

fn write_metadata(session_path: &Path, metadata: &SessionMetadata) -> io::Result<()> {
    let temporary = session_path.join(".metadata.json.tmp");
    let bytes = serde_json::to_vec(metadata).map_err(io::Error::other)?;
    let result = (|| {
        let mut output = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)?;
        output.write_all(&bytes)?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, metadata_path(session_path))?;
        sync_directory(session_path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn validate_bundle(path: &Path) -> Result<()> {
    preflight_hosted_zip(path, MAX_BUNDLE_ENTRY_COUNT)?;
    let mut reader = BundleReader::open(path)?;
    reader.validate_all()?;
    Ok(())
}

fn preflight_hosted_zip(path: &Path, max_entries: usize) -> Result<()> {
    preflight_hosted_zip_with_deadline(path, max_entries, None)
}

fn preflight_hosted_zip_with_deadline(
    path: &Path,
    max_entries: usize,
    deadline: Option<BuildDeadline>,
) -> Result<()> {
    const EOCD_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
    const ZIP64_EOCD_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x06, 0x06];
    const ZIP64_LOCATOR_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x06, 0x07];

    if let Some(deadline) = deadline {
        deadline.check("ZIP metadata validation")?;
    }
    let mut input = File::open(path)?;
    let file_bytes = input.metadata()?.len();
    if file_bytes < ZIP_EOCD_BYTES as u64 {
        bail!("ZIP end-of-central-directory record is missing");
    }

    // The extra bytes cover the fixed ZIP64 record and locator immediately
    // before the furthest legal classic EOCD. Reads remain bounded even when
    // the uploaded file is very large.
    let tail_bytes = file_bytes.min(
        u64::try_from(ZIP_EOCD_SEARCH_BYTES + ZIP64_EOCD_MIN_BYTES)
            .expect("ZIP preflight tail length fits u64"),
    );
    let tail_offset = file_bytes - tail_bytes;
    input.seek(SeekFrom::Start(tail_offset))?;
    let mut tail = vec![
        0_u8;
        usize::try_from(tail_bytes)
            .context("ZIP preflight tail does not fit in memory")?
    ];
    input.read_exact(&mut tail)?;
    if let Some(deadline) = deadline {
        deadline.check("ZIP metadata validation")?;
    }

    let search_start = tail.len().saturating_sub(ZIP_EOCD_SEARCH_BYTES);
    let search_end = tail
        .len()
        .checked_sub(ZIP_EOCD_BYTES)
        .ok_or_else(|| anyhow!("ZIP end-of-central-directory record is missing"))?;
    let eocd = (search_start..=search_end)
        .rev()
        .find(|offset| tail[*offset..].starts_with(&EOCD_SIGNATURE))
        .ok_or_else(|| anyhow!("ZIP end-of-central-directory record is missing"))?;
    let comment_bytes = usize::from(zip_u16(&tail, eocd + 20)?);
    if eocd
        .checked_add(ZIP_EOCD_BYTES)
        .and_then(|end| end.checked_add(comment_bytes))
        != Some(tail.len())
    {
        bail!("ZIP has trailing bytes or a malformed end-of-central-directory comment");
    }

    let disk = zip_u16(&tail, eocd + 4)?;
    let directory_disk = zip_u16(&tail, eocd + 6)?;
    let entries_on_disk = zip_u16(&tail, eocd + 8)?;
    let total_entries = zip_u16(&tail, eocd + 10)?;
    let directory_bytes = zip_u32(&tail, eocd + 12)?;
    let directory_offset = zip_u32(&tail, eocd + 16)?;
    let eocd_absolute = tail_offset
        .checked_add(u64::try_from(eocd).context("ZIP EOCD offset overflow")?)
        .ok_or_else(|| anyhow!("ZIP EOCD offset overflow"))?;
    let locator_offset = eocd_absolute.checked_sub(ZIP64_LOCATOR_BYTES);
    let locator = locator_offset
        .and_then(|offset| read_zip_bytes(&mut input, offset, ZIP64_LOCATOR_BYTES as usize).ok())
        .filter(|bytes| bytes.starts_with(&ZIP64_LOCATOR_SIGNATURE));
    let needs_zip64 = disk == u16::MAX
        || directory_disk == u16::MAX
        || entries_on_disk == u16::MAX
        || total_entries == u16::MAX
        || directory_bytes == u32::MAX
        || directory_offset == u32::MAX;

    let (entries_on_disk, total_entries, directory_bytes, directory_offset, metadata_start) =
        if let Some(locator) = locator.as_deref() {
            if zip_u32(locator, 4)? != 0 || zip_u32(locator, 16)? != 1 {
                bail!("multi-disk ZIP64 files are unsupported");
            }
            let zip64_offset = zip_u64(locator, 8)?;
            let zip64 = read_zip_bytes(&mut input, zip64_offset, ZIP64_EOCD_MIN_BYTES)
                .context("reading ZIP64 end-of-central-directory record")?;
            if !zip64.starts_with(&ZIP64_EOCD_SIGNATURE) {
                bail!("ZIP64 end-of-central-directory record is missing");
            }
            let zip64_record_bytes = zip_u64(&zip64, 4)?;
            if zip64_record_bytes < 44 {
                bail!("ZIP64 end-of-central-directory record is malformed");
            }
            let zip64_record_end = zip64_offset
                .checked_add(12)
                .and_then(|offset| offset.checked_add(zip64_record_bytes))
                .ok_or_else(|| anyhow!("ZIP64 end-of-central-directory size overflow"))?;
            if zip64_record_end > locator_offset.expect("located ZIP64 locator has an offset") {
                bail!("ZIP64 end-of-central-directory record overlaps its locator");
            }
            if zip_u32(&zip64, 16)? != 0 || zip_u32(&zip64, 20)? != 0 {
                bail!("multi-disk ZIP64 files are unsupported");
            }
            (
                zip_u64(&zip64, 24)?,
                zip_u64(&zip64, 32)?,
                zip_u64(&zip64, 40)?,
                zip_u64(&zip64, 48)?,
                zip64_offset,
            )
        } else {
            if needs_zip64 {
                bail!("ZIP64 locator is missing");
            }
            if disk != 0 || directory_disk != 0 {
                bail!("multi-disk ZIP files are unsupported");
            }
            (
                u64::from(entries_on_disk),
                u64::from(total_entries),
                u64::from(directory_bytes),
                u64::from(directory_offset),
                eocd_absolute,
            )
        };

    if entries_on_disk != total_entries {
        bail!("multi-disk ZIP files are unsupported");
    }
    let maximum_entries = u64::try_from(max_entries).context("ZIP entry limit overflow")?;
    if total_entries == 0 || total_entries > maximum_entries {
        bail!(
            "ZIP declares {total_entries} entries, outside the supported range of 1 to {max_entries}"
        );
    }
    if directory_bytes > MAX_ZIP_CENTRAL_DIRECTORY_BYTES {
        bail!(
            "ZIP central directory declares {directory_bytes} bytes, exceeding the {}-byte limit",
            MAX_ZIP_CENTRAL_DIRECTORY_BYTES
        );
    }
    let directory_end = directory_offset
        .checked_add(directory_bytes)
        .ok_or_else(|| anyhow!("ZIP central directory range overflow"))?;
    if directory_end > metadata_start || directory_end > file_bytes {
        bail!("ZIP central directory points outside its declared metadata range");
    }
    let directory = read_zip_bytes(
        &mut input,
        directory_offset,
        usize::try_from(directory_bytes).context("ZIP central directory size overflow")?,
    )
    .context("reading ZIP central directory")?;
    if let Some(deadline) = deadline {
        deadline.check("ZIP metadata validation")?;
    }
    preflight_zip_central_directory(
        &directory,
        usize::try_from(total_entries).context("ZIP entry count overflow")?,
        deadline,
    )?;
    Ok(())
}

fn preflight_zip_central_directory(
    directory: &[u8],
    entries: usize,
    deadline: Option<BuildDeadline>,
) -> Result<()> {
    const CENTRAL_HEADER_BYTES: usize = 46;
    const CENTRAL_HEADER_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x01, 0x02];

    let minimum_bytes = entries
        .checked_mul(CENTRAL_HEADER_BYTES)
        .ok_or_else(|| anyhow!("ZIP central directory entry count overflow"))?;
    if minimum_bytes > directory.len() {
        bail!("ZIP central directory is too small for its declared entry count");
    }

    let mut cursor = 0_usize;
    for _ in 0..entries {
        if let Some(deadline) = deadline {
            deadline.check("ZIP metadata validation")?;
        }
        let header = directory
            .get(cursor..cursor.saturating_add(CENTRAL_HEADER_BYTES))
            .ok_or_else(|| anyhow!("ZIP central directory header exceeds its declared size"))?;
        if !header.starts_with(&CENTRAL_HEADER_SIGNATURE) {
            bail!("ZIP central directory contains an invalid file-header signature");
        }
        let variable_bytes = usize::from(zip_u16(header, 28)?)
            .checked_add(usize::from(zip_u16(header, 30)?))
            .and_then(|bytes| bytes.checked_add(usize::from(zip_u16(header, 32).ok()?)))
            .ok_or_else(|| anyhow!("ZIP central directory file-header size overflow"))?;
        cursor = cursor
            .checked_add(CENTRAL_HEADER_BYTES)
            .and_then(|offset| offset.checked_add(variable_bytes))
            .ok_or_else(|| anyhow!("ZIP central directory offset overflow"))?;
        if cursor > directory.len() {
            bail!("ZIP central directory file header exceeds its declared size");
        }
    }
    if cursor != directory.len() {
        bail!("ZIP central directory size is inconsistent with its file headers");
    }
    Ok(())
}

fn read_zip_bytes(input: &mut File, offset: u64, bytes: usize) -> io::Result<Vec<u8>> {
    input.seek(SeekFrom::Start(offset))?;
    let mut output = vec![0_u8; bytes];
    input.read_exact(&mut output)?;
    Ok(output)
}

fn zip_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let value = bytes
        .get(offset..offset.saturating_add(2))
        .ok_or_else(|| anyhow!("truncated ZIP metadata"))?;
    Ok(u16::from_le_bytes(
        value.try_into().expect("validated two-byte ZIP field"),
    ))
}

fn zip_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let value = bytes
        .get(offset..offset.saturating_add(4))
        .ok_or_else(|| anyhow!("truncated ZIP metadata"))?;
    Ok(u32::from_le_bytes(
        value.try_into().expect("validated four-byte ZIP field"),
    ))
}

fn zip_u64(bytes: &[u8], offset: usize) -> Result<u64> {
    let value = bytes
        .get(offset..offset.saturating_add(8))
        .ok_or_else(|| anyhow!("truncated ZIP metadata"))?;
    Ok(u64::from_le_bytes(
        value.try_into().expect("validated eight-byte ZIP field"),
    ))
}

fn clear_directory(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn remove_source_archive(session_path: &Path, format: Option<SourceFormat>) -> io::Result<()> {
    if let Some(format) = format {
        match fs::remove_file(session_path.join(format.stored_filename())) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            result => result?,
        }
        sync_directory(session_path)?;
    }
    Ok(())
}

fn remove_persisted_bundle(session_path: &Path) -> io::Result<()> {
    remove_file_and_sync(&session_path.join("design.nettle"), session_path)?;
    remove_file_and_sync(&session_path.join(".design.nettle.tmp"), session_path)
}

fn remove_file_and_sync(path: &Path, parent: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => sync_directory(parent),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn sweep_retention(state: &HostState) -> Result<()> {
    sweep_retention_root(&state.0.sessions_root, state.0.options.evict_after)
}

fn sweep_retention_root(sessions_root: &Path, evict_after: Option<Duration>) -> Result<()> {
    let Some(evict_after) = evict_after else {
        return Ok(());
    };
    let now = now_ms();
    let retention_ms = evict_after.as_millis().try_into().unwrap_or(u64::MAX);
    for entry in fs::read_dir(sessions_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = read_metadata(&path) else {
            continue;
        };
        if !matches!(metadata.state, SessionState::Ready | SessionState::Failed) {
            continue;
        }
        if metadata
            .completed_at_ms
            .map(|completed| completed.saturating_add(retention_ms))
            .is_some_and(|expires| expires <= now)
        {
            fs::remove_dir_all(path)?;
            sync_directory(sessions_root)?;
        }
    }
    Ok(())
}

async fn retention_worker(state: HostState) {
    loop {
        tokio::time::sleep(RETENTION_SWEEP_INTERVAL).await;
        if let Err(error) = sweep_retention(&state) {
            eprintln!("hosted retention sweep failed: {error:#}");
        }
    }
}

async fn build_worker(state: HostState) {
    loop {
        let notified = state.0.notify.notified();
        let token = {
            let mut queue = state.0.queue.lock().await;
            let token = queue.jobs.pop_front();
            if token.is_some() {
                release_source_queue_slot(&state);
            }
            token
        };
        let Some(token) = token else {
            notified.await;
            continue;
        };
        if let Err(error) = process_queued_build(&state, &token).await {
            eprintln!("hosted build failed without exposing session identifier: {error:#}");
            if requeue_incomplete_build(&state, &token).await {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

async fn requeue_incomplete_build(state: &HostState, token: &str) -> bool {
    let session_path = state.0.sessions_root.join(token);
    let metadata = match read_metadata(&session_path) {
        Ok(metadata) => metadata,
        Err(_) => {
            if !metadata_path(&session_path).exists() {
                return false;
            }
            let mut queue = state.0.queue.lock().await;
            if !queue.jobs.iter().any(|queued| queued == token) {
                retain_requeued_source_slot(state);
                queue.jobs.push_front(token.to_owned());
                state.0.notify.notify_one();
            }
            return true;
        }
    };
    if matches!(
        metadata.state,
        SessionState::Queued | SessionState::Building
    ) {
        let mut queue = state.0.queue.lock().await;
        if !queue.jobs.iter().any(|queued| queued == token) {
            retain_requeued_source_slot(state);
            queue.jobs.push_front(token.to_owned());
            state.0.notify.notify_one();
        }
        return true;
    }
    finish_terminal_artifact_cleanup(session_path, metadata).await;
    false
}

async fn process_queued_build(state: &HostState, token: &str) -> Result<()> {
    process_queued_build_with_metadata_writer(state, token, |session_path, metadata| {
        storage_retry(state, || write_metadata(session_path, metadata))
    })
    .await
}

async fn process_queued_build_with_metadata_writer(
    state: &HostState,
    token: &str,
    mut commit_metadata: impl FnMut(&Path, &SessionMetadata) -> io::Result<()>,
) -> Result<()> {
    let session_path = state.0.sessions_root.join(token);
    let mut metadata = read_metadata(&session_path)?;
    if !matches!(
        metadata.state,
        SessionState::Queued | SessionState::Building
    ) || metadata.kind != SessionKind::Sources
    {
        return Ok(());
    }
    metadata.state = SessionState::Building;
    metadata.build_started_at_ms = Some(now_ms());
    metadata.error = None;
    if let Err(error) = commit_metadata(&session_path, &metadata) {
        if error.raw_os_error() == Some(libc::ENOSPC) {
            fail_build_after_start_enospc(
                state,
                &session_path,
                &mut metadata,
                &mut commit_metadata,
            )
            .await;
            return Ok(());
        }
        return Err(error).context("committing hosted build start");
    }

    let scratch_path = state.0.options.scratch_root.join(token);
    let build_result = run_source_build(state, &session_path, &scratch_path, &metadata).await;
    let cleanup_result =
        remove_scratch_directory_with(&scratch_path, |path| fs::remove_dir_all(path)).await;
    let build_result = combine_build_and_cleanup_results(build_result, cleanup_result);

    metadata.completed_at_ms = Some(now_ms());
    match build_result {
        Ok(()) => {
            metadata.state = SessionState::Ready;
            metadata.error = None;
        }
        Err(error) => {
            metadata.state = SessionState::Failed;
            metadata.error = Some(bounded_error(&error));
        }
    }
    commit_terminal_metadata(state, &session_path, &metadata).await;
    Ok(())
}

async fn remove_scratch_directory_with(
    scratch_path: &Path,
    mut remove: impl FnMut(&Path) -> io::Result<()>,
) -> Result<()> {
    for attempt in 1..=SCRATCH_CLEANUP_ATTEMPTS {
        match remove(scratch_path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) if attempt == SCRATCH_CLEANUP_ATTEMPTS => {
                return Err(error).with_context(|| {
                    format!(
                        "removing build scratch directory {} after \
                         {SCRATCH_CLEANUP_ATTEMPTS} attempts",
                        scratch_path.display()
                    )
                });
            }
            Err(error) => {
                eprintln!(
                    "could not remove hosted build scratch directory \
                     (attempt {attempt}/{SCRATCH_CLEANUP_ATTEMPTS}); retrying: {error}"
                );
                tokio::time::sleep(SCRATCH_CLEANUP_RETRY_DELAY).await;
            }
        }
    }
    unreachable!("scratch cleanup loop always returns")
}

fn combine_build_and_cleanup_results(
    build_result: Result<()>,
    cleanup_result: Result<()>,
) -> Result<()> {
    match (build_result, cleanup_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(build_error), Ok(())) => Err(build_error),
        (Ok(()), Err(cleanup_error)) => Err(cleanup_error),
        (Err(build_error), Err(cleanup_error)) => Err(anyhow!(
            "{build_error:#}; additionally, scratch cleanup failed: {cleanup_error:#}"
        )),
    }
}

async fn fail_build_after_start_enospc(
    state: &HostState,
    session_path: &Path,
    metadata: &mut SessionMetadata,
    commit_metadata: &mut impl FnMut(&Path, &SessionMetadata) -> io::Result<()>,
) {
    cleanup_failed_artifacts_once(session_path, metadata.source_format);
    metadata.state = SessionState::Failed;
    metadata.build_started_at_ms = None;
    metadata.completed_at_ms = Some(now_ms());
    metadata.error =
        Some("Build could not start because the Nettle server is out of storage space.".to_owned());

    for attempt in 1..=ENOSPC_METADATA_COMMIT_ATTEMPTS {
        match commit_metadata(session_path, metadata) {
            Ok(()) => return,
            Err(error) => {
                eprintln!(
                    "could not commit storage-exhausted hosted build failure \
                     (attempt {attempt}/{ENOSPC_METADATA_COMMIT_ATTEMPTS}): {error}"
                );
                if attempt < ENOSPC_METADATA_COMMIT_ATTEMPTS {
                    tokio::task::yield_now().await;
                }
            }
        }
    }

    spawn_terminal_metadata_retry(state.clone(), session_path.to_owned(), metadata.clone());
}

fn cleanup_failed_artifacts_once(session_path: &Path, format: Option<SourceFormat>) {
    if let Err(error) = remove_source_archive(session_path, format) {
        eprintln!("could not remove storage-exhausted hosted source archive: {error}");
    }
    if let Err(error) = remove_persisted_bundle(session_path) {
        eprintln!("could not remove storage-exhausted hosted bundle output: {error}");
    }
}

async fn commit_terminal_metadata(
    state: &HostState,
    session_path: &Path,
    metadata: &SessionMetadata,
) {
    if !commit_terminal_metadata_with_writer(
        state,
        session_path,
        metadata,
        |session_path, metadata| storage_retry(state, || write_metadata(session_path, metadata)),
    )
    .await
    {
        spawn_terminal_metadata_retry(state.clone(), session_path.to_owned(), metadata.clone());
    }
}

async fn commit_terminal_metadata_with_writer(
    state: &HostState,
    session_path: &Path,
    metadata: &SessionMetadata,
    commit_metadata: impl FnMut(&Path, &SessionMetadata) -> io::Result<()>,
) -> bool {
    let outcome = commit_terminal_metadata_with_operations(
        state,
        session_path,
        metadata,
        commit_metadata,
        cleanup_terminal_artifacts_once,
    )
    .await;
    if outcome.cleanup_deferred {
        spawn_terminal_artifact_cleanup(session_path.to_owned(), metadata.clone());
    }
    outcome.committed
}

struct TerminalCommitOutcome {
    committed: bool,
    cleanup_deferred: bool,
}

async fn commit_terminal_metadata_with_operations(
    _state: &HostState,
    session_path: &Path,
    metadata: &SessionMetadata,
    mut commit_metadata: impl FnMut(&Path, &SessionMetadata) -> io::Result<()>,
    mut cleanup_artifacts: impl FnMut(&Path, &SessionMetadata) -> bool,
) -> TerminalCommitOutcome {
    let mut enospc_attempts = 0_usize;
    let mut other_attempts = 0_usize;
    loop {
        match commit_metadata(session_path, metadata) {
            Ok(()) => break,
            Err(error) if error.raw_os_error() == Some(libc::ENOSPC) => {
                cleanup_artifacts(session_path, metadata);
                enospc_attempts = enospc_attempts.saturating_add(1);
                if enospc_attempts >= ENOSPC_METADATA_COMMIT_ATTEMPTS {
                    return TerminalCommitOutcome {
                        committed: false,
                        cleanup_deferred: false,
                    };
                }
                tokio::task::yield_now().await;
            }
            Err(error) => {
                other_attempts = other_attempts.saturating_add(1);
                eprintln!(
                    "could not commit a terminal hosted build state \
                     (attempt {other_attempts}/{TERMINAL_METADATA_COMMIT_ATTEMPTS}): {error}"
                );
                if other_attempts >= TERMINAL_METADATA_COMMIT_ATTEMPTS {
                    return TerminalCommitOutcome {
                        committed: false,
                        cleanup_deferred: false,
                    };
                }
                tokio::time::sleep(TERMINAL_METADATA_RETRY_DELAY).await;
            }
        }
    }
    let cleaned =
        retry_terminal_artifact_cleanup_with(session_path, metadata, &mut cleanup_artifacts).await;
    TerminalCommitOutcome {
        committed: true,
        cleanup_deferred: !cleaned,
    }
}

async fn finish_terminal_artifact_cleanup(session_path: PathBuf, metadata: SessionMetadata) {
    let mut cleanup = cleanup_terminal_artifacts_once;
    if retry_terminal_artifact_cleanup_with(&session_path, &metadata, &mut cleanup).await {
        return;
    }
    eprintln!("terminal hosted artifact cleanup is continuing in the background");
    spawn_terminal_artifact_cleanup(session_path, metadata);
}

async fn retry_terminal_artifact_cleanup_with(
    session_path: &Path,
    metadata: &SessionMetadata,
    cleanup: &mut impl FnMut(&Path, &SessionMetadata) -> bool,
) -> bool {
    for attempt in 1..=TERMINAL_CLEANUP_ATTEMPTS {
        if cleanup(session_path, metadata) {
            return true;
        }
        if attempt < TERMINAL_CLEANUP_ATTEMPTS {
            tokio::time::sleep(TERMINAL_CLEANUP_RETRY_DELAY).await;
        }
    }
    false
}

fn spawn_terminal_artifact_cleanup(session_path: PathBuf, metadata: SessionMetadata) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        eprintln!("hosted terminal artifact cleanup deferred until the next server restart");
        return;
    };
    drop(runtime.spawn(async move {
        while !cleanup_terminal_artifacts_once(&session_path, &metadata) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }));
}

fn spawn_terminal_metadata_retry(
    state: HostState,
    session_path: PathBuf,
    metadata: SessionMetadata,
) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        eprintln!("hosted terminal metadata retry deferred until the next server restart");
        return;
    };
    drop(runtime.spawn(async move {
        loop {
            match storage_retry(&state, || write_metadata(&session_path, &metadata)) {
                Ok(()) => {
                    while !cleanup_terminal_artifacts_once(&session_path, &metadata) {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    return;
                }
                Err(error) => {
                    eprintln!("hosted terminal metadata retry is still pending: {error}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }));
}

fn cleanup_terminal_artifacts_once(session_path: &Path, metadata: &SessionMetadata) -> bool {
    match fs::metadata(session_path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
        Err(error) => {
            eprintln!("could not inspect hosted session before terminal cleanup: {error}");
            return false;
        }
    }
    let mut cleaned = true;
    if let Err(error) = remove_source_archive(session_path, metadata.source_format) {
        eprintln!("could not remove storage-exhausted hosted source archive: {error}");
        cleaned = false;
    }
    let output_cleanup = if metadata.state == SessionState::Failed {
        remove_persisted_bundle(session_path)
    } else {
        remove_file_and_sync(&session_path.join(".design.nettle.tmp"), session_path)
    };
    if let Err(error) = output_cleanup {
        eprintln!("could not remove storage-exhausted hosted bundle output: {error}");
        cleaned = false;
    }
    cleaned
}

async fn run_source_build(
    state: &HostState,
    session_path: &Path,
    scratch_path: &Path,
    metadata: &SessionMetadata,
) -> Result<()> {
    let deadline = BuildDeadline::new(state.0.options.build_timeout)?;
    deadline.check("scratch preparation")?;
    if scratch_path.exists() {
        fs::remove_dir_all(scratch_path)?;
    }
    fs::create_dir_all(scratch_path)?;
    let project_root = scratch_path.join("project");
    fs::create_dir(&project_root)?;
    let source_format = metadata
        .source_format
        .ok_or_else(|| anyhow!("source session has no archive format"))?;
    let archive_path = session_path.join(source_format.stored_filename());
    let extraction_archive = archive_path.clone();
    let extraction_root = project_root.clone();
    tokio::task::spawn_blocking(move || {
        extract_source_archive_with_deadline(
            &extraction_archive,
            &extraction_root,
            source_format,
            Some(deadline),
        )
    })
    .await
    .context("source extraction worker stopped")??;
    deadline.check("source extraction")?;

    let validation_root = project_root.clone();
    let filelist = project_root.join("project.f");
    tokio::task::spawn_blocking(move || {
        validate_project_paths_with_deadline(&validation_root, &filelist, Some(deadline))
    })
    .await
    .context("filelist validation worker stopped")??;
    deadline.check("filelist validation")?;

    let output_path = scratch_path.join("design.nettle");
    run_build_subprocess(
        &project_root,
        &output_path,
        scratch_path,
        deadline.remaining("compiler execution")?,
    )
    .await?;
    deadline.check("compiler execution")?;

    run_validate_subprocess(
        &output_path,
        deadline.remaining("generated-bundle validation")?,
    )
    .await?;
    deadline.check("generated-bundle validation")?;
    persist_bundle(state, &output_path, session_path, deadline)?;
    deadline.check("bundle persistence")?;
    Ok(())
}

fn bounded_error(error: &anyhow::Error) -> String {
    let mut message = format!("{error:#}");
    if message.len() > MAX_RETAINED_ERROR_BYTES {
        let mut boundary = MAX_RETAINED_ERROR_BYTES;
        while !message.is_char_boundary(boundary) {
            boundary -= 1;
        }
        message.truncate(boundary);
        message.push_str("\n[additional output omitted]");
    }
    message
}

fn persist_bundle(
    state: &HostState,
    source: &Path,
    session_path: &Path,
    deadline: BuildDeadline,
) -> Result<()> {
    deadline.check("bundle persistence")?;
    storage_retry(state, || {
        deadline.check_io("bundle persistence")?;
        persist_bundle_once(source, session_path, Some(deadline))
    })
    .context("persisting generated .nettle bundle")?;
    deadline.check("bundle persistence")
}

fn persist_bundle_once(
    source: &Path,
    session_path: &Path,
    deadline: Option<BuildDeadline>,
) -> io::Result<()> {
    let temporary = session_path.join(".design.nettle.tmp");
    let destination = session_path.join("design.nettle");
    let result = (|| {
        let mut input = File::open(source)?;
        let mut output = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)?;
        copy_with_deadline(
            &mut input,
            &mut output,
            u64::MAX,
            deadline,
            "bundle persistence",
        )?;
        if let Some(deadline) = deadline {
            deadline.check_io("bundle persistence")?;
        }
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, destination)?;
        sync_directory(session_path)?;
        if let Some(deadline) = deadline {
            deadline.check_io("bundle persistence")?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

async fn run_build_subprocess(
    project_root: &Path,
    output_path: &Path,
    scratch_path: &Path,
    timeout: Duration,
) -> Result<()> {
    let executable = env::current_exe().context("locating nettle executable")?;
    let home = scratch_path.join("home");
    let temporary = scratch_path.join("tmp");
    fs::create_dir_all(&home)?;
    fs::create_dir_all(&temporary)?;
    let mut command = Command::new(executable);
    command
        .arg("build")
        .arg("--filelist")
        .arg(project_root.join("project.f"))
        .arg("--project-root")
        .arg(project_root)
        .arg("--output")
        .arg(output_path)
        .current_dir(project_root)
        .env_clear()
        .env("HOME", &home)
        .env("TMPDIR", &temporary)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for name in ["PATH", "LD_LIBRARY_PATH", "YOSYS_DATDIR"] {
        if let Some(value) = env::var_os(name) {
            command.env(name, value);
        }
    }
    let (status, stdout, stderr) = run_bounded_command(command, timeout).await?;
    if !status.success() {
        bail!(
            "source build failed with {status}\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        );
    }
    Ok(())
}

async fn run_validate_subprocess(bundle_path: &Path, timeout: Duration) -> Result<()> {
    let executable = env::current_exe().context("locating nettle executable")?;
    let mut command = Command::new(executable);
    command
        .arg("validate")
        .arg(bundle_path)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let (status, stdout, stderr) = run_bounded_command(command, timeout).await?;
    if !status.success() {
        bail!(
            "generated .nettle validation failed with {status}\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        );
    }
    Ok(())
}

async fn run_bounded_command(
    mut command: Command,
    timeout: Duration,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>)> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn().context("starting isolated Nettle build")?;
    let process_id = child.id();
    let mut group_guard = ProcessGroupGuard::new(process_id);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("build stdout pipe is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("build stderr pipe is unavailable"))?;
    let mut stdout_task = tokio::spawn(read_bounded_output(stdout));
    let mut stderr_task = tokio::spawn(read_bounded_output(stderr));

    let started = tokio::time::Instant::now();
    let wait_result = tokio::time::timeout(timeout, child.wait()).await;
    let status = match wait_result {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            group_guard.kill();
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(error).context("waiting for Nettle build");
        }
        Err(_) => {
            group_guard.kill();
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            bail!(
                "source build exceeded the {}-second deadline",
                timeout.as_secs()
            );
        }
    };
    let remaining = timeout.saturating_sub(started.elapsed());
    let output_result = tokio::time::timeout(remaining, async {
        let stdout = (&mut stdout_task)
            .await
            .context("build stdout reader stopped")??;
        let stderr = (&mut stderr_task)
            .await
            .context("build stderr reader stopped")??;
        Ok::<_, anyhow::Error>((stdout, stderr))
    })
    .await;
    let (stdout, stderr) = match output_result {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            group_guard.kill();
            stdout_task.abort();
            stderr_task.abort();
            return Err(error);
        }
        Err(_) => {
            group_guard.kill();
            stdout_task.abort();
            stderr_task.abort();
            bail!(
                "source build exceeded the {}-second deadline while draining descendant output",
                timeout.as_secs()
            );
        }
    };
    group_guard.disarm();
    Ok((status, stdout, stderr))
}

async fn read_bounded_output(mut reader: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut retained = Vec::with_capacity(MAX_RETAINED_ERROR_BYTES);
    let mut omitted = 0_usize;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let keep = count.min(MAX_RETAINED_ERROR_BYTES.saturating_sub(retained.len()));
        retained.extend_from_slice(&buffer[..keep]);
        omitted = omitted.saturating_add(count - keep);
    }
    if omitted > 0 {
        retained
            .extend_from_slice(format!("\n[{omitted} additional output bytes omitted]").as_bytes());
    }
    Ok(retained)
}

fn copy_with_deadline(
    reader: &mut impl Read,
    writer: &mut impl Write,
    limit: u64,
    deadline: Option<BuildDeadline>,
    stage: &str,
) -> io::Result<u64> {
    let mut copied = 0_u64;
    let mut buffer = [0_u8; STREAM_CHUNK_BYTES];
    while copied < limit {
        if let Some(deadline) = deadline {
            deadline.check_io(stage)?;
        }
        let remaining = limit - copied;
        let requested = buffer
            .len()
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        let count = reader.read(&mut buffer[..requested])?;
        if count == 0 {
            break;
        }
        writer.write_all(&buffer[..count])?;
        copied = copied.saturating_add(u64::try_from(count).expect("read size fits u64"));
    }
    if let Some(deadline) = deadline {
        deadline.check_io(stage)?;
    }
    Ok(copied)
}

struct ProcessGroupGuard {
    process_id: Option<u32>,
}

impl ProcessGroupGuard {
    fn new(process_id: Option<u32>) -> Self {
        Self { process_id }
    }

    fn disarm(&mut self) {
        self.process_id = None;
    }

    fn kill(&mut self) {
        if let Some(process_id) = self.process_id.take() {
            kill_process_group(process_id);
        }
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(unix)]
fn kill_process_group(process_id: u32) {
    if let Ok(process_id) = i32::try_from(process_id) {
        // SAFETY: `kill` is called with a negated, checked child process ID and
        // a valid constant signal. Failure is intentionally best-effort here.
        unsafe {
            libc::kill(-process_id, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn kill_process_group(_process_id: u32) {}

#[cfg(test)]
fn extract_source_archive(
    archive_path: &Path,
    output_root: &Path,
    format: SourceFormat,
) -> Result<()> {
    extract_source_archive_with_deadline(archive_path, output_root, format, None)
}

fn extract_source_archive_with_deadline(
    archive_path: &Path,
    output_root: &Path,
    format: SourceFormat,
    deadline: Option<BuildDeadline>,
) -> Result<()> {
    if let Some(deadline) = deadline {
        deadline.check("source extraction")?;
    }
    match format {
        SourceFormat::Zip => extract_zip(archive_path, output_root, deadline)?,
        SourceFormat::Tar => {
            let input = File::open(archive_path)?;
            extract_tar(input, output_root, None, deadline)?;
        }
        SourceFormat::TarGz => {
            let compressed_bytes = fs::metadata(archive_path)?.len();
            let input = File::open(archive_path)?;
            extract_tar(
                GzDecoder::new(input),
                output_root,
                Some(compressed_bytes),
                deadline,
            )?;
        }
    }
    if let Some(deadline) = deadline {
        deadline.check("source extraction")?;
    }
    if !output_root.join("project.f").is_file() {
        bail!("source archive must contain project.f at its root");
    }
    Ok(())
}

fn extract_zip(
    archive_path: &Path,
    output_root: &Path,
    deadline: Option<BuildDeadline>,
) -> Result<()> {
    preflight_hosted_zip_with_deadline(archive_path, MAX_ARCHIVE_ENTRIES, deadline)?;
    let input = File::open(archive_path)?;
    let mut archive = ZipArchive::new(input).context("opening ZIP source archive")?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        bail!("source archive exceeds the {MAX_ARCHIVE_ENTRIES}-entry limit");
    }
    let mut paths = BTreeSet::new();
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        if let Some(deadline) = deadline {
            deadline.check("ZIP source extraction")?;
        }
        let mut entry = archive.by_index(index)?;
        let relative = safe_archive_path(Path::new(entry.name()))?;
        if !paths.insert(relative.clone()) {
            bail!(
                "source archive contains duplicate path {}",
                relative.display()
            );
        }
        let file_type_mask = mode_bits(libc::S_IFMT);
        let regular_type = mode_bits(libc::S_IFREG);
        let directory_type = mode_bits(libc::S_IFDIR);
        let mode_type = entry.unix_mode().map(|mode| mode & file_type_mask);
        let directory = entry.is_dir() || mode_type == Some(directory_type);
        if mode_type.is_some_and(|kind| kind != regular_type && kind != directory_type) {
            bail!(
                "source archive contains a link or special file at {}",
                relative.display()
            );
        }
        let destination = output_root.join(&relative);
        if directory {
            if entry.size() != 0 {
                bail!(
                    "archive directory {} must not contain a data body",
                    relative.display()
                );
            }
            fs::create_dir_all(&destination)?;
            continue;
        }
        validate_source_filename(&relative)?;
        let entry_size = entry.size();
        if entry_size > MAX_ARCHIVE_ENTRY_BYTES {
            bail!(
                "archive entry {} exceeds the {}-byte limit",
                relative.display(),
                MAX_ARCHIVE_ENTRY_BYTES
            );
        }
        if entry_size > 0
            && (entry.compressed_size() == 0
                || entry_size
                    > entry
                        .compressed_size()
                        .saturating_mul(MAX_ARCHIVE_COMPRESSION_RATIO))
        {
            bail!(
                "archive entry {} exceeds the compression-ratio limit",
                relative.display()
            );
        }
        expanded = expanded
            .checked_add(entry_size)
            .ok_or_else(|| anyhow!("source archive expanded size overflow"))?;
        if expanded > MAX_ARCHIVE_EXPANDED_BYTES {
            bail!(
                "source archive exceeds the {}-byte expanded-size limit",
                MAX_ARCHIVE_EXPANDED_BYTES
            );
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)?;
        let copied = copy_with_deadline(
            &mut entry,
            &mut output,
            entry_size.saturating_add(1),
            deadline,
            "ZIP source extraction",
        )?;
        if copied != entry_size {
            bail!(
                "archive entry {} size changed while extracting",
                relative.display()
            );
        }
    }
    Ok(())
}

#[derive(Default)]
struct PendingTarMetadata {
    path: Option<PathBuf>,
    size: Option<u64>,
    has_gnu_longname: bool,
    has_pax: bool,
}

#[derive(Default)]
struct PaxTarMetadata {
    path: Option<PathBuf>,
    size: Option<u64>,
}

fn add_tar_expanded_bytes(
    expanded: &mut u64,
    size: u64,
    compressed_bytes: Option<u64>,
) -> Result<()> {
    *expanded = expanded
        .checked_add(size)
        .ok_or_else(|| anyhow!("source archive expanded size overflow"))?;
    if *expanded > MAX_ARCHIVE_EXPANDED_BYTES {
        bail!(
            "source archive exceeds the {}-byte expanded-size limit",
            MAX_ARCHIVE_EXPANDED_BYTES
        );
    }
    if let Some(compressed_bytes) = compressed_bytes
        && *expanded > compressed_bytes.saturating_mul(MAX_ARCHIVE_COMPRESSION_RATIO)
    {
        bail!("source archive exceeds the compression-ratio limit");
    }
    Ok(())
}

fn read_bounded_tar_extension<R: Read>(
    entry: &mut tar::Entry<'_, R>,
    size: u64,
    limit: u64,
    description: &str,
    expanded: &mut u64,
    compressed_bytes: Option<u64>,
    deadline: Option<BuildDeadline>,
) -> Result<Vec<u8>> {
    if size > limit {
        bail!("{description} exceeds the {limit}-byte limit");
    }
    add_tar_expanded_bytes(expanded, size, compressed_bytes)?;
    if let Some(deadline) = deadline {
        deadline.check("TAR source extraction")?;
    }
    let size = usize::try_from(size).context("TAR extension size does not fit in memory")?;
    let mut body = vec![0_u8; size];
    entry
        .read_exact(&mut body)
        .with_context(|| format!("reading {description}"))?;
    if let Some(deadline) = deadline {
        deadline.check("TAR source extraction")?;
    }
    Ok(body)
}

fn parse_gnu_longname(body: &[u8]) -> Result<PathBuf> {
    let path = match body.strip_suffix(&[0]) {
        Some(path) => path,
        None => body,
    };
    if path.is_empty() || path.contains(&0) {
        bail!("GNU longname record contains an invalid path");
    }
    let path = std::str::from_utf8(path).context("GNU longname path is not UTF-8")?;
    safe_archive_path(Path::new(path))
}

fn parse_pax_decimal(value: &[u8], description: &str) -> Result<u64> {
    if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
        bail!("{description} is not an unsigned decimal integer");
    }
    value.iter().try_fold(0_u64, |parsed, digit| {
        parsed
            .checked_mul(10)
            .and_then(|parsed| parsed.checked_add(u64::from(digit - b'0')))
            .ok_or_else(|| anyhow!("{description} overflows an unsigned integer"))
    })
}

fn set_tar_metadata_path(slot: &mut Option<PathBuf>, path: PathBuf) -> Result<()> {
    if slot.as_ref().is_some_and(|existing| existing != &path) {
        bail!("TAR entry has conflicting path extension records");
    }
    *slot = Some(path);
    Ok(())
}

fn set_tar_metadata_size(slot: &mut Option<u64>, size: u64) -> Result<()> {
    if slot.is_some_and(|existing| existing != size) {
        bail!("TAR entry has conflicting size extension records");
    }
    *slot = Some(size);
    Ok(())
}

fn parse_pax_metadata(body: &[u8], local: bool) -> Result<PaxTarMetadata> {
    let mut metadata = PaxTarMetadata::default();
    let mut offset = 0_usize;
    while offset < body.len() {
        let length_digits = body[offset..]
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or_else(|| anyhow!("PAX extension has no record-length separator"))?;
        if length_digits == 0 {
            bail!("PAX extension has an empty record length");
        }
        let length_end = offset
            .checked_add(length_digits)
            .ok_or_else(|| anyhow!("PAX extension record offset overflow"))?;
        let record_length =
            body[offset..length_end]
                .iter()
                .try_fold(0_usize, |parsed, digit| {
                    if !digit.is_ascii_digit() {
                        return Err(anyhow!("PAX extension has a non-decimal record length"));
                    }
                    parsed
                        .checked_mul(10)
                        .and_then(|parsed| parsed.checked_add(usize::from(digit - b'0')))
                        .ok_or_else(|| anyhow!("PAX extension record length overflow"))
                })?;
        let record_end = offset
            .checked_add(record_length)
            .ok_or_else(|| anyhow!("PAX extension record length overflow"))?;
        let fields_start = length_end
            .checked_add(1)
            .ok_or_else(|| anyhow!("PAX extension record offset overflow"))?;
        if record_end > body.len()
            || record_end <= fields_start
            || body.get(record_end - 1) != Some(&b'\n')
        {
            bail!("PAX extension has a malformed record length");
        }
        let fields = &body[fields_start..record_end - 1];
        let equals = fields
            .iter()
            .position(|byte| *byte == b'=')
            .ok_or_else(|| anyhow!("PAX extension record has no key/value separator"))?;
        if equals == 0 {
            bail!("PAX extension record has an empty key");
        }
        let key =
            std::str::from_utf8(&fields[..equals]).context("PAX extension key is not UTF-8")?;
        let value = &fields[equals + 1..];
        match key {
            "path" if local => {
                if value.is_empty() || value.contains(&0) {
                    bail!("PAX path extension contains an invalid path");
                }
                let path = std::str::from_utf8(value).context("PAX path extension is not UTF-8")?;
                set_tar_metadata_path(&mut metadata.path, safe_archive_path(Path::new(path))?)?;
            }
            "size" if local => {
                let size = parse_pax_decimal(value, "PAX size extension")?;
                set_tar_metadata_size(&mut metadata.size, size)?;
            }
            "path" | "size" if !local => {
                bail!("global PAX path and size extensions are not supported");
            }
            "linkpath" => bail!("PAX link extensions are not supported"),
            key if key.starts_with("GNU.sparse.") => {
                bail!("PAX sparse-file extensions are not supported");
            }
            _ => {}
        }
        offset = record_end;
    }
    Ok(metadata)
}

fn extract_tar(
    reader: impl Read,
    output_root: &Path,
    compressed_bytes: Option<u64>,
    deadline: Option<BuildDeadline>,
) -> Result<()> {
    let mut archive = tar::Archive::new(reader);
    let mut paths = BTreeSet::new();
    let mut expanded = 0_u64;
    let mut entries = 0_usize;
    let mut pending = PendingTarMetadata::default();
    let raw_entries = archive
        .entries()
        .context("opening TAR source archive")?
        .raw(true);
    for entry in raw_entries {
        if let Some(deadline) = deadline {
            deadline.check("TAR source extraction")?;
        }
        let mut entry = entry.context("reading TAR source archive")?;
        entries = entries.saturating_add(1);
        if entries > MAX_ARCHIVE_ENTRIES {
            bail!("source archive exceeds the {MAX_ARCHIVE_ENTRIES}-entry limit");
        }
        let entry_type = entry.header().entry_type();
        let size = entry.header().size().context("reading TAR entry size")?;
        if entry_type.is_gnu_longname() {
            if pending.has_gnu_longname {
                bail!("two GNU longname records describe the same TAR entry");
            }
            let body = read_bounded_tar_extension(
                &mut entry,
                size,
                MAX_ARCHIVE_PATH_BYTES as u64 + 1,
                "GNU longname record",
                &mut expanded,
                compressed_bytes,
                deadline,
            )?;
            set_tar_metadata_path(&mut pending.path, parse_gnu_longname(&body)?)?;
            pending.has_gnu_longname = true;
            continue;
        }
        if entry_type.is_pax_local_extensions() {
            if pending.has_pax {
                bail!("two PAX extension records describe the same TAR entry");
            }
            let body = read_bounded_tar_extension(
                &mut entry,
                size,
                MAX_TAR_EXTENSION_BYTES,
                "PAX extension record",
                &mut expanded,
                compressed_bytes,
                deadline,
            )?;
            let metadata = parse_pax_metadata(&body, true)?;
            if let Some(path) = metadata.path {
                set_tar_metadata_path(&mut pending.path, path)?;
            }
            if let Some(size) = metadata.size {
                set_tar_metadata_size(&mut pending.size, size)?;
            }
            pending.has_pax = true;
            continue;
        }
        if entry_type.is_pax_global_extensions() {
            let body = read_bounded_tar_extension(
                &mut entry,
                size,
                MAX_TAR_EXTENSION_BYTES,
                "global PAX extension record",
                &mut expanded,
                compressed_bytes,
                deadline,
            )?;
            parse_pax_metadata(&body, false)?;
            continue;
        }
        if entry_type.is_gnu_longlink() {
            bail!("GNU long-link records are not supported");
        }

        let metadata = std::mem::take(&mut pending);
        if metadata.size.is_some_and(|pax_size| pax_size != size) {
            bail!("PAX size extension does not match the TAR entry header");
        }
        let relative = match metadata.path {
            Some(path) => path,
            None => safe_archive_path(&entry.path().context("reading TAR entry path")?)?,
        };
        if !paths.insert(relative.clone()) {
            bail!(
                "source archive contains duplicate path {}",
                relative.display()
            );
        }
        let destination = output_root.join(&relative);
        if entry_type.is_dir() {
            if size != 0 {
                bail!(
                    "archive directory {} must not contain a data body",
                    relative.display()
                );
            }
            fs::create_dir_all(&destination)?;
            continue;
        }
        if !entry_type.is_file() {
            bail!(
                "source archive contains a link or special file at {}",
                relative.display()
            );
        }
        validate_source_filename(&relative)?;
        if size > MAX_ARCHIVE_ENTRY_BYTES {
            bail!(
                "archive entry {} exceeds the {}-byte limit",
                relative.display(),
                MAX_ARCHIVE_ENTRY_BYTES
            );
        }
        add_tar_expanded_bytes(&mut expanded, size, compressed_bytes)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)?;
        let copied = copy_with_deadline(
            &mut entry,
            &mut output,
            size.saturating_add(1),
            deadline,
            "TAR source extraction",
        )?;
        if copied != size {
            bail!(
                "archive entry {} size changed while extracting",
                relative.display()
            );
        }
    }
    if pending.has_gnu_longname || pending.has_pax {
        bail!("TAR extension record is not followed by a file entry");
    }
    if let Some(deadline) = deadline {
        deadline.check("TAR source extraction")?;
    }
    Ok(())
}

fn safe_archive_path(path: &Path) -> Result<PathBuf> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.as_os_str().to_string_lossy().contains('\\')
    {
        bail!("source archive contains an unsafe path");
    }
    if path.as_os_str().as_encoded_bytes().len() > MAX_ARCHIVE_PATH_BYTES {
        bail!("source archive path exceeds the supported length");
    }
    let mut safe = PathBuf::new();
    let mut components = 0_usize;
    for component in path.components() {
        let Component::Normal(part) = component else {
            bail!("source archive contains path traversal");
        };
        if part.is_empty() {
            bail!("source archive contains an empty path component");
        }
        components = components.saturating_add(1);
        if components > MAX_ARCHIVE_PATH_COMPONENTS {
            bail!("source archive path has too many components");
        }
        safe.push(part);
    }
    if components == 0 {
        bail!("source archive contains an empty path");
    }
    Ok(safe)
}

fn mode_bits<T: Into<u32>>(bits: T) -> u32 {
    bits.into()
}

fn validate_source_filename(path: &Path) -> Result<()> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("v" | "sv" | "svh" | "vh" | "f")) {
        bail!(
            "source archive contains unsupported file {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
fn validate_project_paths(root: &Path, root_filelist: &Path) -> Result<()> {
    validate_project_paths_with_deadline(root, root_filelist, None)
}

fn validate_project_paths_with_deadline(
    root: &Path,
    root_filelist: &Path,
    deadline: Option<BuildDeadline>,
) -> Result<()> {
    if let Some(deadline) = deadline {
        deadline.check("filelist validation")?;
    }
    let canonical_root = fs::canonicalize(root).context("canonicalizing extracted project root")?;
    let canonical_filelist =
        fs::canonicalize(root_filelist).context("locating archive-root project.f")?;
    require_regular_within(&canonical_root, &canonical_filelist, "root filelist")?;
    let project = normalize_filelist_within_root_cancellable(
        &canonical_filelist,
        None,
        &canonical_root,
        || deadline.map_or(Ok(()), |deadline| deadline.check_io("filelist validation")),
    )
    .context("normalizing uploaded project.f")?;
    if let Some(deadline) = deadline {
        deadline.check("filelist validation")?;
    }
    if project.top.as_deref().is_none_or(str::is_empty) {
        bail!("project.f must declare the top module with --top");
    }

    for argument in &project.arguments {
        if let Some(deadline) = deadline {
            deadline.check("filelist validation")?;
        }
        let expected_directory = matches!(
            argument.kind,
            NormalizedArgumentKind::IncludeDirectory | NormalizedArgumentKind::LibraryDirectory
        );
        if matches!(
            argument.kind,
            NormalizedArgumentKind::Source
                | NormalizedArgumentKind::IncludeDirectory
                | NormalizedArgumentKind::LibraryDirectory
                | NormalizedArgumentKind::LibraryFile
                | NormalizedArgumentKind::NestedFilelist
        ) {
            let path = fs::canonicalize(&argument.value).with_context(|| {
                format!(
                    "locating path declared at {}:{}:{}",
                    argument.origin.file, argument.origin.line, argument.origin.column
                )
            })?;
            require_within(&canonical_root, &path, "declared project path")?;
            let metadata = fs::metadata(&path)?;
            if (expected_directory && !metadata.is_dir())
                || (!expected_directory && !metadata.is_file())
            {
                bail!("declared project path has the wrong file type");
            }
        }
        if argument.origin.file != "<command-line>" {
            let origin =
                fs::canonicalize(&argument.origin.file).context("locating declaring filelist")?;
            require_regular_within(&canonical_root, &origin, "declaring filelist")?;
        }
    }
    if let Some(deadline) = deadline {
        deadline.check("filelist validation")?;
    }
    Ok(())
}

fn require_regular_within(root: &Path, path: &Path, description: &str) -> Result<()> {
    require_within(root, path, description)?;
    if !fs::metadata(path)?.is_file() {
        bail!("{description} is not a regular file");
    }
    Ok(())
}

fn require_within(root: &Path, path: &Path, description: &str) -> Result<()> {
    if !path.starts_with(root) {
        bail!("{description} escapes the uploaded project root");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::io::Cursor;
    use std::net::{IpAddr, Ipv4Addr};

    use axum::body::to_bytes;
    use axum::http::Request;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use tower::ServiceExt;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use crate::bundle::{BuildMetadata, BundleContents, write_bundle};
    use crate::ir::{DesignSnapshot, GraphModule, GraphSlice};

    use super::*;

    struct TestHost {
        _root: tempfile::TempDir,
        _web: tempfile::TempDir,
        _scratch: tempfile::TempDir,
        state: HostState,
    }

    fn test_host(max_queued_builds: usize) -> TestHost {
        let root = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        fs::write(web.path().join("index.html"), "<h1>Nettle</h1>").unwrap();
        let state = initialize_state(HostOptions {
            web_root: web.path().to_owned(),
            bind_address: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            storage_root: root.path().to_owned(),
            scratch_root: scratch.path().to_owned(),
            max_queued_builds,
            build_timeout: Duration::from_secs(10),
            evict_after: Some(Duration::from_secs(60)),
            max_upload_bytes: 1024 * 1024,
        })
        .unwrap();
        TestHost {
            _root: root,
            _web: web,
            _scratch: scratch,
            state,
        }
    }

    #[tokio::test]
    async fn scratch_cleanup_retries_transient_failures() {
        let mut attempts = 0_usize;
        remove_scratch_directory_with(Path::new("unused"), |_| {
            attempts = attempts.saturating_add(1);
            if attempts < SCRATCH_CLEANUP_ATTEMPTS {
                Err(io::Error::from_raw_os_error(libc::EIO))
            } else {
                Ok(())
            }
        })
        .await
        .unwrap();

        assert_eq!(attempts, SCRATCH_CLEANUP_ATTEMPTS);
    }

    #[tokio::test]
    async fn scratch_cleanup_surfaces_persistent_failures() {
        let mut attempts = 0_usize;
        let error = remove_scratch_directory_with(Path::new("unused"), |_| {
            attempts = attempts.saturating_add(1);
            Err(io::Error::from_raw_os_error(libc::EIO))
        })
        .await
        .unwrap_err();

        assert_eq!(attempts, SCRATCH_CLEANUP_ATTEMPTS);
        assert!(
            error
                .to_string()
                .contains("removing build scratch directory"),
            "{error:#}"
        );
    }

    fn test_bundle(path: &Path) {
        let snapshot_id = "host-test";
        let slice = GraphSlice {
            snapshot_id: snapshot_id.to_owned(),
            module: GraphModule {
                id: "top-module".to_owned(),
                name: "top".to_owned(),
                instance_path: "top".to_owned(),
                definition_name: "top".to_owned(),
                parameters: BTreeMap::new(),
                attributes: BTreeMap::new(),
            },
            nodes: vec![],
            edges: vec![],
            groups: vec![],
            files: None,
            elaboration_ranges: vec![],
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

    fn multipart(kind: &str, filename: &str, contents: &[u8]) -> (String, Vec<u8>) {
        let boundary = "nettle-test-boundary";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\n{kind}\r\n\
             --{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(contents);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        (format!("multipart/form-data; boundary={boundary}"), body)
    }

    fn multipart_file_first(kind: &str, filename: &str, contents: &[u8]) -> (String, Vec<u8>) {
        let boundary = "nettle-test-boundary";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(contents);
        body.extend_from_slice(
            format!(
                "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\n{kind}\r\n\
                 --{boundary}--\r\n"
            )
            .as_bytes(),
        );
        (format!("multipart/form-data; boundary={boundary}"), body)
    }

    fn source_zip() -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut archive = ZipWriter::new(&mut bytes);
            let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
            archive.start_file("project.f", options).unwrap();
            archive
                .write_all("--top top\nrtl/top.sv\n".as_bytes())
                .unwrap();
            archive.start_file("rtl/top.sv", options).unwrap();
            archive
                .write_all("module top; endmodule\n".as_bytes())
                .unwrap();
            archive.finish().unwrap();
        }
        bytes.into_inner()
    }

    fn test_options(host: &TestHost) -> HostOptions {
        HostOptions {
            web_root: host._web.path().to_owned(),
            bind_address: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            storage_root: host._root.path().to_owned(),
            scratch_root: host._scratch.path().to_owned(),
            max_queued_builds: 32,
            build_timeout: Duration::from_secs(10),
            evict_after: Some(Duration::from_secs(60)),
            max_upload_bytes: 1024 * 1024,
        }
    }

    fn test_source_metadata(token: &str, state: SessionState, queue_order: u64) -> SessionMetadata {
        SessionMetadata {
            schema_version: HOST_SCHEMA_VERSION,
            token: token.to_owned(),
            kind: SessionKind::Sources,
            state,
            original_name: "sources.zip".to_owned(),
            upload_bytes: 1,
            admitted_at_ms: 1,
            queue_order,
            build_started_at_ms: (state == SessionState::Building).then_some(2),
            completed_at_ms: matches!(state, SessionState::Ready | SessionState::Failed)
                .then_some(now_ms()),
            interruptions: 0,
            source_format: Some(SourceFormat::Zip),
            error: None,
        }
    }

    fn write_test_session(state: &HostState, metadata: &SessionMetadata) -> PathBuf {
        let session_path = state.0.sessions_root.join(&metadata.token);
        fs::create_dir(&session_path).unwrap();
        write_metadata(&session_path, metadata).unwrap();
        session_path
    }

    fn zip_bytes(build: impl FnOnce(&mut ZipWriter<&mut Cursor<Vec<u8>>>)) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut archive = ZipWriter::new(&mut bytes);
            build(&mut archive);
            archive.finish().unwrap();
        }
        bytes.into_inner()
    }

    fn append_tar_file<W: Write>(archive: &mut tar::Builder<W>, path: &str, contents: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_path(path).unwrap();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(0o644);
        header.set_size(u64::try_from(contents.len()).unwrap());
        header.set_cksum();
        archive.append(&header, Cursor::new(contents)).unwrap();
    }

    fn pax_record(key: &str, value: &[u8]) -> Vec<u8> {
        let rest_length = 3 + key.len() + value.len();
        let mut length_digits = 1;
        loop {
            let record_length = rest_length + length_digits;
            if record_length.to_string().len() == length_digits {
                let mut record = format!("{record_length} {key}=").into_bytes();
                record.extend_from_slice(value);
                record.push(b'\n');
                return record;
            }
            length_digits += 1;
        }
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn classic_zip_eocd(entries: u16, central_directory_bytes: u32) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(ZIP_EOCD_BYTES);
        bytes.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06]);
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&entries.to_le_bytes());
        bytes.extend_from_slice(&entries.to_le_bytes());
        bytes.extend_from_slice(&central_directory_bytes.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes
    }

    fn zip64_eocd(entries: u64, central_directory_bytes: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0x50, 0x4b, 0x06, 0x06]);
        bytes.extend_from_slice(&44_u64.to_le_bytes());
        bytes.extend_from_slice(&45_u16.to_le_bytes());
        bytes.extend_from_slice(&45_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&entries.to_le_bytes());
        bytes.extend_from_slice(&entries.to_le_bytes());
        bytes.extend_from_slice(&central_directory_bytes.to_le_bytes());
        bytes.extend_from_slice(&0_u64.to_le_bytes());
        bytes.extend_from_slice(&[0x50, 0x4b, 0x06, 0x07]);
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u64.to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06]);
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&u16::MAX.to_le_bytes());
        bytes.extend_from_slice(&u16::MAX.to_le_bytes());
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes
    }

    #[tokio::test]
    async fn config_and_capability_routes_have_security_headers() {
        let host = test_host(2);
        let router = host_router(host.state).unwrap();
        let config = router
            .clone()
            .oneshot(Request::get("/api/v1/config").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(config.status(), StatusCode::OK);
        assert_eq!(config.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(config.headers()[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(config.headers()["x-robots-tag"], "noindex");

        let session_page = router
            .clone()
            .oneshot(
                Request::get("/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(session_page.status(), StatusCode::OK);

        let (content_type, body) = multipart("sources", "project.zip", &source_zip());
        let cross_origin_style_upload = router
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header(header::CONTENT_TYPE, content_type)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cross_origin_style_upload.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn prebuilt_upload_is_validated_persisted_and_downloadable() {
        let host = test_host(2);
        let input = host._root.path().join("input.nettle");
        test_bundle(&input);
        let bytes = fs::read(input).unwrap();
        let (content_type, body) = multipart("bundle", "design.nettle", &bytes);
        let router = host_router(host.state.clone()).unwrap();
        let response = router
            .clone()
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header(header::CONTENT_TYPE, content_type)
                    .header("x-nettle-upload", "1")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let response_body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let created: serde_json::Value = serde_json::from_slice(&response_body).unwrap();
        let token = created["token"].as_str().unwrap();
        assert!(validate_token(token));

        let status = router
            .clone()
            .oneshot(
                Request::get(format!("/api/v1/sessions/{token}/status"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(status.status(), StatusCode::OK);
        let status_body = to_bytes(status.into_body(), usize::MAX).await.unwrap();
        let status_json: serde_json::Value = serde_json::from_slice(&status_body).unwrap();
        assert_eq!(status_json["state"], "ready");
        assert!(status_json["expiresAtMs"].is_u64());

        let download = router
            .oneshot(
                Request::get(format!("/api/v1/sessions/{token}/download"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(download.status(), StatusCode::OK);
        assert_eq!(
            download.headers()[header::CONTENT_DISPOSITION],
            "attachment; filename=\"design.nettle\""
        );
        assert_eq!(
            to_bytes(download.into_body(), usize::MAX)
                .await
                .unwrap()
                .as_ref(),
            bytes
        );
    }

    #[tokio::test]
    async fn invalid_prebuilt_is_rejected_without_creating_a_session() {
        let host = test_host(2);
        let (content_type, body) = multipart("bundle", "invalid.nettle", b"not a Nettle bundle");
        let response = host_router(host.state.clone())
            .unwrap()
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header(header::CONTENT_TYPE, content_type)
                    .header("x-nettle-upload", "1")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let response_body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let error: serde_json::Value = serde_json::from_slice(&response_body).unwrap();
        assert!(
            error["error"]
                .as_str()
                .unwrap()
                .starts_with("Invalid .nettle bundle:")
        );
        assert_eq!(
            fs::read_dir(&host.state.0.sessions_root).unwrap().count(),
            0
        );
        assert_eq!(fs::read_dir(&host.state.0.staging_root).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn source_uploads_enter_a_bounded_fifo() {
        let host = test_host(1);
        let router = host_router(host.state.clone()).unwrap();
        let zip = source_zip();
        let (content_type, body) = multipart("sources", "project.zip", &zip);
        let accepted = router
            .clone()
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header(header::CONTENT_TYPE, content_type)
                    .header("x-nettle-upload", "1")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);
        let accepted_body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
        let accepted_json: serde_json::Value = serde_json::from_slice(&accepted_body).unwrap();
        let token = accepted_json["token"].as_str().unwrap();
        let status = router
            .clone()
            .oneshot(
                Request::get(format!("/api/v1/sessions/{token}/status"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status_body = to_bytes(status.into_body(), usize::MAX).await.unwrap();
        let status_json: serde_json::Value = serde_json::from_slice(&status_body).unwrap();
        assert_eq!(status_json["queuePosition"], 1);

        let (content_type, body) = multipart("sources", "another.zip", &zip);
        let rejected = router
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header(header::CONTENT_TYPE, content_type)
                    .header("x-nettle-upload", "1")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(host.state.0.source_queue_slots.load(Ordering::Acquire), 1);
        assert_eq!(fs::read_dir(&host.state.0.staging_root).unwrap().count(), 0);
    }

    #[test]
    fn in_progress_source_uploads_reserve_queue_capacity() {
        let host = test_host(1);
        let first = try_reserve_source_queue_slot(&host.state).unwrap();
        let error = match try_reserve_source_queue_slot(&host.state) {
            Ok(_) => panic!("a concurrent source upload exceeded the queue limit"),
            Err(error) => error,
        };
        assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);

        drop(first);
        assert!(try_reserve_source_queue_slot(&host.state).is_ok());
    }

    #[tokio::test]
    async fn failed_source_upload_releases_its_queue_reservation() {
        let host = test_host(1);
        let router = host_router(host.state.clone()).unwrap();
        let (content_type, body) = multipart("sources", "project.txt", b"not an archive");
        let rejected = router
            .clone()
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header(header::CONTENT_TYPE, content_type)
                    .header("x-nettle-upload", "1")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(host.state.0.source_queue_slots.load(Ordering::Acquire), 0);

        let (content_type, body) = multipart("sources", "project.zip", &source_zip());
        let accepted = router
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header(header::CONTENT_TYPE, content_type)
                    .header("x-nettle-upload", "1")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn upload_kind_must_precede_file_streaming() {
        let host = test_host(1);
        let (content_type, body) = multipart_file_first("sources", "project.zip", &source_zip());
        let response = host_router(host.state.clone())
            .unwrap()
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header(header::CONTENT_TYPE, content_type)
                    .header("x-nettle-upload", "1")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response_body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let error: serde_json::Value = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(error["error"], "Upload kind must precede the file field.");
        assert_eq!(host.state.0.source_queue_slots.load(Ordering::Acquire), 0);
        assert_eq!(fs::read_dir(&host.state.0.staging_root).unwrap().count(), 0);
    }

    #[test]
    fn source_zip_preflight_rejects_declared_entry_count_before_full_parsing() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("too-many.zip");
        let declared_entries = u16::try_from(MAX_ARCHIVE_ENTRIES + 1).unwrap();
        fs::write(&archive_path, classic_zip_eocd(declared_entries, 0)).unwrap();
        let output = directory.path().join("output");
        fs::create_dir(&output).unwrap();

        let error = extract_zip(&archive_path, &output, None).unwrap_err();
        assert!(
            error.to_string().contains(&format!(
                "ZIP declares {declared_entries} entries, outside the supported range"
            )),
            "{error:#}"
        );
        assert!(fs::read_dir(output).unwrap().next().is_none());
    }

    #[test]
    fn prebuilt_zip_preflight_rejects_large_central_directory_before_full_parsing() {
        let directory = tempfile::tempdir().unwrap();
        let bundle_path = directory.path().join("large-directory.nettle");
        let declared_bytes = u32::try_from(MAX_ZIP_CENTRAL_DIRECTORY_BYTES + 1).unwrap();
        fs::write(&bundle_path, classic_zip_eocd(1, declared_bytes)).unwrap();

        let error = validate_bundle(&bundle_path).unwrap_err();
        assert!(
            error.to_string().contains(&format!(
                "ZIP central directory declares {declared_bytes} bytes, exceeding"
            )),
            "{error:#}"
        );
    }

    #[test]
    fn zip_preflight_does_not_parse_past_a_forged_small_central_directory() {
        let mut central_header = vec![0_u8; 46];
        central_header[..4].copy_from_slice(&[0x50, 0x4b, 0x01, 0x02]);
        let mut archive = central_header.clone();
        archive.extend_from_slice(&central_header);
        archive.extend_from_slice(&classic_zip_eocd(2, 46));

        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("forged-small-directory.zip");
        fs::write(&archive_path, archive).unwrap();

        let error = preflight_hosted_zip(&archive_path, MAX_ARCHIVE_ENTRIES).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("central directory is too small for its declared entry count"),
            "{error:#}"
        );
    }

    #[test]
    fn prebuilt_zip64_preflight_rejects_declared_entry_count_before_full_parsing() {
        let directory = tempfile::tempdir().unwrap();
        let bundle_path = directory.path().join("too-many-zip64.nettle");
        let declared_entries = u64::try_from(MAX_BUNDLE_ENTRY_COUNT).unwrap() + 1;
        fs::write(&bundle_path, zip64_eocd(declared_entries, 0)).unwrap();

        let error = validate_bundle(&bundle_path).unwrap_err();
        assert!(
            error.to_string().contains(&format!(
                "ZIP declares {declared_entries} entries, outside the supported range"
            )),
            "{error:#}"
        );
    }

    #[test]
    fn archive_extraction_rejects_traversal_and_accepts_expected_sources() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("sources.zip");
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut archive = ZipWriter::new(&mut bytes);
            archive
                .start_file("../escape.sv", FileOptions::default())
                .unwrap();
            archive.write_all(b"module escape; endmodule\n").unwrap();
            archive.finish().unwrap();
        }
        fs::write(&archive_path, bytes.into_inner()).unwrap();
        let output = directory.path().join("output");
        fs::create_dir(&output).unwrap();
        let error = extract_source_archive(&archive_path, &output, SourceFormat::Zip).unwrap_err();
        assert!(error.to_string().contains("path traversal"));
        assert!(!directory.path().join("escape.sv").exists());

        let archive_path = directory.path().join("valid.zip");
        fs::write(&archive_path, source_zip()).unwrap();
        let output = directory.path().join("valid-output");
        fs::create_dir(&output).unwrap();
        extract_source_archive(&archive_path, &output, SourceFormat::Zip).unwrap();
        validate_project_paths(&output, &output.join("project.f")).unwrap();
    }

    #[test]
    fn archive_extraction_rejects_duplicate_link_and_unsupported_entries() {
        let duplicate = zip_bytes(|archive| {
            archive
                .start_file("project.f", FileOptions::default())
                .unwrap();
            archive.write_all(b"--top top\n").unwrap();
            archive
                .start_file("project.f", FileOptions::default())
                .unwrap();
            archive.write_all(b"--top other\n").unwrap();
        });
        let link = zip_bytes(|archive| {
            archive
                .start_file("project.f", FileOptions::default())
                .unwrap();
            archive.write_all(b"--top top\nrtl/top.sv\n").unwrap();
            archive
                .add_symlink("rtl/top.sv", "../outside.sv", FileOptions::default())
                .unwrap();
        });
        let unsupported = zip_bytes(|archive| {
            archive
                .start_file("project.f", FileOptions::default())
                .unwrap();
            archive.write_all(b"--top top\n").unwrap();
            archive
                .start_file("notes.txt", FileOptions::default())
                .unwrap();
            archive.write_all(b"not RTL").unwrap();
        });

        let directory = tempfile::tempdir().unwrap();
        for (name, bytes, expected) in [
            ("duplicate", duplicate, "duplicate path project.f"),
            ("link", link, "link or special file at rtl/top.sv"),
            ("unsupported", unsupported, "unsupported file notes.txt"),
        ] {
            let archive_path = directory.path().join(format!("{name}.zip"));
            fs::write(&archive_path, bytes).unwrap();
            let output = directory.path().join(format!("{name}-output"));
            fs::create_dir(&output).unwrap();
            let error =
                extract_source_archive(&archive_path, &output, SourceFormat::Zip).unwrap_err();
            assert!(
                error.to_string().contains(expected),
                "{name}: expected {expected:?}, got {error:#}"
            );
        }
    }

    #[test]
    fn tar_gz_extraction_rejects_a_directory_with_a_data_body() {
        let mut tar_bytes = Vec::new();
        {
            let mut archive = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_path("rtl/").unwrap();
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_size(4);
            header.set_cksum();
            archive
                .append(&header, Cursor::new(b"data".as_slice()))
                .unwrap();
            archive.finish().unwrap();
        }
        let compressed = gzip(&tar_bytes);

        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("malicious.tar.gz");
        fs::write(&archive_path, compressed).unwrap();
        let output = directory.path().join("output");
        fs::create_dir(&output).unwrap();

        let error =
            extract_source_archive(&archive_path, &output, SourceFormat::TarGz).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("archive directory rtl must not contain a data body"),
            "{error:#}"
        );
        assert!(!output.join("rtl").exists());
    }

    #[test]
    fn tar_gz_extraction_enforces_the_compression_ratio_limit() {
        let mut tar_bytes = Vec::new();
        {
            let mut archive = tar::Builder::new(&mut tar_bytes);
            append_tar_file(&mut archive, "project.f", b"--top top\nrtl/top.sv\n");
            append_tar_file(&mut archive, "rtl/top.sv", &vec![b' '; 2 * 1024 * 1024]);
            archive.finish().unwrap();
        }
        let compressed = gzip(&tar_bytes);
        assert!(
            u64::try_from(tar_bytes.len()).unwrap()
                > u64::try_from(compressed.len())
                    .unwrap()
                    .saturating_mul(MAX_ARCHIVE_COMPRESSION_RATIO)
        );

        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("compression-bomb.tar.gz");
        fs::write(&archive_path, compressed).unwrap();
        let output = directory.path().join("output");
        fs::create_dir(&output).unwrap();

        let error =
            extract_source_archive(&archive_path, &output, SourceFormat::TarGz).unwrap_err();
        assert!(
            error.to_string().contains("compression-ratio limit"),
            "{error:#}"
        );
        assert!(!output.join("rtl/top.sv").exists());
    }

    #[test]
    fn expired_build_deadline_stops_archive_extraction() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("sources.zip");
        fs::write(&archive_path, source_zip()).unwrap();
        let output = directory.path().join("output");
        fs::create_dir(&output).unwrap();
        let deadline = BuildDeadline::new(Duration::ZERO).unwrap();

        let error = extract_source_archive_with_deadline(
            &archive_path,
            &output,
            SourceFormat::Zip,
            Some(deadline),
        )
        .unwrap_err();
        assert!(error.to_string().contains("deadline"), "{error:#}");
        assert!(fs::read_dir(output).unwrap().next().is_none());
    }

    #[test]
    fn tar_gz_extraction_accepts_bounded_local_pax_metadata() {
        let mut tar_bytes = Vec::new();
        {
            let mut archive = tar::Builder::new(&mut tar_bytes);
            let pax_body = pax_record("mtime", b"1752796800.123456789");
            let mut pax_header = tar::Header::new_ustar();
            pax_header.set_path("PaxHeader/project.f").unwrap();
            pax_header.set_entry_type(tar::EntryType::XHeader);
            pax_header.set_mode(0o644);
            pax_header.set_size(u64::try_from(pax_body.len()).unwrap());
            pax_header.set_cksum();
            archive.append(&pax_header, Cursor::new(pax_body)).unwrap();
            append_tar_file(&mut archive, "project.f", b"--top top\nrtl/top.sv\n");
            append_tar_file(&mut archive, "rtl/top.sv", b"module top; endmodule\n");
            archive.finish().unwrap();
        }

        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("macos-style.tar.gz");
        fs::write(&archive_path, gzip(&tar_bytes)).unwrap();
        let output = directory.path().join("output");
        fs::create_dir(&output).unwrap();

        extract_source_archive(&archive_path, &output, SourceFormat::TarGz).unwrap();
        validate_project_paths(&output, &output.join("project.f")).unwrap();
        assert_eq!(
            fs::read_to_string(output.join("rtl/top.sv")).unwrap(),
            "module top; endmodule\n"
        );
        assert!(!output.join("PaxHeader").exists());
    }

    #[test]
    fn tar_gz_extraction_accepts_a_bounded_gnu_longname() {
        let long_path = format!("rtl/{}.sv", "long-name-segment-".repeat(10));
        assert!(long_path.len() > 100);
        assert!(long_path.len() <= MAX_ARCHIVE_PATH_BYTES);
        let project_filelist = format!("--top top\n{long_path}\n");

        let mut tar_bytes = Vec::new();
        {
            let mut archive = tar::Builder::new(&mut tar_bytes);
            append_tar_file(&mut archive, "project.f", project_filelist.as_bytes());

            let mut longname_body = long_path.as_bytes().to_vec();
            longname_body.push(0);
            let mut longname_header = tar::Header::new_gnu();
            longname_header.set_path("././@LongLink").unwrap();
            longname_header.set_entry_type(tar::EntryType::GNULongName);
            longname_header.set_mode(0o644);
            longname_header.set_size(u64::try_from(longname_body.len()).unwrap());
            longname_header.set_cksum();
            archive
                .append(&longname_header, Cursor::new(longname_body))
                .unwrap();
            append_tar_file(
                &mut archive,
                "rtl/header-placeholder.sv",
                b"module top; endmodule\n",
            );
            archive.finish().unwrap();
        }

        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("gnu-longname.tar.gz");
        fs::write(&archive_path, gzip(&tar_bytes)).unwrap();
        let output = directory.path().join("output");
        fs::create_dir(&output).unwrap();

        extract_source_archive(&archive_path, &output, SourceFormat::TarGz).unwrap();
        validate_project_paths(&output, &output.join("project.f")).unwrap();
        assert_eq!(
            fs::read_to_string(output.join(&long_path)).unwrap(),
            "module top; endmodule\n"
        );
        assert!(!output.join("rtl/header-placeholder.sv").exists());
    }

    #[test]
    fn tar_gz_rejects_a_large_gnu_longname_record_before_reading_its_body() {
        let mut header = tar::Header::new_gnu();
        header.set_path("metadata").unwrap();
        header.set_entry_type(tar::EntryType::GNULongName);
        header.set_mode(0o644);
        header.set_size(MAX_ARCHIVE_ENTRY_BYTES + 1);
        header.set_cksum();

        // Deliberately omit the declared body. With raw TAR iteration, policy
        // rejects the special record from its header instead of asking the TAR
        // crate to buffer the oversized GNU longname body.
        let compressed = gzip(header.as_bytes());

        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("large-longname.tar.gz");
        fs::write(&archive_path, compressed).unwrap();
        let output = directory.path().join("output");
        fs::create_dir(&output).unwrap();

        let error =
            extract_source_archive(&archive_path, &output, SourceFormat::TarGz).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("GNU longname record exceeds the 1025-byte limit"),
            "{error:#}"
        );
        assert!(fs::read_dir(output).unwrap().next().is_none());
    }

    #[test]
    fn tar_gz_rejects_an_oversized_pax_record_before_reading_its_body() {
        let mut header = tar::Header::new_ustar();
        header.set_path("PaxHeader/project.f").unwrap();
        header.set_entry_type(tar::EntryType::XHeader);
        header.set_mode(0o644);
        header.set_size(MAX_TAR_EXTENSION_BYTES + 1);
        header.set_cksum();

        // The declared body is deliberately absent. Rejection must come from
        // the raw header's bounded-size check, without trying to buffer it.
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("large-pax.tar.gz");
        fs::write(&archive_path, gzip(header.as_bytes())).unwrap();
        let output = directory.path().join("output");
        fs::create_dir(&output).unwrap();

        let error =
            extract_source_archive(&archive_path, &output, SourceFormat::TarGz).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("PAX extension record exceeds the 1048576-byte limit"),
            "{error:#}"
        );
        assert!(fs::read_dir(output).unwrap().next().is_none());
    }

    #[test]
    fn tar_gz_rejects_malformed_pax_record_lengths() {
        let mut tar_bytes = Vec::new();
        {
            let mut archive = tar::Builder::new(&mut tar_bytes);
            let malformed = b"99 mtime=0\n";
            let mut header = tar::Header::new_ustar();
            header.set_path("PaxHeader/project.f").unwrap();
            header.set_entry_type(tar::EntryType::XHeader);
            header.set_mode(0o644);
            header.set_size(u64::try_from(malformed.len()).unwrap());
            header.set_cksum();
            archive.append(&header, Cursor::new(malformed)).unwrap();
            append_tar_file(&mut archive, "project.f", b"--top top\nrtl/top.sv\n");
            archive.finish().unwrap();
        }

        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("malformed-pax.tar.gz");
        fs::write(&archive_path, gzip(&tar_bytes)).unwrap();
        let output = directory.path().join("output");
        fs::create_dir(&output).unwrap();

        let error =
            extract_source_archive(&archive_path, &output, SourceFormat::TarGz).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("PAX extension has a malformed record length"),
            "{error:#}"
        );
        assert!(fs::read_dir(output).unwrap().next().is_none());
    }

    #[test]
    fn filelist_validation_rejects_paths_outside_project_root() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        fs::create_dir(&project).unwrap();
        fs::write(project.join("project.f"), "--top top\n../outside.sv\n").unwrap();
        fs::write(
            directory.path().join("outside.sv"),
            "module top; endmodule\n",
        )
        .unwrap();
        let error = validate_project_paths(&project, &project.join("project.f")).unwrap_err();
        assert!(format!("{error:#}").contains("escapes the uploaded project root"));
    }

    #[test]
    fn nested_filelists_are_rejected_before_an_outside_file_is_opened() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        fs::create_dir(&project).unwrap();
        let outside = directory.path().join("outside.f");
        fs::write(&outside, "\"unterminated secret").unwrap();

        for nested in [
            "../outside.f".to_owned(),
            outside.to_string_lossy().into_owned(),
        ] {
            fs::write(
                project.join("project.f"),
                format!("--top top\n-F {nested}\n"),
            )
            .unwrap();
            let error = validate_project_paths(&project, &project.join("project.f")).unwrap_err();
            let message = format!("{error:#}");
            assert!(message.contains("outside project root"), "{message}");
            assert!(!message.contains("unterminated"), "{message}");
        }
    }

    #[test]
    fn startup_rejects_overlapping_storage_and_scratch_roots() {
        let root = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        fs::write(web.path().join("index.html"), "<h1>Nettle</h1>").unwrap();
        let storage = root.path().join("data");
        let scratch = storage.join("scratch");
        let error = initialize_state(HostOptions {
            web_root: web.path().to_owned(),
            bind_address: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            storage_root: storage,
            scratch_root: scratch,
            max_queued_builds: 1,
            build_timeout: Duration::from_secs(1),
            evict_after: None,
            max_upload_bytes: 1024,
        })
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("--storage-root and --scratch-root")
        );

        let root = tempfile::tempdir().unwrap();
        let web = root.path().join("web");
        fs::create_dir(&web).unwrap();
        fs::write(web.join("index.html"), "<h1>Nettle</h1>").unwrap();
        let scratch = root.path().join("scratch");
        let error = initialize_state(HostOptions {
            web_root: web.clone(),
            bind_address: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            storage_root: web.join("data"),
            scratch_root: scratch,
            max_queued_builds: 1,
            build_timeout: Duration::from_secs(1),
            evict_after: None,
            max_upload_bytes: 1024,
        })
        .unwrap_err();
        assert!(error.to_string().contains("--web-root and --storage-root"));
    }

    #[test]
    fn storage_full_path_sweeps_and_retries_exactly_once() {
        let host = test_host(1);
        let mut attempts = 0;
        let result = storage_retry(&host.state, || {
            attempts += 1;
            if attempts == 1 {
                Err(io::Error::from_raw_os_error(libc::ENOSPC))
            } else {
                Ok("recovered")
            }
        })
        .unwrap();
        assert_eq!(result, "recovered");
        assert_eq!(attempts, 2);

        let mut failed_attempts = 0;
        let error = storage_retry(&host.state, || {
            failed_attempts += 1;
            Err::<(), _>(io::Error::from_raw_os_error(libc::ENOSPC))
        })
        .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ENOSPC));
        assert_eq!(failed_attempts, 2);
    }

    #[tokio::test]
    async fn admission_sync_failure_rolls_back_before_queue_mutation() {
        let host = test_host(2);
        let staged_path = host.state.0.staging_root.join("admission-test");
        fs::create_dir(&staged_path).unwrap();
        fs::write(staged_path.join("metadata.json"), b"durable admission").unwrap();
        let session_path = host.state.0.sessions_root.join("a".repeat(64));
        let mut synced_parents = Vec::new();

        let error =
            commit_staged_session_with_sync(&host.state, &staged_path, &session_path, |parent| {
                synced_parents.push(parent.to_owned());
                if parent == host.state.0.sessions_root {
                    Err(io::Error::from_raw_os_error(libc::EIO))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();

        assert_eq!(error.raw_os_error(), Some(libc::EIO));
        assert_eq!(
            synced_parents,
            vec![
                host.state.0.staging_root.clone(),
                host.state.0.sessions_root.clone()
            ]
        );
        assert!(!staged_path.exists());
        assert!(!session_path.exists());
        assert!(host.state.0.queue.lock().await.jobs.is_empty());
    }

    #[tokio::test]
    async fn build_start_enospc_fails_and_cleans_job_without_blocking_next_queue_entry() {
        let host = test_host(2);
        let token = "6".repeat(64);
        let next_token = "7".repeat(64);
        let metadata = test_source_metadata(&token, SessionState::Queued, 1);
        let session_path = write_test_session(&host.state, &metadata);
        let archive_path = session_path.join(SourceFormat::Zip.stored_filename());
        fs::write(&archive_path, b"raw source upload").unwrap();
        fs::write(session_path.join("design.nettle"), b"failed output").unwrap();
        fs::write(
            session_path.join(".design.nettle.tmp"),
            b"temporary failed output",
        )
        .unwrap();
        host.state
            .0
            .queue
            .lock()
            .await
            .jobs
            .push_back(next_token.clone());

        let mut commits = 0_usize;
        process_queued_build_with_metadata_writer(&host.state, &token, |path, metadata| {
            commits = commits.saturating_add(1);
            if commits == 1 {
                // Represents ENOSPC after `storage_retry` already performed
                // its retention sweep and one retry.
                Err(io::Error::from_raw_os_error(libc::ENOSPC))
            } else {
                write_metadata(path, metadata)
            }
        })
        .await
        .unwrap();

        assert_eq!(commits, 2);
        let failed = read_metadata(&session_path).unwrap();
        assert_eq!(failed.state, SessionState::Failed);
        assert_eq!(failed.build_started_at_ms, None);
        assert!(failed.completed_at_ms.is_some());
        assert!(
            failed
                .error
                .as_deref()
                .unwrap()
                .contains("out of storage space")
        );
        assert!(!archive_path.exists());
        assert!(!session_path.join("design.nettle").exists());
        assert!(!session_path.join(".design.nettle.tmp").exists());

        let mut queue = host.state.0.queue.lock().await;
        assert_eq!(queue.jobs.pop_front(), Some(next_token));
        assert!(queue.jobs.is_empty());
    }

    #[tokio::test]
    async fn persistent_terminal_enospc_preserves_ready_session_while_queue_advances() {
        let host = test_host(2);
        let token = "8".repeat(64);
        let next_token = "9".repeat(64);
        let building = test_source_metadata(&token, SessionState::Building, 1);
        let session_path = write_test_session(&host.state, &building);
        let archive_path = session_path.join(SourceFormat::Zip.stored_filename());
        fs::write(&archive_path, b"raw source upload").unwrap();
        let design_path = session_path.join("design.nettle");
        test_bundle(&design_path);
        let temporary_path = session_path.join(".design.nettle.tmp");
        fs::write(&temporary_path, b"stale temporary output").unwrap();
        host.state
            .0
            .queue
            .lock()
            .await
            .jobs
            .push_back(next_token.clone());

        let mut ready = building;
        ready.state = SessionState::Ready;
        ready.completed_at_ms = Some(now_ms());
        let mut attempts = 0_usize;
        let committed =
            commit_terminal_metadata_with_writer(&host.state, &session_path, &ready, |_, _| {
                attempts = attempts.saturating_add(1);
                Err(io::Error::from_raw_os_error(libc::ENOSPC))
            })
            .await;

        assert!(!committed);
        assert_eq!(attempts, ENOSPC_METADATA_COMMIT_ATTEMPTS);
        assert!(session_path.is_dir());
        assert!(design_path.is_file());
        assert!(!archive_path.exists());
        assert!(!temporary_path.exists());
        assert_eq!(
            read_metadata(&session_path).unwrap().state,
            SessionState::Building
        );
        {
            let mut queue = host.state.0.queue.lock().await;
            assert_eq!(queue.jobs.pop_front(), Some(next_token));
            assert!(queue.jobs.is_empty());
        }

        let recovered = initialize_state(test_options(&host)).unwrap();
        assert_eq!(
            read_metadata(&session_path).unwrap().state,
            SessionState::Ready
        );
        assert!(design_path.is_file());
        assert!(recovered.0.queue.lock().await.jobs.is_empty());
    }

    #[tokio::test]
    async fn persistent_terminal_cleanup_is_deferred_without_blocking_the_queue() {
        let host = test_host(2);
        let token = "a".repeat(64);
        let next_token = "b".repeat(64);
        let mut ready = test_source_metadata(&token, SessionState::Ready, 1);
        ready.completed_at_ms = Some(now_ms());
        let session_path = write_test_session(&host.state, &ready);
        host.state
            .0
            .queue
            .lock()
            .await
            .jobs
            .push_back(next_token.clone());

        let mut commits = 0_usize;
        let mut cleanup_attempts = 0_usize;
        let outcome = tokio::time::timeout(
            Duration::from_secs(1),
            commit_terminal_metadata_with_operations(
                &host.state,
                &session_path,
                &ready,
                |path, metadata| {
                    commits = commits.saturating_add(1);
                    write_metadata(path, metadata)
                },
                |_, _| {
                    cleanup_attempts = cleanup_attempts.saturating_add(1);
                    false
                },
            ),
        )
        .await
        .expect("persistent cleanup must not block the FIFO worker");

        assert!(outcome.committed);
        assert!(outcome.cleanup_deferred);
        assert_eq!(commits, 1);
        assert_eq!(cleanup_attempts, TERMINAL_CLEANUP_ATTEMPTS);
        assert_eq!(
            read_metadata(&session_path).unwrap().state,
            SessionState::Ready
        );
        let mut queue = host.state.0.queue.lock().await;
        assert_eq!(queue.jobs.pop_front(), Some(next_token));
        assert!(queue.jobs.is_empty());
    }

    #[tokio::test]
    async fn persistent_terminal_metadata_failure_is_deferred_without_blocking_the_queue() {
        let host = test_host(2);
        let token = "c".repeat(64);
        let next_token = "d".repeat(64);
        let mut ready = test_source_metadata(&token, SessionState::Ready, 1);
        ready.completed_at_ms = Some(now_ms());
        let session_path = write_test_session(&host.state, &ready);
        host.state
            .0
            .queue
            .lock()
            .await
            .jobs
            .push_back(next_token.clone());

        let mut commits = 0_usize;
        let outcome = tokio::time::timeout(
            Duration::from_secs(1),
            commit_terminal_metadata_with_operations(
                &host.state,
                &session_path,
                &ready,
                |_, _| {
                    commits = commits.saturating_add(1);
                    Err(io::Error::from_raw_os_error(libc::EACCES))
                },
                |_, _| true,
            ),
        )
        .await
        .expect("persistent metadata failure must not block the FIFO worker");

        assert!(!outcome.committed);
        assert!(!outcome.cleanup_deferred);
        assert_eq!(commits, TERMINAL_METADATA_COMMIT_ATTEMPTS);
        assert_eq!(
            read_metadata(&session_path).unwrap().state,
            SessionState::Ready
        );
        let mut queue = host.state.0.queue.lock().await;
        assert_eq!(queue.jobs.pop_front(), Some(next_token));
        assert!(queue.jobs.is_empty());
    }

    #[test]
    fn startup_enospc_recovery_cleans_and_commits_a_small_failed_tombstone() {
        let host = test_host(2);
        let token = "0".repeat(64);
        let metadata = test_source_metadata(&token, SessionState::Building, 1);
        let session_path = write_test_session(&host.state, &metadata);
        let archive_path = session_path.join(SourceFormat::Zip.stored_filename());
        fs::write(&archive_path, b"raw source upload").unwrap();
        fs::write(session_path.join("design.nettle"), b"failed output").unwrap();
        fs::write(
            session_path.join(".design.nettle.tmp"),
            b"temporary failed output",
        )
        .unwrap();
        let mut commits = 0_usize;

        let disposition = reconcile_startup_session(&session_path, metadata, |path, metadata| {
            commits = commits.saturating_add(1);
            if commits == 1 {
                Err(io::Error::from_raw_os_error(libc::ENOSPC))
            } else {
                write_metadata(path, metadata)
            }
        })
        .unwrap();

        assert!(matches!(disposition, StartupSessionDisposition::Terminal));
        assert_eq!(commits, 2);
        let failed = read_metadata(&session_path).unwrap();
        assert_eq!(failed.state, SessionState::Failed);
        assert!(
            failed
                .error
                .as_deref()
                .unwrap()
                .contains("out of storage space")
        );
        assert!(!archive_path.exists());
        assert!(!session_path.join("design.nettle").exists());
        assert!(!session_path.join(".design.nettle.tmp").exists());
    }

    #[tokio::test]
    async fn restart_preserves_fifo_and_retries_an_interrupted_build_once() {
        let host = test_host(2);
        let queued_late = "a".repeat(64);
        let interrupted = "b".repeat(64);
        let queued_first = "c".repeat(64);
        let interrupted_twice = "d".repeat(64);

        let queued_late_path = write_test_session(
            &host.state,
            &test_source_metadata(&queued_late, SessionState::Queued, 30),
        );
        fs::write(
            queued_late_path.join(SourceFormat::Zip.stored_filename()),
            b"source upload",
        )
        .unwrap();
        let interrupted_path = write_test_session(
            &host.state,
            &test_source_metadata(&interrupted, SessionState::Building, 20),
        );
        fs::write(
            interrupted_path.join(SourceFormat::Zip.stored_filename()),
            b"source upload",
        )
        .unwrap();
        let queued_first_path = write_test_session(
            &host.state,
            &test_source_metadata(&queued_first, SessionState::Queued, 10),
        );
        fs::write(
            queued_first_path.join(SourceFormat::Zip.stored_filename()),
            b"source upload",
        )
        .unwrap();
        let mut repeated_metadata =
            test_source_metadata(&interrupted_twice, SessionState::Building, 15);
        repeated_metadata.interruptions = 1;
        let repeated_path = write_test_session(&host.state, &repeated_metadata);
        let repeated_archive = repeated_path.join(SourceFormat::Zip.stored_filename());
        fs::write(&repeated_archive, b"source upload").unwrap();
        fs::write(repeated_path.join("design.nettle"), b"partial bundle").unwrap();
        fs::write(
            repeated_path.join(".design.nettle.tmp"),
            b"partial temporary bundle",
        )
        .unwrap();

        let recovered = initialize_state(test_options(&host)).unwrap();
        {
            let queue = recovered.0.queue.lock().await;
            assert_eq!(
                queue.jobs.iter().collect::<Vec<_>>(),
                vec![&queued_first, &interrupted, &queued_late]
            );
            assert_eq!(queue.next_order, 31);
        }
        let recovered_interrupted = read_metadata(&interrupted_path).unwrap();
        assert_eq!(recovered_interrupted.state, SessionState::Queued);
        assert_eq!(recovered_interrupted.interruptions, 1);
        assert_eq!(recovered_interrupted.build_started_at_ms, None);
        assert!(
            interrupted_path
                .join(SourceFormat::Zip.stored_filename())
                .is_file()
        );

        let failed = read_metadata(&repeated_path).unwrap();
        assert_eq!(failed.state, SessionState::Failed);
        assert_eq!(
            failed.error.as_deref(),
            Some("Build interrupted repeatedly while the server restarted.")
        );
        assert!(failed.completed_at_ms.is_some());
        assert!(!repeated_archive.exists());
        assert!(!repeated_path.join("design.nettle").exists());
        assert!(!repeated_path.join(".design.nettle.tmp").exists());

        let mut retried = recovered_interrupted;
        retried.state = SessionState::Building;
        retried.build_started_at_ms = Some(now_ms());
        write_metadata(&interrupted_path, &retried).unwrap();

        let recovered_again = initialize_state(test_options(&host)).unwrap();
        {
            let queue = recovered_again.0.queue.lock().await;
            assert_eq!(
                queue.jobs.iter().collect::<Vec<_>>(),
                vec![&queued_first, &queued_late]
            );
        }
        let failed_retry = read_metadata(&interrupted_path).unwrap();
        assert_eq!(failed_retry.state, SessionState::Failed);
        assert_eq!(failed_retry.interruptions, 1);
        assert!(
            !interrupted_path
                .join(SourceFormat::Zip.stored_filename())
                .exists()
        );
    }

    #[test]
    fn retention_sweep_only_evicts_expired_terminal_sessions() {
        let host = test_host(2);
        let expired_ready = "1".repeat(64);
        let expired_failed = "2".repeat(64);
        let old_queued = "3".repeat(64);
        let old_building = "4".repeat(64);
        let fresh_ready = "5".repeat(64);

        for (token, state, completed_at_ms) in [
            (&expired_ready, SessionState::Ready, Some(0)),
            (&expired_failed, SessionState::Failed, Some(0)),
            (&old_queued, SessionState::Queued, Some(0)),
            (&old_building, SessionState::Building, Some(0)),
            (&fresh_ready, SessionState::Ready, Some(now_ms())),
        ] {
            let mut metadata = test_source_metadata(token, state, 1);
            metadata.completed_at_ms = completed_at_ms;
            write_test_session(&host.state, &metadata);
        }

        sweep_retention(&host.state).unwrap();

        assert!(!host.state.0.sessions_root.join(expired_ready).exists());
        assert!(!host.state.0.sessions_root.join(expired_failed).exists());
        assert!(host.state.0.sessions_root.join(old_queued).is_dir());
        assert!(host.state.0.sessions_root.join(old_building).is_dir());
        assert!(host.state.0.sessions_root.join(fresh_ready).is_dir());
    }

    #[tokio::test]
    async fn startup_sweeps_expired_sessions_before_recovering_the_build_queue() {
        let host = test_host(2);
        let expired = "a".repeat(64);
        let mut expired_metadata = test_source_metadata(&expired, SessionState::Ready, 1);
        expired_metadata.completed_at_ms = Some(0);
        let expired_path = write_test_session(&host.state, &expired_metadata);
        let queued = "b".repeat(64);
        let queued_metadata = test_source_metadata(&queued, SessionState::Queued, 2);
        let queued_path = write_test_session(&host.state, &queued_metadata);
        fs::write(
            queued_path.join(SourceFormat::Zip.stored_filename()),
            b"queued source",
        )
        .unwrap();

        let recovered = initialize_state(test_options(&host)).unwrap();

        assert!(!expired_path.exists());
        let queue = recovered.0.queue.lock().await;
        assert_eq!(queue.jobs.iter().collect::<Vec<_>>(), vec![&queued]);
    }

    #[tokio::test]
    async fn dequeued_incomplete_build_is_requeued_instead_of_stranded() {
        let host = test_host(2);
        let token = "a".repeat(64);
        let session_path = host.state.0.sessions_root.join(&token);
        fs::create_dir(&session_path).unwrap();
        let metadata = SessionMetadata {
            schema_version: HOST_SCHEMA_VERSION,
            token: token.clone(),
            kind: SessionKind::Sources,
            state: SessionState::Queued,
            original_name: "sources.zip".to_owned(),
            upload_bytes: 1,
            admitted_at_ms: 1,
            queue_order: 1,
            build_started_at_ms: None,
            completed_at_ms: None,
            interruptions: 0,
            source_format: Some(SourceFormat::Zip),
            error: None,
        };
        write_metadata(&session_path, &metadata).unwrap();
        assert!(requeue_incomplete_build(&host.state, &token).await);
        let queue = host.state.0.queue.lock().await;
        assert_eq!(queue.jobs.front(), Some(&token));
        assert_eq!(host.state.0.source_queue_slots.load(Ordering::Acquire), 1);
    }

    #[test]
    fn startup_reconciles_ready_and_failed_session_artifacts() {
        let host = test_host(2);
        let ready = "e".repeat(64);
        let ready_metadata = test_source_metadata(&ready, SessionState::Ready, 1);
        let ready_path = write_test_session(&host.state, &ready_metadata);
        fs::write(
            ready_path.join(SourceFormat::Zip.stored_filename()),
            b"lingering source",
        )
        .unwrap();
        fs::write(ready_path.join("design.nettle"), b"completed bundle").unwrap();
        fs::write(
            ready_path.join(".design.nettle.tmp"),
            b"stale temporary bundle",
        )
        .unwrap();

        let failed = "f".repeat(64);
        let mut failed_metadata = test_source_metadata(&failed, SessionState::Failed, 2);
        failed_metadata.error = Some("compiler failed".to_owned());
        let failed_path = write_test_session(&host.state, &failed_metadata);
        fs::write(
            failed_path.join(SourceFormat::Zip.stored_filename()),
            b"lingering source",
        )
        .unwrap();
        fs::write(failed_path.join("design.nettle"), b"stale bundle").unwrap();
        fs::write(
            failed_path.join(".design.nettle.tmp"),
            b"stale temporary bundle",
        )
        .unwrap();

        let recovered = initialize_state(test_options(&host)).unwrap();

        assert!(
            !ready_path
                .join(SourceFormat::Zip.stored_filename())
                .exists()
        );
        assert!(ready_path.join("design.nettle").is_file());
        assert!(!ready_path.join(".design.nettle.tmp").exists());
        assert_eq!(
            read_metadata(&recovered.0.sessions_root.join(&ready))
                .unwrap()
                .state,
            SessionState::Ready
        );

        let mut failed_entries = fs::read_dir(&failed_path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        failed_entries.sort();
        assert_eq!(failed_entries, vec![OsString::from("metadata.json")]);
        let recovered_failed = read_metadata(&recovered.0.sessions_root.join(&failed)).unwrap();
        assert_eq!(recovered_failed.state, SessionState::Failed);
        assert_eq!(recovered_failed.error.as_deref(), Some("compiler failed"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn build_deadline_includes_descendants_holding_output_pipes() {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("sleep 30 &")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let started = tokio::time::Instant::now();
        let error = run_bounded_command(command, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("descendant output"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
