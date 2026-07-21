//! One-shot bounded path tracing via `trippy-core`.
//!
//! On request the client runs a bounded traceroute to a target and returns
//! per-hop statistics. It is deliberately bounded (capped rounds plus a hard
//! wall-clock timeout) because it runs inside the long-lived daemon, not an
//! interactive session. Optionally discovers multiple ECMP paths (flows).

use std::net::{IpAddr, ToSocketAddrs};
use std::str::FromStr;
use std::time::Duration;

use serde::Serialize;
use trippy_core::{Builder, PortDirection, PrivilegeMode, Protocol};

/// Maximum time-to-live (hops) to probe.
const MAX_TTL: u8 = 30;
/// Hard wall-clock ceiling for a single trace (higher for multipath, which runs
/// several traces back to back).
const TRACE_TIMEOUT: Duration = Duration::from_secs(45);
/// Lower clamp for the requested number of rounds (0 would mean "unbounded").
const MIN_ROUNDS: u8 = 1;
/// Upper clamp for the requested number of rounds.
const MAX_ROUNDS: u8 = 10;
/// Default destination port for TCP traces (HTTPS).
const DEFAULT_TCP_PORT: u16 = 443;
/// Default destination port for UDP traces (classic traceroute base port).
const DEFAULT_UDP_PORT: u16 = 33434;
/// Number of destination-port probes to fan out for ECMP path discovery.
const MULTIPATH_PROBES: u8 = 6;
/// Rounds per probe during multipath discovery (kept low; many probes run).
const MULTIPATH_ROUNDS_PER_PROBE: u8 = 2;

/// Map a protocol string ("icmp" | "udp" | "tcp") to a tracing protocol and its
/// normalized label. Unknown/absent values fall back to ICMP.
fn resolve_protocol(protocol: Option<&str>) -> (Protocol, &'static str) {
    match protocol.map(str::to_ascii_lowercase).as_deref() {
        Some("udp") => (Protocol::Udp, "udp"),
        Some("tcp") => (Protocol::Tcp, "tcp"),
        _ => (Protocol::Icmp, "icmp"),
    }
}

/// Per-hop statistics for a single time-to-live within a trace flow.
#[derive(Debug, Serialize)]
pub struct TraceHop {
    /// Which ECMP flow this hop belongs to (0 for single-path traces).
    pub flow_id: u32,
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

fn map_hop(hop: &trippy_core::Hop, flow_id: u32) -> TraceHop {
    TraceHop {
        flow_id,
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

/// Build, run, and snapshot one bounded single-path trace, returning its hops
/// cloned out of the tracer state.
fn run_single(
    addr: IpAddr,
    proto: Protocol,
    port_dir: PortDirection,
    rounds: u8,
    privilege_mode: PrivilegeMode,
) -> anyhow::Result<Vec<trippy_core::Hop>> {
    let tracer = Builder::new(addr)
        .protocol(proto)
        .privilege_mode(privilege_mode)
        .max_rounds(Some(usize::from(rounds)))
        .max_ttl(MAX_TTL)
        .port_direction(port_dir)
        .build()
        .map_err(|e| anyhow::anyhow!("failed to build tracer: {e}"))?;
    tracer
        .run()
        .map_err(|e| anyhow::anyhow!("trace failed: {e}"))?;
    Ok(tracer.snapshot().hops().to_vec())
}

/// Run a bounded path trace to `target`, returning the normalized protocol
/// label and per-hop stats.
///
/// `protocol` selects the transport ("icmp" | "udp" | "tcp", default ICMP);
/// UDP/TCP trace to a fixed destination `port` (default 33434 / 443). When
/// `multipath` is set, discovers distinct ECMP paths (flows) by tracing to
/// several UDP destination ports — the component ECMP routers hash on — and
/// keeping each distinct path as a `flow_id`. (Trippy's own Paris/Dublin ECMP
/// strategies need raw IP-header access and don't work on the unprivileged
/// daemon, so this fan-out approach is used instead.) `rounds` is clamped to a
/// sane range; the whole trace is additionally capped by [`TRACE_TIMEOUT`]. The
/// blocking tracer runs on a dedicated blocking thread so it never stalls the
/// async runtime.
///
/// # Errors
/// Returns an error if `target` cannot be resolved, the tracer fails to build
/// or run (e.g. insufficient privileges for raw sockets), or the trace exceeds
/// [`TRACE_TIMEOUT`].
pub async fn run_trace(
    target: &str,
    rounds: u8,
    protocol: Option<String>,
    port: Option<u16>,
    multipath: bool,
) -> anyhow::Result<(String, Vec<TraceHop>)> {
    let target = target.to_string();
    let (proto, label) = if multipath {
        (Protocol::Udp, "udp")
    } else {
        resolve_protocol(protocol.as_deref())
    };
    let rounds = rounds.clamp(MIN_ROUNDS, MAX_ROUNDS);

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

        if multipath {
            // Fan out over destination ports; ECMP routers hash the 5-tuple
            // (incl. dest port), so different ports may traverse different paths.
            // Keep only distinct paths (by address sequence) as separate flows.
            let mut result: Vec<TraceHop> = Vec::new();
            let mut sigs: Vec<Vec<Option<String>>> = Vec::new();
            for i in 0..MULTIPATH_PROBES {
                let dest_port = DEFAULT_UDP_PORT.saturating_add(u16::from(i));
                let hops = run_single(
                    addr,
                    Protocol::Udp,
                    PortDirection::new_fixed_dest(dest_port),
                    MULTIPATH_ROUNDS_PER_PROBE,
                    privilege_mode,
                )?;
                let sig: Vec<Option<String>> = hops
                    .iter()
                    .map(|h| h.addrs().next().map(ToString::to_string))
                    .collect();
                if sig.iter().all(Option::is_none) {
                    continue; // no responses this probe
                }
                if sigs.contains(&sig) {
                    continue; // path already recorded
                }
                let flow_id = u32::try_from(sigs.len()).unwrap_or(u32::MAX);
                sigs.push(sig);
                result.extend(hops.iter().map(|h| map_hop(h, flow_id)));
            }
            if result.is_empty() {
                // No distinct path surfaced — return a single plain UDP trace.
                let hops = run_single(
                    addr,
                    Protocol::Udp,
                    PortDirection::new_fixed_dest(DEFAULT_UDP_PORT),
                    rounds,
                    privilege_mode,
                )?;
                result.extend(hops.iter().map(|h| map_hop(h, 0)));
            }
            Ok(result)
        } else {
            let port_dir = match proto {
                Protocol::Udp => PortDirection::new_fixed_dest(port.unwrap_or(DEFAULT_UDP_PORT)),
                Protocol::Tcp => PortDirection::new_fixed_dest(port.unwrap_or(DEFAULT_TCP_PORT)),
                Protocol::Icmp => PortDirection::None,
            };
            let hops = run_single(addr, proto, port_dir, rounds, privilege_mode)?;
            Ok(hops.iter().map(|h| map_hop(h, 0)).collect())
        }
    });

    let hops = match tokio::time::timeout(TRACE_TIMEOUT, handle).await {
        Ok(joined) => joined.map_err(|e| anyhow::anyhow!("trace task failed: {e}"))??,
        Err(_) => anyhow::bail!("trace timed out after {}s", TRACE_TIMEOUT.as_secs()),
    };
    Ok((label.to_string(), hops))
}
