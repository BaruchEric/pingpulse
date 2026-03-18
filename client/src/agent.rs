use std::net::SocketAddr;
use anyhow::Result;
use crate::config::Config;

pub async fn run(port: u16) -> Result<()> {
    let config = Config::load().await?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!(event = "agent_starting", %addr, client_id = %config.server.client_id);
    println!("Agent listening on {addr}");
    tokio::signal::ctrl_c().await?;
    Ok(())
}
