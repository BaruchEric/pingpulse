//! One-shot bounded path tracing via `trippy-core`.
//!
//! On request the client runs a bounded ICMP traceroute to a target and
//! returns per-hop statistics. It is deliberately bounded (capped rounds plus
//! a hard wall-clock timeout) because it runs inside the long-lived daemon,
//! not an interactive session.

use std::net::{IpAddr, ToSocketAddrs};
use std::str::FromStr;
use std::time::Duration;

use serde::Serialize;
use trippy_core::{Builder, PrivilegeMode, Protocol};

/// Maximum time-to-live (hops) to probe.
const MAX_TTL: u8 = 30;
/// Hard wall-clock ceiling for a single trace.
const TRACE_TIMEOUT: Duration = Duration::from_secs(30);
/// Lower clamp for the requested number of rounds (0 would mean "unbounded").
const MIN_ROUNDS: u8 = 1;
/// Upper clamp for the requested number of rounds.
const MAX_ROUNDS: u8 = 10;

/// Per-hop statistics for a single time-to-live within a trace.
#[derive(Debug, Serialize)]
pub struct TraceHop {
    pub ttl: u8,
    pub addr: Option<String>,
    pub loss_pct: f64,
    pub samples: usize,
    pub last_ms: Option<f64>,
    pub avg_ms: f64,
    pub best_ms: Option<f64>,
    pub worst_ms: Option<f64>,
    pub stddev_ms: f64,
    pub jitter_ms: Option<f64>,
}

/// Resolve `target` to an [`IpAddr`], accepting either a literal IP or a
/// hostname (resolved via the system resolver).
fn resolve(target: &str) -> anyhow::Result<IpAddr> {
    if let Ok(ip) = IpAddr::from_str(target) {
        return Ok(ip);
    }
    (target, 0u16)
        .to_socket_addrs()?
        .next()
        .map(|sa| sa.ip())
        .ok_or_else(|| anyhow::anyhow!("could not resolve host: {target}"))
}

fn map_hop(hop: &trippy_core::Hop) -> TraceHop {
    TraceHop {
        ttl: hop.ttl(),
        addr: hop.addrs().next().map(ToString::to_string),
        loss_pct: hop.loss_pct(),
        samples: hop.samples().len(),
        last_ms: hop.last_ms(),
        avg_ms: hop.avg_ms(),
        best_ms: hop.best_ms(),
        worst_ms: hop.worst_ms(),
        stddev_ms: hop.stddev_ms(),
        jitter_ms: hop.jitter_ms(),
    }
}

/// Run a bounded ICMP path trace to `target`, returning per-hop stats.
///
/// `rounds` is clamped to `[MIN_ROUNDS, MAX_ROUNDS]` — a value of zero would
/// otherwise mean "unbounded" in `trippy-core`. The whole trace is additionally
/// capped by [`TRACE_TIMEOUT`]. The blocking tracer runs on a dedicated
/// blocking thread so it never stalls the async runtime.
///
/// # Errors
/// Returns an error if `target` cannot be resolved, the tracer fails to
/// build or run (e.g. insufficient privileges for raw sockets), or the trace
/// exceeds [`TRACE_TIMEOUT`].
pub async fn run_trace(target: &str, rounds: u8) -> anyhow::Result<Vec<TraceHop>> {
    let rounds = rounds.clamp(MIN_ROUNDS, MAX_ROUNDS);
    let target = target.to_string();

    let handle = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<TraceHop>> {
        let addr = resolve(&target)?;
        // Raw sockets require root on macOS/Linux, but the daemon runs unprivileged
        // (its ICMP probes use datagram sockets, like `ping`). Unprivileged mode uses
        // ICMP datagram sockets too. Windows has no unprivileged mode and its service
        // runs elevated, so keep Privileged there.
        #[cfg(windows)]
        let privilege_mode = PrivilegeMode::Privileged;
        #[cfg(not(windows))]
        let privilege_mode = PrivilegeMode::Unprivileged;
        let tracer = Builder::new(addr)
            .protocol(Protocol::Icmp)
            .privilege_mode(privilege_mode)
            .max_rounds(Some(usize::from(rounds)))
            .max_ttl(MAX_TTL)
            .build()
            .map_err(|e| anyhow::anyhow!("failed to build tracer: {e}"))?;
        tracer
            .run()
            .map_err(|e| anyhow::anyhow!("trace failed: {e}"))?;
        Ok(tracer.snapshot().hops().iter().map(map_hop).collect())
    });

    match tokio::time::timeout(TRACE_TIMEOUT, handle).await {
        Ok(joined) => joined.map_err(|e| anyhow::anyhow!("trace task failed: {e}"))?,
        Err(_) => anyhow::bail!("trace timed out after {}s", TRACE_TIMEOUT.as_secs()),
    }
}
