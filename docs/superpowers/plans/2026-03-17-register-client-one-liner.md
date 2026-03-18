# Register Client One-Liner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual multi-step client registration with a single copy-paste one-liner that downloads, registers, and starts the pingpulse client daemon.

**Architecture:** Two install scripts (`install.sh`, `install.ps1`) hosted in the repo root handle OS/arch detection, binary download from GitHub Releases, interactive prompts for name/location, registration, and service installation. The existing `RegisterDialog.tsx` is updated to show tabbed one-liner commands instead of a raw CLI command.

**Tech Stack:** Bash, PowerShell, React (existing Vite + Tailwind dashboard)

**Spec:** `docs/superpowers/specs/2026-03-17-register-client-one-liner-design.md`

---

### Task 1: Create `install.sh` (macOS + Linux)

**Files:**
- Create: `install.sh`

- [ ] **Step 1: Create the install script**

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="BaruchEric/pingpulse"

usage() {
  echo "Usage: install.sh --token TOKEN --server SERVER_URL"
  echo ""
  echo "Downloads, registers, and starts the pingpulse client daemon."
  echo ""
  echo "Options:"
  echo "  --token   Registration token (required, from dashboard)"
  echo "  --server  Server URL (required, e.g. https://pingpulse.example.com)"
  exit 1
}

# --- Parse arguments ---
TOKEN=""
SERVER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)  TOKEN="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    *)        usage ;;
  esac
done

[[ -z "$TOKEN" ]] && { echo "Error: --token is required"; usage; }
[[ -z "$SERVER" ]] && { echo "Error: --server is required"; usage; }

# --- Check dependencies ---
for cmd in curl tar; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Error: '$cmd' is required but not found."; exit 1; }
done

# --- Detect OS and architecture ---
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin) ;;
  linux)  ;;
  *)      echo "Error: Unsupported OS '$OS'. Only macOS and Linux are supported."; exit 1 ;;
esac

case "$ARCH" in
  x86_64)       ARCH="amd64" ;;
  amd64)        ;;
  arm64)        ;;
  aarch64)      ARCH="arm64" ;;
  *)            echo "Error: Unsupported architecture '$ARCH'."; exit 1 ;;
esac

ARTIFACT="pingpulse-${OS}-${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/latest/download/${ARTIFACT}"

# --- Temp directory with cleanup ---
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# --- Download ---
echo "Downloading pingpulse for ${OS}/${ARCH}..."
HTTP_CODE=$(curl -sSL -w "%{http_code}" -o "${WORK_DIR}/${ARTIFACT}" "$URL")
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Error: Download failed (HTTP ${HTTP_CODE}). No release found for ${OS}/${ARCH}."
  echo "URL: ${URL}"
  exit 1
fi

# --- Extract ---
echo "Extracting..."
tar -xzf "${WORK_DIR}/${ARTIFACT}" -C "$WORK_DIR"

# --- Install binary ---
INSTALL_DIR="/usr/local/bin"
if [[ -w "$INSTALL_DIR" ]]; then
  mv "${WORK_DIR}/pingpulse" "${INSTALL_DIR}/pingpulse"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "${WORK_DIR}/pingpulse" "${INSTALL_DIR}/pingpulse"
fi
chmod +x "${INSTALL_DIR}/pingpulse"
echo "Installed pingpulse to ${INSTALL_DIR}/pingpulse"

# --- Prompt for name and location (read from /dev/tty since stdin is piped) ---
echo ""
read -rp "Enter client name: " NAME < /dev/tty
read -rp "Enter location: " LOCATION < /dev/tty

if [[ -z "$NAME" || -z "$LOCATION" ]]; then
  echo "Error: Name and location are required."
  exit 1
fi

# --- Register ---
echo ""
echo "Registering client '${NAME}' at '${LOCATION}'..."
if ! pingpulse register --token "$TOKEN" --name "$NAME" --location "$LOCATION" --server "$SERVER"; then
  echo "Error: Registration failed."
  exit 1
fi

# --- Start service ---
echo "Starting pingpulse daemon..."
if ! pingpulse start; then
  echo "Error: Failed to start daemon. Try 'pingpulse start --foreground' for details."
  exit 1
fi

echo ""
echo "Done! Client '${NAME}' is registered and running."
echo "View it on your dashboard at ${SERVER}/clients"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x install.sh`

- [ ] **Step 3: Verify script syntax**

Run: `bash -n install.sh`
Expected: No output (no syntax errors)

- [ ] **Step 4: Commit**

```bash
git add install.sh
git commit -m "feat: add install.sh for one-liner client setup on macOS/Linux"
```

---

### Task 2: Create `install.ps1` (Windows)

**Files:**
- Create: `install.ps1`

- [ ] **Step 1: Create the PowerShell install script**

```powershell
#Requires -Version 5.1
param(
    [Parameter(Mandatory=$true)]
    [string]$token,

    [Parameter(Mandatory=$true)]
    [string]$server
)

$ErrorActionPreference = "Stop"
$repo = "BaruchEric/pingpulse"

# --- Detect architecture ---
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64"  { "amd64" }
    "ARM64"  { "arm64" }
    default  { Write-Error "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"; exit 1 }
}

$artifact = "pingpulse-windows-${arch}.zip"
$url = "https://github.com/${repo}/releases/latest/download/${artifact}"
$installDir = Join-Path $env:LOCALAPPDATA "pingpulse"
$binPath = Join-Path $installDir "pingpulse.exe"

