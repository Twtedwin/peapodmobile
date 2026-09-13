//! # Peapod compute library
//!
//! ## Purpose
//! The stateless maths behind Peapod: spherical geometry, GPS trip
//! reconstruction, Decide Together aggregation, XP/garden/achievements,
//! exact integer money splitting, and itinerary generation. Every threshold
//! is sourced from `packages/shared/data/rules/*.json` (embedded at compile
//! time in [`rules`]); every wire DTO lives in [`models`].
//!
//! ## Inputs
//! JSON request bodies matching `packages/shared/schemas/compute.schema.json`,
//! deserialised into the types in [`models`]. Nothing here reads a clock, a
//! database, or a user session.
//!
//! ## Outputs
//! JSON response bodies of those same DTOs, plus [`error::AppError`] as the
//! only failure type (`400` for bad input, `500` for bugs).
//!
//! ## Who calls this
//! - `src/main.rs` (the HTTP server) on every request.
//! - Unit tests in each module.
//! - `services/api` over the private network; it also ships a TypeScript twin
//!   of every algorithm here as a fallback, so a behavioural change must be
//!   mirrored in `packages/shared/src/algorithms/`.

pub mod error;
pub mod models;
pub mod rules;
pub mod geo;
pub mod trips;
pub mod decisions;
pub mod progression;
pub mod wallet;
pub mod itinerary;
