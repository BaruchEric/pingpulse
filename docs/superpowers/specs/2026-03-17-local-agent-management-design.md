# Local Agent Management API & Dashboard Integration

**Date:** 2026-03-17
**Status:** Approved

## Overview

Add a persistent local management HTTP server (`pingpulse agent`) to the PingPulse client binary. This enables the dashboard at `/clients` to detect locally-installed clients and provide full lifecycle control: start, stop, restart, remove service, and full uninstall — directly from the browser.

## Architecture

### Agent as Service Manager (Approach 1)

`pingpulse agent` runs as its own system service alongside the existing daemon service. Two independent services, one binary:

- **Agent** (management plane): Always-on HTTP server on `127.0.0.1:9111`. Manages the daemon via OS service commands.
- **Daemon** (data plane): Existing WebSocket-based monitoring client. Unchanged.

The agent is ultra-lightweight — just an HTTP listener + process management. It reads `~/.pingpulse/config.toml` to know the `client_id`, `server_url`, and other metadata.

### Service Identity

| Platform | Daemon Service | Agent Service |
|----------|---------------|---------------|
| macOS | `~/Library/LaunchAgents/ca.beric.pingpulse.plist` | `~/Library/LaunchAgents/ca.beric.pingpulse.agent.plist` |
| Linux | `/etc/systemd/system/pingpulse.service` | `/etc/systemd/system/pingpulse-agent.service` |
| Windows | `PingPulse` Windows Service | `PingPulseAgent` Windows Service |

Both services are installed by `install.sh` / `install.ps1`. Both start on boot. Agent survives daemon stop/restart.

## Local HTTP API

**Base:** `http://127.0.0.1:9111`

