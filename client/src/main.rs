#![deny(warnings, clippy::all)]
#![warn(clippy::pedantic)]
#![allow(clippy::module_name_repetitions)]

mod agent;
mod config;
mod logger;
mod messages;
mod service;
mod speed_test;
mod probe;
mod store;
mod websocket;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "pingpulse",
    version,
    about = "PingPulse network monitor daemon"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Exchange a registration token for client credentials
    Register {
        /// Single-use token from the admin dashboard
        #[arg(long)]
        token: String,
        /// Human-readable name for this client (e.g., "Home Office")
        #[arg(long)]
        name: String,
        /// Location label (e.g., "Toronto, CA")
        #[arg(long)]
        location: String,
        /// Base URL of the `PingPulse` server (e.g., <https://ping.beric.ca>)
        #[arg(long)]
        server: String,
    },
    /// Start the `PingPulse` daemon
    Start {
        /// Run in the foreground instead of installing as a service
        #[arg(long)]
        foreground: bool,
    },
    /// Stop the `PingPulse` daemon
    Stop,
    /// Check the daemon status
    Status,
    /// Completely uninstall `PingPulse` (stop service, remove binary, config, and Login Item)
    Uninstall,
    /// Run the local management API server (standalone, for development)
    Agent {
        /// Port for the local management API
        #[arg(long, default_value = "9111")]
        port: u16,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Register {
            token,
            name,
            location,
            server,
        } => {
            if let Err(e) = cmd_register(&server, &token, &name, &location).await {
                eprintln!("Registration failed: {e}");
                std::process::exit(1);
            }
        }
        Commands::Start { foreground } => {
            if foreground {
                if let Err(e) = cmd_start_foreground().await {
                    eprintln!("Daemon error: {e}");
                    std::process::exit(1);
                }
            } else if let Err(e) = cmd_start_service() {
                eprintln!("Service install failed: {e}");
                std::process::exit(1);
            }
        }
        Commands::Stop => {
            if let Err(e) = service::stop() {
                eprintln!("Failed to stop: {e}");
                std::process::exit(1);
            }
        }
        Commands::Status => match service::status() {
            Ok(true) => println!("PingPulse is running"),
            Ok(false) => println!("PingPulse is not running"),
            Err(e) => {
                eprintln!("Status check failed: {e}");
                std::process::exit(1);
            }
        },
        Commands::Uninstall => {
            service::uninstall();
        }
        Commands::Agent { port } => {
            if let Err(e) = agent::run(port, None).await {
                eprintln!("Agent error: {e}");
                std::process::exit(1);
            }
        }
    }
}

async fn cmd_register(server: &str, token: &str, name: &str, location: &str) -> anyhow::Result<()> {
    #[derive(serde::Deserialize)]
    struct RegisterResponse {
        client_id: String,
        client_secret: String,
        ws_url: String,
    }

    if config::Config::config_path().exists() {
        println!("Existing config found — cleaning up old installation...");
        let _ = service::stop();
        let _ = service::cleanup_data();
        println!("Old installation removed.");
    }

    println!("Registering with {server}...");

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{server}/api/auth/register"))
        .json(&serde_json::json!({
            "token": token,
            "name": name,
            "location": location,
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let body: serde_json::Value = resp.json().await?;
        anyhow::bail!(
            "Server returned error: {}",
            body.get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("unknown error")
        );
    }

    let reg: RegisterResponse = resp.json().await?;
    let config = config::Config::new_from_registration(
        server.to_string(),
        reg.ws_url,
        reg.client_id.clone(),
        reg.client_secret,
    );

    config.save().await?;

    println!("Registered successfully!");
    println!("  Client ID: {}", reg.client_id);
    println!(
        "  Config saved to: {}",
        config::Config::config_path().display()
    );
    println!();
    println!("Start the daemon with: pingpulse start");

    Ok(())
}

async fn cmd_start_foreground() -> anyhow::Result<()> {
    let config = config::Config::load().await?;

    logger::init(
        config::Config::logs_dir(),
        &config.logging.level,
        config.logging.retention_days,
    );

    tracing::info!(event = "daemon_starting", client_id = %config.server.client_id);

    // Spawn the local management agent alongside the daemon
    let agent_config = config.clone();
    let agent_handle = tokio::spawn(async move {
        if let Err(e) = agent::run(9111, Some(agent_config)).await {
            tracing::error!(event = "agent_failed", error = %e);
        }
    });

    let ws_result = websocket::run(config).await;

    agent_handle.abort();
    ws_result
}

fn cmd_start_service() -> anyhow::Result<()> {
    let binary = std::env::current_exe()?
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Binary path is not valid UTF-8"))?
        .to_string();

    service::install_and_start(&binary)
}
