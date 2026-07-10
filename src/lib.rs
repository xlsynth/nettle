// SPDX-License-Identifier: Apache-2.0

//! Builds Nettle bundles and serves the static browser viewer.
#![deny(missing_docs)]

pub mod bundle;
pub mod ir;

mod builder;
mod compiler;
mod resource_limits;

use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use axum::routing::{MethodRouter, any, get};
use axum::{Json, Router};
use clap::ValueEnum;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::Mutex;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::bundle::BundleReader;
use crate::resource_limits::bundle::archive::TOTAL_BYTES as MAX_STARTUP_BUNDLE_BYTES;

pub use builder::{BuildOptions, BuiltProject, build_project};
pub use compiler::{
    CompilerArtifacts, CompilerOptions, CompilerTranscript, DefineOverride, ElaborationOverrides,
    ParameterOverride, ToolReport, compile_filelist, parse_define_override,
    parse_parameter_override, parse_slang_diagnostics, parse_undefine,
};

const STARTUP_BUNDLE_ROUTE: &str = "/startup.nettle";
const STARTUP_COMPARISON_ROUTE: &str = "/startup-comparison.json";
const STARTUP_REFERENCE_ROUTE: &str = "/startup-reference.nettle";
const STARTUP_CANDIDATE_ROUTE: &str = "/startup-candidate.nettle";
const STARTUP_STREAM_CHUNK_BYTES: u64 = 64 * 1024;

/// Graph-correspondence policy used for a schematic comparison.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, ValueEnum)]
#[serde(rename_all = "camelCase")]
pub enum MatchingPolicy {
    /// Match only exact or uniquely determined graph objects.
    #[default]
    Conservative,
    /// Add deterministic, scored heuristic matches to conservative anchors.
    Aggressive,
}

/// Immutable validated `.nettle` snapshot exposed by a startup route.
///
/// The native host copies the selected archive into one anonymous temporary
/// file for a single workspace and two for a comparison. Route requests read
/// only those snapshots, never the caller-owned paths, so later source-file
/// changes cannot alter responses. The operating system deletes anonymous
/// storage when the final handle closes, including after abrupt termination.
#[derive(Clone)]
pub struct StartupBundle {
    name: String,
    snapshot: Arc<Mutex<tokio::fs::File>>,
    byte_len: u64,
}

impl StartupBundle {
    /// Copies and fully validates one archive into anonymous delete-on-close storage.
    pub fn open(path: &Path) -> Result<Self> {
        let source = File::open(path)
            .with_context(|| format!("opening startup bundle {}", path.display()))?;
        let mut snapshot = tempfile::tempfile().context("creating anonymous startup snapshot")?;
        let byte_len = std::io::copy(
            &mut source.take(MAX_STARTUP_BUNDLE_BYTES.saturating_add(1)),
            &mut snapshot,
        )
        .with_context(|| format!("snapshotting startup bundle {}", path.display()))?;
        if byte_len > MAX_STARTUP_BUNDLE_BYTES {
            anyhow::bail!(
                "startup bundle {} exceeds the {}-byte snapshot limit",
                path.display(),
                MAX_STARTUP_BUNDLE_BYTES
            );
        }
        snapshot
            .flush()
            .context("flushing startup bundle snapshot")?;

        snapshot
            .seek(SeekFrom::Start(0))
            .context("rewinding anonymous startup snapshot")?;
        let validation_file = snapshot
            .try_clone()
            .context("cloning anonymous startup snapshot for validation")?;
        let mut reader = BundleReader::new(validation_file)
            .with_context(|| format!("opening startup bundle {}", path.display()))?;
        reader
            .validate_all()
            .with_context(|| format!("validating startup bundle {}", path.display()))?;
        Ok(Self {
            name: startup_bundle_name(path, "startup.nettle"),
            snapshot: Arc::new(Mutex::new(tokio::fs::File::from_std(snapshot))),
            byte_len,
        })
    }

