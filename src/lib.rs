// SPDX-License-Identifier: Apache-2.0

//! Builds Nettle bundles and serves the static browser viewer.
#![deny(missing_docs)]

pub mod bundle;
pub mod ir;

mod builder;
mod compiler;
mod resource_limits;

use std::net::{IpAddr, SocketAddr};
use std::path::Path;

use anyhow::{Context, Result};
use axum::Router;
use axum::http::{HeaderValue, StatusCode, header};
use axum::routing::{any, get, get_service};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

pub use builder::{BuildOptions, BuiltProject, build_project};
pub use compiler::{
    CompilerArtifacts, CompilerOptions, CompilerTranscript, DefineOverride, ElaborationOverrides,
    ParameterOverride, ToolReport, compile_filelist, parse_define_override,
    parse_parameter_override, parse_slang_diagnostics, parse_undefine,
};

/// Serves the browser application and, optionally, one startup bundle.
///
/// Without `startup_bundle`, `.nettle` files stay entirely in the browser. If
/// supplied, the host exposes that file at a fixed `no-store` route so the same
/// browser application can fetch and validate it.
pub async fn serve_static(
    web_root: &Path,
    startup_bundle: Option<&Path>,
    bind_address: IpAddr,
    port: u16,
) -> Result<SocketAddr> {
    let app = static_router(web_root, startup_bundle)?;
    let listener = tokio::net::TcpListener::bind((bind_address, port))
        .await
        .with_context(|| format!("binding static viewer to {bind_address}:{port}"))?;
    let address = listener.local_addr()?;
    println!("Nettle viewer listening on http://{address}");
    axum::serve(listener, app).await?;
    Ok(address)
}

fn static_router(web_root: &Path, startup_bundle: Option<&Path>) -> Result<Router> {
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
    let app = if let Some(bundle) = startup_bundle {
        app.route_service(
            "/startup.nettle",
            get_service(ServeFile::new(bundle)).layer(SetResponseHeaderLayer::overriding(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            )),
        )
    } else {
        app.route("/startup.nettle", get(|| async { StatusCode::NOT_FOUND }))
    };
    Ok(app.fallback_service(
        ServeDir::new(web_root)
            .not_found_service(ServeFile::new(index))
            .append_index_html_on_directories(true),
    ))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn static_host_serves_assets_but_has_no_project_api() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("index.html"), "<h1>Nettle</h1>").unwrap();
        let router = static_router(directory.path(), None).unwrap();

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
            .oneshot(Request::get("/startup.nettle").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(startup.status(), StatusCode::NOT_FOUND);

        let index = router
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(index.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn static_host_serves_an_optional_uncached_startup_bundle() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("index.html"), "<h1>Nettle</h1>").unwrap();
        let bundle = directory.path().join("design.nettle");
        std::fs::write(&bundle, b"bundle bytes").unwrap();
        let router = static_router(directory.path(), Some(&bundle)).unwrap();

        let response = router
            .oneshot(Request::get("/startup.nettle").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), b"bundle bytes");
    }
}