**Security:**
- Binds to `127.0.0.1` only (not exposed to network)
- CORS `Access-Control-Allow-Origin` restricted to the PingPulse server domain (read from `config.toml`'s `server_url`)
- No additional auth — localhost access implies machine-level trust

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Agent + daemon status. Returns `{ client_id, client_name, location, server_url, daemon_running, agent_version, uptime_s }` |
| `POST` | `/daemon/start` | Starts the daemon service via OS commands |
| `POST` | `/daemon/stop` | Stops the daemon service via OS commands |
| `POST` | `/daemon/restart` | Stop then start |
| `POST` | `/service/remove` | Tier 1: Stops daemon, removes daemon service files, keeps `~/.pingpulse/` intact. Agent stays running. |
| `POST` | `/service/uninstall` | Tier 2: Full cleanup — stops daemon, removes both services, deletes `~/.pingpulse/`, deletes server record, agent self-terminates. |
| `GET` | `/logs` | Returns last 100 lines from today's log in `~/.pingpulse/logs/` |
| `GET` | `/config` | Returns current `config.toml` contents (sanitized — `client_secret` redacted) |

**Response format:** All JSON. Errors return `{ "error": "message" }` with appropriate status codes.

**Self-termination on uninstall:** The `/service/uninstall` endpoint responds with `200 OK` first, then schedules cleanup on a 1.5s delay so the HTTP response completes before the agent removes itself.

## Dashboard Integration

### Detection Flow

1. On `/clients` page load, dashboard fires `fetch("http://localhost:9111/status")` with a 2s timeout
2. If it responds: local agent detected, render the Local Client panel above the clients table
3. If it fails: no local agent, page looks exactly as it does today

### Local Client Panel

Rendered at the top of `/clients`, above the existing all-clients table. The table below is **unchanged**.

```
┌─────────────────────────────────────────────────────────┐
│  Local Client: Home Office                              │
│  Toronto, CA · client_id: abc123                        │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐            │
│  │ ● Running │  │ Connected│  │ Agent v1.2 │            │
│  └──────────┘  └──────────┘  └────────────┘            │
│                                                         │
│  [Start] [Stop] [Restart]   [View Logs]                │
│                                                         │
│  ── Danger Zone ──────────────────────────────────────  │
│  [Remove Service]  [Full Uninstall]                     │
└─────────────────────────────────────────────────────────┘
```

**Behaviors:**
- **Start/Stop/Restart** call `POST localhost:9111/daemon/{action}`, then re-fetch `/status`
- **View Logs** opens a slide-out/modal with last 100 log lines from `GET /logs`
- **Remove Service** shows confirm: "This will stop and remove the daemon service. Config and logs are preserved. Continue?"
- **Full Uninstall** shows stricter confirm: "This will remove all PingPulse services, config, and logs from this machine and delete the client from the server. This cannot be undone. Continue?"
- After full uninstall, panel disappears (agent gone, fetch fails) and client removed from server table
- Status polls `localhost:9111/status` every 5s while panel is visible

**New component:** `LocalClientPanel.tsx` — self-contained, used only in `Clients.tsx`.

## Uninstall Flows

### Tier 1: Remove Service (`POST /service/remove`)

1. Agent stops the daemon service (`launchctl unload` / `systemctl stop`)
2. Agent removes daemon service file (plist / unit)
3. Agent responds `200 OK`
4. Agent stays running — config, logs, agent service all preserved
5. Dashboard re-fetches `/status` → shows `daemon_running: false`
6. User can re-start the daemon later with `[Start]` (re-creates service + starts)

### Tier 2: Full Uninstall (`POST /service/uninstall`)

1. Agent stops the daemon service
2. Agent removes daemon service file
3. Agent calls server API: `DELETE /api/clients/:client_id/self` (authenticates with `client_secret`)
4. Agent responds `200 OK` to the dashboard
5. Agent schedules delayed cleanup (1.5s):
   a. Remove agent service file
   b. Delete `~/.pingpulse/` (config, logs)
   c. Exit process
6. Dashboard: fetch to `localhost:9111` fails → panel disappears
7. Dashboard: refreshes client list from server → deleted client gone from table

**Server-side self-deletion:** New endpoint `DELETE /api/clients/:id/self` authenticates with the client secret (not admin JWT). The agent can delete its own server record without needing admin credentials.

**Edge case:** If the server is unreachable during full uninstall, the agent still cleans up locally but warns: `{ "ok": true, "warnings": ["Server record not deleted — server unreachable"] }`. The dashboard surfaces this warning.

## Rust Implementation

### New Subcommand

```rust
Commands::Agent {
    /// Port for the local management API (default: 9111)
    #[arg(long, default_value = "9111")]
    port: u16,
}
```

### Dependencies

- `axum` for HTTP server (tokio already in the project, axum is lightweight and ergonomic)
- Existing `service` module extended with agent-specific functions

### Service Module Additions

- `service::install_agent(binary_path)` — creates the agent plist/unit
- `service::stop_agent()` — stops the agent service
- `service::uninstall_agent()` — stops + removes agent service files
- `service::uninstall_all(binary_path)` — stops both, removes both service files
- `service::cleanup_data()` — deletes `~/.pingpulse/` directory

### Agent Plist (macOS)

- Label: `ca.beric.pingpulse.agent`
- Program: `/path/to/pingpulse agent`
- RunAtLoad: true
- KeepAlive: true (restarts if it crashes)

## Installation Changes

Updated flow in `install.sh` / `install.ps1`:

1. Download binary (unchanged)
2. Register with server (unchanged)
3. Install daemon service (unchanged)
4. **Install agent service (NEW)**
5. **Start both services**

## Server-Side Changes

### New Endpoint: `DELETE /api/clients/:id/self`

- Authenticates via `Authorization: Bearer <client_secret>` (not admin JWT)
- Validates the secret matches the client's `secret_hash`
- Deletes the client and all associated data (same as existing `DELETE /api/clients/:id`)
- Used by the agent during full uninstall

## Files to Create/Modify

### Rust (client/)
- `client/src/main.rs` — add `Agent` command variant
- `client/src/agent.rs` — NEW: axum HTTP server, route handlers, CORS setup
- `client/src/service.rs` — add agent service install/stop/uninstall functions
- `client/Cargo.toml` — add `axum` dependency

### Worker (worker/)
- `worker/src/api/clients.ts` — add `DELETE /:id/self` endpoint with client-secret auth
- `worker/src/index.ts` — mount the new route

### Dashboard (worker/dashboard/)
- `worker/dashboard/src/components/LocalClientPanel.tsx` — NEW: local agent panel
- `worker/dashboard/src/pages/Clients.tsx` — import and render `LocalClientPanel` above table
- `worker/dashboard/src/lib/local-agent.ts` — NEW: fetch helpers for localhost:9111 API

### Install Scripts
- `install.sh` — add agent service installation
- `install.ps1` — add agent service installation