    /// Browser-visible filename, never an absolute host path.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Number of compressed archive bytes retained in the private snapshot.
    pub fn byte_len(&self) -> u64 {
        self.byte_len
    }
}

impl fmt::Debug for StartupBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StartupBundle")
            .field("name", &self.name)
            .field("byte_len", &self.byte_len)
            .finish()
    }
}

/// Optional workspace made available to the browser when the viewer starts.
#[derive(Debug, Clone)]
pub enum StartupWorkspace {
    /// Start with the bundle picker and do not expose design data from the host.
    Empty,
    /// Expose one validated bundle at the legacy startup route.
    SingleBundle {
        /// Validated immutable bundle snapshot.
        bundle: StartupBundle,
    },
    /// Expose two validated bundles and their comparison descriptor.
    Comparison {
        /// Validated immutable reference snapshot.
        reference: StartupBundle,
        /// Validated immutable candidate snapshot.
        candidate: StartupBundle,
        /// Initial graph-correspondence policy selected by the CLI.
        matching: MatchingPolicy,
    },
}

#[derive(Debug, Clone, Serialize)]
struct StartupBundleDescriptor {
    name: String,
    route: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct StartupComparisonDescriptor {
    reference: StartupBundleDescriptor,
    candidate: StartupBundleDescriptor,
    matching: MatchingPolicy,
}

/// Serves the browser application and an optional startup workspace.
///
/// With [`StartupWorkspace::Empty`], `.nettle` files stay entirely in the
/// browser. Single and comparison workspaces expose only their explicitly
/// selected bundles at fixed `no-store` routes so the browser can apply its
/// normal validation path.
pub async fn serve_static(
    web_root: &Path,
    startup_workspace: StartupWorkspace,
    bind_address: IpAddr,
    port: u16,
) -> Result<SocketAddr> {
    let app = static_router(web_root, &startup_workspace)?;
    let listener = tokio::net::TcpListener::bind((bind_address, port))
        .await
        .with_context(|| format!("binding static viewer to {bind_address}:{port}"))?;
    let address = listener.local_addr()?;
    println!("Nettle viewer listening on http://{address}");
    axum::serve(listener, app).await?;
    Ok(address)
}

fn static_router(web_root: &Path, startup_workspace: &StartupWorkspace) -> Result<Router> {
    let index = web_root.join("index.html");
    if !index.is_file() {
        anyhow::bail!("web root {} has no index.html", web_root.display());
    }
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route(
            "/api",
            any(|| async { (StatusCode::NOT_FOUND, "Nettle has no viewer API") }),
        )
        .route(
            "/api/{*path}",
            any(|| async { (StatusCode::NOT_FOUND, "Nettle has no viewer API") }),
        );
    let app = match startup_workspace {
        StartupWorkspace::Empty => app
            .route(STARTUP_BUNDLE_ROUTE, no_store_route(get(startup_not_found)))
            .route(
                STARTUP_COMPARISON_ROUTE,
                no_store_route(get(startup_not_found)),
            )
            .route(
                STARTUP_REFERENCE_ROUTE,
                no_store_route(get(startup_not_found)),
            )
            .route(
                STARTUP_CANDIDATE_ROUTE,
                no_store_route(get(startup_not_found)),
            ),
        StartupWorkspace::SingleBundle { bundle } => app
            .route(STARTUP_BUNDLE_ROUTE, uncached_bundle(bundle))
            .route(
                STARTUP_COMPARISON_ROUTE,
                no_store_route(get(startup_not_found)),
            )
            .route(
                STARTUP_REFERENCE_ROUTE,
                no_store_route(get(startup_not_found)),
            )
            .route(
                STARTUP_CANDIDATE_ROUTE,
                no_store_route(get(startup_not_found)),
            ),
        StartupWorkspace::Comparison {
            reference,
            candidate,
            matching,
        } => {
            let descriptor = StartupComparisonDescriptor {
                reference: StartupBundleDescriptor {
                    name: reference.name.clone(),
                    route: STARTUP_REFERENCE_ROUTE,
                },
                candidate: StartupBundleDescriptor {
                    name: candidate.name.clone(),
                    route: STARTUP_CANDIDATE_ROUTE,
                },
                matching: *matching,
            };
            app.route(STARTUP_BUNDLE_ROUTE, no_store_route(get(startup_not_found)))
                .route(
                    STARTUP_COMPARISON_ROUTE,
                    no_store_route(get(move || {
                        let descriptor = descriptor.clone();
                        async move {
                            (
                                [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
                                Json(descriptor),
                            )
                        }
                    })),
                )
                .route(STARTUP_REFERENCE_ROUTE, uncached_bundle(reference))
                .route(STARTUP_CANDIDATE_ROUTE, uncached_bundle(candidate))
        }
    };
    Ok(app.fallback_service(
        ServeDir::new(web_root)
            .not_found_service(ServeFile::new(index))
            .append_index_html_on_directories(true),
    ))
}

fn no_store_route(route: MethodRouter) -> MethodRouter {
    route.layer(SetResponseHeaderLayer::overriding(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    ))
}

async fn startup_not_found() -> (
    StatusCode,
    [(header::HeaderName, HeaderValue); 1],
    &'static str,
) {
    (
        StatusCode::NOT_FOUND,
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        "",
    )
}

fn uncached_bundle(bundle: &StartupBundle) -> MethodRouter {
    let snapshot = Arc::clone(&bundle.snapshot);
    let byte_len = bundle.byte_len;
    no_store_route(get(move || {
        let snapshot = Arc::clone(&snapshot);
        async move {
            let stream = async_stream::stream! {
                let mut offset = 0_u64;
                while offset < byte_len {
                    let chunk_result: io::Result<(Vec<u8>, u64)> = async {
                        let chunk_len = usize::try_from(
                            (byte_len - offset).min(STARTUP_STREAM_CHUNK_BYTES),
                        )
                        .map_err(|_| io::Error::other("startup bundle chunk length overflow"))?;
                        let mut chunk = vec![0_u8; chunk_len];
                        let read = {
                            let mut file = snapshot.lock().await;
                            file.seek(SeekFrom::Start(offset)).await?;
                            file.read(&mut chunk).await?
                        };
                        if read == 0 {
                            return Err(io::Error::new(
                                io::ErrorKind::UnexpectedEof,
                                "anonymous startup snapshot ended before its validated length",
                            ));
                        }
                        chunk.truncate(read);
                        Ok((
                            chunk,
                            u64::try_from(read).map_err(|_| {
                                io::Error::other("startup bundle read length overflow")
                            })?,
                        ))
                    }
                    .await;
                    match chunk_result {
                        Ok((chunk, read)) => {
                            offset += read;
                            yield Ok::<Vec<u8>, io::Error>(chunk);
                        }
                        Err(error) => {
                            yield Err::<Vec<u8>, io::Error>(error);
                            break;
                        }
                    }
                }
            };
            Response::builder()
                .header(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))
                .header(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/octet-stream"),
                )
                .header(header::CONTENT_LENGTH, byte_len)
                .body(Body::from_stream(stream))
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
        }
    }))
}

fn startup_bundle_name(path: &Path, fallback: &str) -> String {
    let mut name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .map_or_else(|| fallback.to_owned(), |name| name.to_string_lossy().into());
    if !name.to_ascii_lowercase().ends_with(".nettle") {
        name.push_str(".nettle");
    }
    name
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::PathBuf;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use crate::bundle::{BuildMetadata, BundleContents, DebugArtifact, write_bundle};
    use crate::ir::{DesignSnapshot, GraphModule, GraphSlice};

    use super::*;

    fn write_test_startup_bundle(path: &Path, snapshot_id: &str, padding: u8) {
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
            edges: vec![],
            groups: vec![],
            files: None,
        };
        let snapshot = DesignSnapshot {
            snapshot_id: snapshot_id.to_owned(),
            top: "top".to_owned(),
            tops: vec!["top".to_owned()],
            modules: BTreeMap::from([("top".to_owned(), slice)]),
        };
        let mut state = u32::from(padding).saturating_add(1);
        let stream_padding = (0..256 * 1024)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            })
            .collect();
        let debug_artifacts = [DebugArtifact {
            name: "stream-padding.bin".to_owned(),
            contents: stream_padding,
        }];
        write_bundle(
            path,
            &BundleContents {
                snapshot: &snapshot,
                sources: &[],
                diagnostics: &[],
                build: &BuildMetadata::default(),
                debug_artifacts: &debug_artifacts,
            },
        )
        .unwrap();
    }

    fn named_startup_snapshots() -> BTreeSet<PathBuf> {
        std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("nettle-startup-")
            })
            .map(|entry| entry.path())
            .collect()
    }

    #[test]
    fn startup_snapshot_has_no_named_path_to_orphan() {
        let directory = tempfile::tempdir().unwrap();
        let bundle = directory.path().join("anonymous.nettle");
        write_test_startup_bundle(&bundle, "anonymous-snapshot", 0x41);
        let before = named_startup_snapshots();

        let startup_bundle = StartupBundle::open(&bundle).unwrap();
        assert_eq!(named_startup_snapshots(), before);
        drop(startup_bundle);
        assert_eq!(named_startup_snapshots(), before);
    }

    #[tokio::test]
    async fn static_host_serves_assets_but_has_no_project_api() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("index.html"), "<h1>Nettle</h1>").unwrap();
        let router = static_router(directory.path(), &StartupWorkspace::Empty).unwrap();

        let health = router
            .clone()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let api = router
            .clone()
            .oneshot(Request::get("/api/v1/project").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(api.status(), StatusCode::NOT_FOUND);

        let startup = router
            .clone()
            .oneshot(
                Request::get(STARTUP_BUNDLE_ROUTE)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(startup.status(), StatusCode::NOT_FOUND);
        assert_eq!(startup.headers()[header::CACHE_CONTROL], "no-store");

        for route in [
            STARTUP_COMPARISON_ROUTE,
            STARTUP_REFERENCE_ROUTE,
            STARTUP_CANDIDATE_ROUTE,
        ] {
            let response = router
                .clone()
                .oneshot(Request::get(route).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{route}");
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store",
                "{route}"
            );
        }

        for route in [
            STARTUP_BUNDLE_ROUTE,
            STARTUP_COMPARISON_ROUTE,
            STARTUP_REFERENCE_ROUTE,
            STARTUP_CANDIDATE_ROUTE,
        ] {
            let response = router
                .clone()
                .oneshot(Request::post(route).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED, "{route}");
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store",
                "{route}"
            );
        }

        let index = router
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(index.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn static_host_serves_a_pinned_uncached_startup_bundle() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("index.html"), "<h1>Nettle</h1>").unwrap();
        let bundle = directory.path().join("design.nettle");
        write_test_startup_bundle(&bundle, "single-snapshot", 0x5a);
        let expected = std::fs::read(&bundle).unwrap();
        assert!(u64::try_from(expected.len()).unwrap() > STARTUP_STREAM_CHUNK_BYTES * 3);
        let startup_bundle = StartupBundle::open(&bundle).unwrap();
        let router = static_router(
            directory.path(),
            &StartupWorkspace::SingleBundle {
                bundle: startup_bundle,
            },
        )
        .unwrap();
        std::fs::write(&bundle, b"replacement bytes").unwrap();

        let request = || {
            Request::get(STARTUP_BUNDLE_ROUTE)
                .body(Body::empty())
                .unwrap()
        };
        let (left, right) = tokio::join!(
            router.clone().oneshot(request()),
            router.clone().oneshot(request())
        );
        let left = left.unwrap();
        let right = right.unwrap();
        assert_eq!(left.status(), StatusCode::OK);
        assert_eq!(right.status(), StatusCode::OK);
        assert_eq!(left.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(right.headers()[header::CACHE_CONTROL], "no-store");
        let (left, right) = tokio::join!(
            axum::body::to_bytes(left.into_body(), usize::MAX),
            axum::body::to_bytes(right.into_body(), usize::MAX)
        );
        assert_eq!(left.unwrap().as_ref(), expected);
        assert_eq!(right.unwrap().as_ref(), expected);

        for route in [
            STARTUP_COMPARISON_ROUTE,
            STARTUP_REFERENCE_ROUTE,
            STARTUP_CANDIDATE_ROUTE,
        ] {
            let response = router
                .clone()
                .oneshot(Request::get(route).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{route}");
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store",
                "{route}"
            );
        }
    }

    #[tokio::test]
    async fn static_host_serves_an_uncached_comparison_without_host_paths() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("index.html"), "<h1>Nettle</h1>").unwrap();
        let reference = directory.path().join("reference-design.bundle");
        let candidate = directory.path().join("candidate-design.nettle");
        write_test_startup_bundle(&reference, "reference-snapshot", 0x52);
        write_test_startup_bundle(&candidate, "candidate-snapshot", 0x43);
        let reference_bytes = std::fs::read(&reference).unwrap();
        let candidate_bytes = std::fs::read(&candidate).unwrap();
        let reference = StartupBundle::open(&reference).unwrap();
        let candidate = StartupBundle::open(&candidate).unwrap();
        let router = static_router(
            directory.path(),
            &StartupWorkspace::Comparison {
                reference,
                candidate,
                matching: MatchingPolicy::Aggressive,
            },
        )
        .unwrap();

        let startup = router
            .clone()
            .oneshot(
                Request::get(STARTUP_BUNDLE_ROUTE)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(startup.status(), StatusCode::NOT_FOUND);
        assert_eq!(startup.headers()[header::CACHE_CONTROL], "no-store");

        let descriptor = router
            .clone()
            .oneshot(
                Request::get(STARTUP_COMPARISON_ROUTE)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(descriptor.status(), StatusCode::OK);
        assert_eq!(descriptor.headers()[header::CACHE_CONTROL], "no-store");
        let descriptor_body = axum::body::to_bytes(descriptor.into_body(), usize::MAX)
            .await
            .unwrap();
        let descriptor_json: serde_json::Value = serde_json::from_slice(&descriptor_body).unwrap();
        assert_eq!(
            descriptor_json,
            serde_json::json!({
                "reference": {
                    "name": "reference-design.bundle.nettle",
                    "route": STARTUP_REFERENCE_ROUTE,
                },
                "candidate": {
                    "name": "candidate-design.nettle",
                    "route": STARTUP_CANDIDATE_ROUTE,
                },
                "matching": "aggressive",
            })
        );
        assert!(
            !String::from_utf8_lossy(&descriptor_body)
                .contains(directory.path().to_string_lossy().as_ref())
        );

        for (route, expected) in [
            (STARTUP_REFERENCE_ROUTE, reference_bytes.as_slice()),
            (STARTUP_CANDIDATE_ROUTE, candidate_bytes.as_slice()),
        ] {
            let response = router
                .clone()
                .oneshot(Request::get(route).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{route}");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(body.as_ref(), expected, "{route}");
        }
    }

    #[test]
    fn startup_descriptor_names_never_fall_back_to_a_host_path() {
        assert_eq!(
            startup_bundle_name(Path::new("/"), "reference.nettle"),
            "reference.nettle"
        );
        assert_eq!(
            startup_bundle_name(Path::new("/private/design.zip"), "reference.nettle"),
            "design.zip.nettle"
        );
        assert_eq!(
            startup_bundle_name(Path::new("candidate.NETTLE"), "candidate.nettle"),
            "candidate.NETTLE"
        );
    }
}
