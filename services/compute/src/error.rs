//! # Error type for the compute service
//!
//! ## Purpose
//! Gives every route one way to fail and one wire shape for that failure, so
//! the only caller (`services/api`) can branch on an HTTP status code and read
//! a human-readable reason without parsing anything service-specific.
//!
//! ## Inputs
//! - `AppError::BadRequest(msg)`, raised by handlers when a payload parses as
//!   JSON but violates the contract in `packages/shared/schemas/compute.schema.json`
//!   (a negative radius, an empty `shares` array, `days` outside 1..=30, ...).
//! - `AppError::Internal(msg)`, raised when something that should be impossible
//!   happened (e.g. a rule file that parsed at start-up but is missing a level).
//! - `axum::extract::rejection::JsonRejection`, produced automatically when the
//!   request body is not valid JSON or does not match the DTO. Converted into
//!   `BadRequest` by the `From` impl below.
//!
//! ## Outputs
//! A JSON body of exactly `{"error": "<message>"}` with:
//! - `400 Bad Request` for `BadRequest` (including all body rejections; note
//!   axum's own default for a shape mismatch is `422`, and this type
//!   deliberately normalises that to `400` because the contract says so).
//! - `500 Internal Server Error` for `Internal`.
//!
//! ## Who calls this
//! Only `services/api`, over a private network. There is no browser client and
//! no auth layer, so error messages are safe to be descriptive; they never
//! contain user data beyond what the caller itself just sent.

use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Every failure this service can return to its caller.
///
/// Deliberately tiny: the service is stateless and has no database, no auth and
/// no upstream dependencies, so "the caller sent something wrong" and "we have
/// a bug" are the only two categories that exist.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// The request was syntactically or semantically invalid. Always `400`.
    #[error("{0}")]
    BadRequest(String),

    /// A bug or an impossible state. Always `500`.
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    /// Convenience constructor so handlers can write
    /// `AppError::bad_request("days must be between 1 and 30")` without an
    /// explicit `.to_string()` at every call site.
    pub fn bad_request(msg: impl Into<String>) -> Self {
        AppError::BadRequest(msg.into())
    }

    /// Convenience constructor for the `500` case.
    pub fn internal(msg: impl Into<String>) -> Self {
        AppError::Internal(msg.into())
    }

    /// The HTTP status this error maps to.
    ///
    /// Kept as a separate method (rather than inline in `into_response`) so the
    /// mapping can be unit tested without building a whole `Response`.
    fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    /// Renders the error as `{"error": "..."}`.
    ///
    /// Internal errors are logged at `error` level here (the one place they all
    /// funnel through) so a `500` is never silent in the container logs.
    fn into_response(self) -> Response {
        let status = self.status();
        let message = self.to_string();
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = %message, "compute request failed");
        } else {
            tracing::debug!(error = %message, "rejected compute request");
        }
        (status, Json(json!({ "error": message }))).into_response()
    }
}

impl From<JsonRejection> for AppError {
    /// Turns axum's body-extraction failures into a `400`.
    ///
    /// `JsonRejection` covers a missing/incorrect `Content-Type`, malformed
    /// JSON, and a well-formed body whose fields do not match the DTO (for
    /// example `"stance": "yes"`, which is not one of `want|maybe|no`).
    /// `body_text()` is the human-readable explanation axum would have sent.
    fn from(rejection: JsonRejection) -> Self {
        AppError::BadRequest(rejection.body_text())
    }
}

impl From<anyhow::Error> for AppError {
    /// Anything that bubbles up as an `anyhow::Error` is by definition not the
    /// caller's fault (the only `anyhow` users in this service are internal
    /// helpers such as the optional travel-dataset loader), so it becomes a
    /// `500`.
    fn from(err: anyhow::Error) -> Self {
        AppError::Internal(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_input_is_400_and_bugs_are_500() {
        assert_eq!(
            AppError::bad_request("nope").status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            AppError::internal("boom").status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn message_round_trips_through_display() {
        // The Display impl is what ends up in the {"error": ...} body, so it
        // must be the raw message with no wrapping or prefixes.
        assert_eq!(AppError::bad_request("days must be 1..30").to_string(), "days must be 1..30");
    }
}