# --- Temp directory with cleanup ---
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "pingpulse-install-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
    # --- Download ---
    Write-Host "Downloading pingpulse for windows/${arch}..."
    $zipPath = Join-Path $tmpDir $artifact
    try {
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
    } catch {
        Write-Error "Download failed. No release found for windows/${arch}.`nURL: ${url}`n$($_.Exception.Message)"
        exit 1
    }

    # --- Extract ---
    Write-Host "Extracting..."
    Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force

    # --- Install binary ---
    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }
    Move-Item -Path (Join-Path $tmpDir "pingpulse.exe") -Destination $binPath -Force
    Write-Host "Installed pingpulse to ${binPath}"

    # --- Add to PATH if not present ---
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*${installDir}*") {
        [Environment]::SetEnvironmentVariable("Path", "${userPath};${installDir}", "User")
        $env:Path = "${env:Path};${installDir}"
        Write-Host "Added ${installDir} to user PATH"
    }

    # --- Prompt for name and location ---
    Write-Host ""
    $name = Read-Host "Enter client name"
    $location = Read-Host "Enter location"

    if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($location)) {
        Write-Error "Name and location are required."
        exit 1
    }

    # --- Register ---
    Write-Host ""
    Write-Host "Registering client '${name}' at '${location}'..."
    & $binPath register --token $token --name $name --location $location --server $server
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Registration failed."
        exit 1
    }

    # --- Start service ---
    Write-Host "Starting pingpulse daemon..."
    & $binPath start
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to start daemon. Try 'pingpulse start --foreground' for details."
        exit 1
    }

    Write-Host ""
    Write-Host "Done! Client '${name}' is registered and running."
    Write-Host "View it on your dashboard at ${server}/clients"

} finally {
    # --- Cleanup ---
    if (Test-Path $tmpDir) {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
```

- [ ] **Step 2: Verify script syntax**

Run: `pwsh -Command "Get-Command -Syntax install.ps1" 2>/dev/null || echo "pwsh not available — skip syntax check"`

- [ ] **Step 3: Commit**

```bash
git add install.ps1
git commit -m "feat: add install.ps1 for one-liner client setup on Windows"
```

---

### Task 3: Update RegisterDialog with tabbed one-liner UI

**Files:**
- Modify: `worker/dashboard/src/components/RegisterDialog.tsx`

**Context:** The current dialog is a simple modal with a "Generate Token" button that shows a `pingpulse register --token TOKEN` command. We're replacing the post-token-generation UI with two tabs (macOS/Linux and Windows) showing the full one-liner install commands. The dialog uses raw Tailwind — no component library. Keep the existing styling patterns.

- [ ] **Step 1: Rewrite the RegisterDialog**

Replace the entire file with the new tabbed implementation:

```tsx
import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/api";

type Platform = "unix" | "windows";

export function RegisterDialog({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [platform, setPlatform] = useState<Platform>("unix");
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  const serverUrl = window.location.origin;

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const { token } = await api.generateToken();
      setToken(token);
    } catch {
      setError("Failed to generate token. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const getCommand = (): string => {
    if (!token) return "";
    if (platform === "unix") {
      return `curl -sSL https://raw.githubusercontent.com/BaruchEric/pingpulse/master/install.sh | bash -s -- --token ${token} --server ${serverUrl}`;
    }
    return `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/BaruchEric/pingpulse/master/install.ps1))) -token ${token} -server ${serverUrl}`;
  };

  const handleCopy = () => {
    const cmd = getCommand();
    if (!cmd) return;
    navigator.clipboard.writeText(cmd);
    setCopied(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const tabClass = (tab: Platform) =>
    `px-3 py-1.5 text-sm rounded-md transition-colors ${
      platform === tab
        ? "bg-zinc-700 text-white"
        : "text-zinc-400 hover:text-zinc-200"
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Register New Client</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Generate an install command, then run it on the target machine.
        </p>

        {error && (
          <div className="mt-3 rounded-md bg-red-950/50 border border-red-900 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        {!token ? (
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="mt-4 w-full rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {loading ? "Generating..." : "Generate Install Command"}
          </button>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex gap-1 rounded-lg bg-zinc-950 p-1">
              <button onClick={() => { setPlatform("unix"); setCopied(false); }} className={tabClass("unix")}>
                macOS / Linux
              </button>
              <button onClick={() => { setPlatform("windows"); setCopied(false); }} className={tabClass("windows")}>
                Windows
              </button>
            </div>

            <div className="rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-300 break-all max-h-32 overflow-y-auto">
              {getCommand()}
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCopy}
                className="flex-1 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                {copied ? "Copied!" : "Copy command"}
              </button>
              <button
                onClick={onClose}
                className="flex-1 rounded-md bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
              >
                Done
              </button>
            </div>

            <p className="text-xs text-zinc-500">
              Token expires in 15 minutes and can only be used once.
              You'll be prompted for a client name and location.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the dashboard builds**

Run: `cd worker/dashboard && bun run build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Manual smoke test**

Run: `cd worker && bun run dev` (or however the dev server starts)
1. Navigate to `http://localhost:8787/clients`
2. Click "Register Client"
3. Click "Generate Install Command"
4. Verify both tabs show correct one-liner commands with the token and `localhost:8787` as server URL
5. Verify copy button works on each tab
6. Verify error state by testing with network disconnected

- [ ] **Step 4: Commit**

```bash
git add worker/dashboard/src/components/RegisterDialog.tsx
git commit -m "feat: update RegisterDialog with tabbed one-liner install commands"
```
