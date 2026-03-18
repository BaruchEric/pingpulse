# Register Client One-Liner Install

## Summary

Replace the current "copy a CLI command" registration flow with a one-liner install script that downloads the pingpulse binary from GitHub Releases, registers the client, and starts it as a system service — all in one command.

## Current State

The "Register Client" button on `/clients` generates a token and shows `pingpulse register --token TOKEN`. The admin must manually download the binary, copy the command, SSH into the target machine, and run multiple commands to register and start the client.

## Design

### Release Artifact Naming

Built by CI and uploaded to GitHub Releases at `github.com/BaruchEric/pingpulse`:

| Target | Artifact |
|--------|----------|
| macOS arm64 | `pingpulse-darwin-arm64.tar.gz` |
| macOS amd64 | `pingpulse-darwin-amd64.tar.gz` |
| Linux arm64 | `pingpulse-linux-arm64.tar.gz` |
| Linux amd64 | `pingpulse-linux-amd64.tar.gz` |
| Windows amd64 | `pingpulse-windows-amd64.zip` |
| Windows arm64 | `pingpulse-windows-arm64.zip` |

Each archive contains a single `pingpulse` binary (`pingpulse.exe` on Windows).

### Install Scripts

Two scripts in the repo root:

#### `install.sh` (macOS + Linux)

1. Parse `--token` and `--server` flags (required, exit with usage if missing)
2. Detect OS (`uname -s` → darwin/linux) and arch (`uname -m` → amd64/arm64, mapping `x86_64` → `amd64`, `aarch64` → `arm64`)
3. Build download URL: `https://github.com/BaruchEric/pingpulse/releases/latest/download/pingpulse-{os}-{arch}.tar.gz`
4. Download with `curl -sSL` to a temp directory
5. Extract and move binary to `/usr/local/bin/pingpulse` (uses `sudo` if needed — may prompt for password via `/dev/tty`). If an existing `pingpulse` binary is found, overwrite it (upgrade in place).
6. Prompt for name and location using `read ... < /dev/tty` (since stdin is consumed by the pipe, `/dev/tty` reads from the terminal directly)
7. Run `pingpulse register --token TOKEN --name NAME --location LOC --server SERVER`
8. Run `pingpulse start` (installs + starts launchd/systemd service)
9. Print success message

Error handling:
- Fail fast on missing dependencies (curl, tar)
- Check HTTP status on download (fail if 404)
- Check `pingpulse register` exit code before attempting `start`
- Clean up temp files on exit (trap)

#### `install.ps1` (Windows)

1. Parse `-token` and `-server` parameters (mandatory)
2. Detect arch (`$env:PROCESSOR_ARCHITECTURE` → amd64/arm64)
3. Download URL: `...pingpulse-windows-{arch}.zip`
4. Download to temp via `Invoke-WebRequest`, extract to `$env:LOCALAPPDATA\pingpulse\`
5. Add to user PATH if not present
6. Prompt for name and location via `Read-Host`
7. Run `pingpulse.exe register --token TOKEN --name NAME --location LOC --server SERVER`
8. Run `pingpulse.exe start`
9. Print success message

Error handling:
- Check HTTP response on download
- Check `pingpulse.exe register` exit code before `start`
- Clean up temp files via try/finally

### Updated RegisterDialog

Current: Generate token → show `pingpulse register --token TOKEN` → copy button.

New flow:
1. Admin clicks "Register Client" → dialog opens
2. "Generate Install Command" button
3. On click, calls `POST /api/auth/register/token` (existing endpoint, no changes)
4. Dialog shows two tabs: **macOS / Linux** and **Windows**
   - macOS / Linux tab shows:
     ```
     curl -sSL https://raw.githubusercontent.com/BaruchEric/pingpulse/master/install.sh | bash -s -- --token TOKEN --server SERVER_URL
     ```
   - Windows tab shows:
     ```
     & ([scriptblock]::Create((irm https://raw.githubusercontent.com/BaruchEric/pingpulse/master/install.ps1))) -token TOKEN -server SERVER_URL
     ```
5. Each tab has a Copy button
6. "Token expires in 15 minutes. Single use." note below
7. Done button closes dialog

Server URL is read from `window.location.origin` so it works in any environment (localhost:8787 in dev, production domain, etc.).

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `install.sh` (repo root) | Create | macOS/Linux install script |
| `install.ps1` (repo root) | Create | Windows install script |
| `worker/dashboard/src/components/RegisterDialog.tsx` | Modify | Tabbed UI with one-liner commands |

No backend changes. No new API endpoints. No new dependencies.

## Notes

- Token is visible in shell history — acceptable since tokens are single-use and expire in 15 minutes.
- Scripts use `/releases/latest/` — no version pinning. If client/server compatibility becomes an issue, version pinning can be added later.
- If the dialog fails to generate a token (network error, auth failure), show an inline error message in the dialog.

## Out of Scope

- CI/release pipeline for building and uploading artifacts to GitHub Releases
- Multi-platform Rust cross-compilation setup
- Binary code signing
