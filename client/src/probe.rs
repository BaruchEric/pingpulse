#![allow(dead_code)]

use anyhow::Result;
use reqwest::Client as HttpClient;
use std::net::IpAddr;
use std::time::{Duration, Instant};
use surge_ping::{Client as PingClient, Config as PingConfig, PingIdentifier, PingSequence, ICMP};
use tracing::{debug, warn};

use crate::store::ProbeRecord;

pub struct ProbeEngine {
    ping_client: Option<PingClient>, // None if ICMP socket creation failed
    http_client: HttpClient,
}

#[derive(Debug, Clone)]
pub struct IcmpTarget {
    pub addr: IpAddr,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct HttpTarget {
    pub url: String,
}

impl ProbeEngine {
    pub fn new() -> Result<Self> {
        let ping_config = PingConfig::builder().kind(ICMP::V4).build();
        let ping_client = match PingClient::new(&ping_config) {
            Ok(c) => Some(c),
            Err(e) => {
                warn!(error = %e, "ICMP socket creation failed (need root/CAP_NET_RAW?) — ICMP probes disabled");
                None
            }
        };
        let http_client = HttpClient::builder()
            .timeout(Duration::from_millis(5000))
            .build()?;
        Ok(Self {
            ping_client,
            http_client,
        })
    }

    pub async fn probe_icmp(&self, target: &IcmpTarget, timeout_ms: u64) -> ProbeRecord {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let timeout = Duration::from_millis(timeout_ms);

        let ping_client = match &self.ping_client {
            Some(c) => c,
            None => {
                return ProbeRecord {
                    seq_id: 0,
                    probe_type: "icmp".into(),
                    target: target.label.clone(),
                    timestamp: now_ms,
                    rtt_ms: None,
                    status_code: None,
                    status: "error".into(),
                    jitter_ms: None,
                };
            }
        };

        let mut pinger = ping_client.pinger(target.addr, PingIdentifier(rand::random())).await;
        pinger.timeout(timeout);

        let start = Instant::now();
        match pinger.ping(PingSequence(0), &[0u8; 56]).await {
            Ok((_reply, rtt)) => {
                let rtt_ms: f64 = rtt.as_secs_f64() * 1000.0;
                debug!(target = %target.label, rtt_ms, "ICMP probe ok");
                ProbeRecord {
                    seq_id: 0,
                    probe_type: "icmp".into(),
                    target: target.label.clone(),
                    timestamp: now_ms,
                    rtt_ms: Some(rtt_ms),
                    status_code: None,
                    status: "ok".into(),
                    jitter_ms: None,
                }
            }
            Err(e) => {
                let elapsed = start.elapsed();
                let status = if elapsed >= timeout { "timeout" } else { "error" };
                warn!(target = %target.label, error = %e, status, "ICMP probe failed");
                ProbeRecord {
                    seq_id: 0,
                    probe_type: "icmp".into(),
                    target: target.label.clone(),
                    timestamp: now_ms,
                    rtt_ms: None,
                    status_code: None,
                    status: status.into(),
                    jitter_ms: None,
                }
            }
        }
    }

    pub async fn probe_http(&self, target: &HttpTarget, timeout_ms: u64) -> ProbeRecord {
        let now_ms = chrono::Utc::now().timestamp_millis();

        let client = HttpClient::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .unwrap_or_else(|_| self.http_client.clone());

        let start = Instant::now();
        match client.head(&target.url).send().await {
            Ok(resp) => {
                let rtt_ms = start.elapsed().as_secs_f64() * 1000.0;
                let status_code = resp.status().as_u16() as i32;
                debug!(target = %target.url, rtt_ms, status_code, "HTTP probe ok");
                ProbeRecord {
                    seq_id: 0,
                    probe_type: "http".into(),
                    target: target.url.clone(),
                    timestamp: now_ms,
                    rtt_ms: Some(rtt_ms),
                    status_code: Some(status_code),
                    status: "ok".into(),
                    jitter_ms: None,
                }
            }
            Err(e) => {
                let elapsed = start.elapsed();
                let status = if e.is_timeout() || elapsed >= Duration::from_millis(timeout_ms) {
                    "timeout"
                } else {
                    "error"
                };
                warn!(target = %target.url, error = %e, status, "HTTP probe failed");
                ProbeRecord {
                    seq_id: 0,
                    probe_type: "http".into(),
                    target: target.url.clone(),
                    timestamp: now_ms,
                    rtt_ms: None,
                    status_code: None,
                    status: status.into(),
                    jitter_ms: None,
                }
            }
        }
    }
}
