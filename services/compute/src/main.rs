//! # peapod-compute HTTP server
//!
//! ## Purpose
//! Expose the pure algorithms in this crate over a private-network HTTP API
//! so `services/api` can call them without embedding a Rust toolchain. The
//! process is stateless: no database, no auth, no sessions. Every route is
//! a JSON in / JSON out function.
//!
//! ## Inputs
//! - `PORT` -- listen port, default `8082`.
//! - `RUST_LOG` -- tracing filter, default `info,tower_http=debug`.
//! - `TRAVEL_DATASET_PATH` -- optional catalog override, consumed by
//!   `itinerary` (not here).
//!
//! ## Outputs
//! An axum 0.8 server bound to `0.0.0.0:{PORT}` that answers:
//! - `GET  /health`
//! - `POST /geo/nearest-place`
//! - `POST /geo/activity`
//! - `POST /trips/reconstruct`
//! - `POST /decisions/evaluate`
//! - `POST /progression/level`
//! - `POST /progression/garden-growth`
//! - `POST /progression/achievements`
//! - `POST /wallet/split`
//! - `POST /itinerary/generate`
//!
//! ## Who calls this
//! `services/api` on the compose network. CORS is permissive so a browser
//! `curl` during local debugging also works; there is no public client.

use axum::extract::{FromRequest, Request};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use peapod_compute::decisions;
use peapod_compute::error::AppError;
use peapod_compute::geo;
use peapod_compute::itinerary;
use peapod_compute::models::{
    AchievementRequest, ActivitySpeedRequest, EvaluateDecisionRequest, GardenGrowthRequest,
    GardenGrowthResponse, HealthResponse, ItineraryRequest, LevelRequest, NearestPlaceRequest,
    NearestPlaceResponse, ReconstructTripRequest, ReconstructTripResponse, SplitRequest,
};
use peapod_compute::progression;
use peapod_compute::rules;
use peapod_compute::trips;
use peapod_compute::wallet;

/// JSON body whose extraction failures become [`AppError::BadRequest`] (`400`)
/// rather than axum's default `422 Unprocessable Entity`.
///
/// The contract (`compute.schema.json` + `error.rs`) says every malformed
/// body is a `400` with `{"error": "..."}`. Axum's `Json<T>` rejects shape
/// mismatches as `422`; wrapping it here is what keeps that promise.
struct AppJson<T>(T);

impl<S, T> FromRequest<S> for AppJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(AppJson(value)),
            Err(rejection) => Err(rejection.into()),
        }
    }
}

/// Lets handlers `return AppJson(value)` and still serialise as a JSON body.
impl<T: serde::Serialize> IntoResponse for AppJson<T> {
    fn into_response(self) -> Response {
        Json(self.0).into_response()
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=debug")),
        )
        .init();

    // Parse every rule file now, so a malformed catalog is a start-up failure
    // a deploy pipeline can see rather than a 500 on the first real request.
    let rules_summary = rules::warm_up();
    tracing::info!(%rules_summary, "compute service starting");

    let port = std::env::var("PORT").unwrap_or_else(|_| "8082".to_string());
    let addr = format!("0.0.0.0:{port}");

    let app = Router::new()
        .route("/health", get(health))
        .route("/geo/nearest-place", post(nearest_place))
        .route("/geo/activity", post(activity))
        .route("/trips/reconstruct", post(reconstruct_trip))
        .route("/decisions/evaluate", post(evaluate_decision))
        .route("/progression/level", post(level))
        .route("/progression/garden-growth", post(garden_growth))
        .route("/progression/achievements", post(achievements))
        .route("/wallet/split", post(wallet_split))
        .route("/itinerary/generate", post(generate_itinerary))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let listener = TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {addr}: {err}"));
    tracing::info!(%addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

/// SIGINT (Ctrl-C) always; SIGTERM on Unix so `docker stop` is graceful.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install SIGINT handler");
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(err) => {
                tracing::warn!(error = %err, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("received SIGINT, shutting down"),
        _ = terminate => tracing::info!("received SIGTERM, shutting down"),
    }
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "peapod-compute",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn nearest_place(
    AppJson(req): AppJson<NearestPlaceRequest>,
) -> Result<Json<NearestPlaceResponse>, AppError> {
    if req.radius_m < 0.0 {
        return Err(AppError::bad_request("radius_m must not be negative"));
    }
    let hit = geo::nearest_place(&req.location, &req.places, req.radius_m);
    Ok(Json(match hit {
        Some((place_id, distance_m)) => NearestPlaceResponse {
            place_id: Some(place_id),
            distance_m: Some(distance_m),
        },
        None => NearestPlaceResponse { place_id: None, distance_m: None },
    }))
}

async fn activity(AppJson(req): AppJson<ActivitySpeedRequest>) -> impl IntoResponse {
    Json(geo::classify_activity(req.speed))
}

async fn reconstruct_trip(
    AppJson(req): AppJson<ReconstructTripRequest>,
) -> Result<Json<ReconstructTripResponse>, AppError> {
    if req.pings.len() > trips::MAX_PINGS {
        return Err(AppError::bad_request(format!(
            "pings must not exceed {} entries",
            trips::MAX_PINGS
        )));
    }
    Ok(Json(ReconstructTripResponse { trip: trips::reconstruct_last_trip(&req.pings) }))
}

async fn evaluate_decision(
    AppJson(req): AppJson<EvaluateDecisionRequest>,
) -> Json<peapod_compute::models::EvaluateDecisionResponse> {
    Json(decisions::evaluate(&req))
}

async fn level(AppJson(req): AppJson<LevelRequest>) -> Result<impl IntoResponse, AppError> {
    if req.xp < 0 {
        return Err(AppError::bad_request("xp must not be negative"));
    }
    Ok(Json(progression::level_view(req.xp)?))
}

async fn garden_growth(AppJson(req): AppJson<GardenGrowthRequest>) -> Json<GardenGrowthResponse> {
    Json(GardenGrowthResponse { growth: progression::garden_growth(&req.entries, req.now_ms) })
}

async fn achievements(
    AppJson(req): AppJson<AchievementRequest>,
) -> Json<peapod_compute::models::AchievementResponse> {
    Json(progression::compute_achievement_groups(&req))
}

async fn wallet_split(AppJson(req): AppJson<SplitRequest>) -> Json<peapod_compute::models::SplitResponse> {
    Json(wallet::split_amount(req))
}

async fn generate_itinerary(
    AppJson(req): AppJson<ItineraryRequest>,
) -> Result<Json<peapod_compute::models::ItineraryResponse>, AppError> {
    Ok(Json(itinerary::generate_itinerary(&req)?))
}
