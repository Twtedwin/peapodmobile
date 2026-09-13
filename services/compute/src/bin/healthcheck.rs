//! Tiny liveness probe used as Docker `HEALTHCHECK CMD /app/healthcheck`.
//!
//! ## Purpose
//! Confirm the compute process is accepting TCP connections on `PORT`.
//! Docker only needs a zero/non-zero exit code; it does not read stdout.
//!
//! ## Inputs
//! `PORT` environment variable, default `8082` (the service's published port).
//!
//! ## Outputs
//! Process exit `0` when `127.0.0.1:PORT` accepts a TCP connect within 2
//! seconds, otherwise exit `1`.
//!
//! ## Who calls this
//! Docker's healthcheck (see `services/compute/Dockerfile` and
//! `docker-compose.yml`). Not an HTTP client: a TCP connect is enough to
//! prove the listener is bound, and it keeps this binary free of the axum
//! stack so the runtime image stays small.
//!
//! A TCP connect (rather than `GET /health`) is deliberate. If the process
//! is wedged inside a handler the listener may still accept; that is the
//! same signal `wget` would give, and it avoids pulling curl/wget into the
//! slim image.

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::ExitCode;
use std::time::Duration;

/// How long we wait for the listener to accept. 2 s is well under compose's
/// 3 s `timeout:` and well over a local accept on a healthy process.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

fn main() -> ExitCode {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8082".to_string());
    let host_port = format!("127.0.0.1:{port}");
    let addrs = match host_port.to_socket_addrs() {
        Ok(iter) => iter.collect::<Vec<SocketAddr>>(),
        Err(_) => return ExitCode::from(1),
    };
    let Some(addr) = addrs.into_iter().next() else {
        return ExitCode::from(1);
    };
    match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
        Ok(_) => ExitCode::SUCCESS,
        Err(_) => ExitCode::from(1),
    }
}
