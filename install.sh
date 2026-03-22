#!/usr/bin/env bash
set -euo pipefail

REPO="BaruchEric/pingpulse"

usage() {
  echo "Usage: install.sh --token TOKEN --server SERVER_URL [--name NAME] [--location LOCATION]"
  echo ""
  echo "Downloads, registers, and starts the pingpulse client daemon."
  echo ""
  echo "Options:"
  echo "  --token     Registration token (required, from dashboard)"
  echo "  --server    Server URL (required, e.g. https://pingpulse.example.com)"
  echo "  --name      Client name (prompted interactively if omitted)"
  echo "  --location  Client location (prompted interactively if omitted)"
  exit 1
}

# --- Parse arguments ---
TOKEN=""
SERVER=""
NAME=""
LOCATION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)    TOKEN="$2"; shift 2 ;;
    --server)   SERVER="$2"; shift 2 ;;
    --name)     NAME="$2"; shift 2 ;;
    --location) LOCATION="$2"; shift 2 ;;
    *)          usage ;;
  esac
done

[[ -z "$TOKEN" ]] && { echo "Error: --token is required"; usage; }
[[ -z "$SERVER" ]] && { echo "Error: --server is required"; usage; }
[[ "$SERVER" =~ ^https?:// ]] || { echo "Error: --server must be a valid URL (e.g. https://pingpulse.example.com)"; exit 1; }

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

# --- Install binary to user-writable location ---
INSTALL_DIR="$HOME/.pingpulse/bin"
mkdir -p "$INSTALL_DIR"

# Sign before copying (macOS rejects unsigned binaries)
if [[ "$OS" == "darwin" ]]; then
  codesign -s - -f "${WORK_DIR}/pingpulse" 2>/dev/null || true
fi

mv "${WORK_DIR}/pingpulse" "${INSTALL_DIR}/pingpulse"
chmod +x "${INSTALL_DIR}/pingpulse"

# --- Migrate from legacy /usr/local/bin install ---
if [[ -f "/usr/local/bin/pingpulse" ]]; then
  echo "Removing legacy binary from /usr/local/bin..."
  rm -f "/usr/local/bin/pingpulse" 2>/dev/null || sudo rm -f "/usr/local/bin/pingpulse" 2>/dev/null || true
fi

# --- Add to PATH if not present ---
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  SHELL_NAME="$(basename "$SHELL")"
  case "$SHELL_NAME" in
    zsh)  PROFILE="$HOME/.zshrc" ;;
    bash) PROFILE="$HOME/.bashrc" ;;
    *)    PROFILE="$HOME/.profile" ;;
  esac
  if ! grep -qF "$INSTALL_DIR" "$PROFILE" 2>/dev/null; then
    echo "" >> "$PROFILE"
    echo "# PingPulse" >> "$PROFILE"
    echo "export PATH=\"${INSTALL_DIR}:\$PATH\"" >> "$PROFILE"
    echo "Added ${INSTALL_DIR} to PATH in ${PROFILE}"
  fi
  export PATH="${INSTALL_DIR}:$PATH"
fi

VERSION=$("${INSTALL_DIR}/pingpulse" --version 2>&1 | sed 's/^pingpulse *//')
echo "Installed pingpulse v${VERSION} to ${INSTALL_DIR}/pingpulse"

# --- Prompt for name and location if not provided ---
if [[ -z "$NAME" ]]; then
  echo ""
  read -rp "Enter client name: " NAME < /dev/tty
fi
if [[ -z "$LOCATION" ]]; then
  read -rp "Enter location: " LOCATION < /dev/tty
fi

if [[ -z "$NAME" || -z "$LOCATION" ]]; then
  echo "Error: Name and location are required."
  exit 1
fi

# --- Clean up any existing installation ---
if [[ -f "$HOME/.pingpulse/config.toml" ]]; then
  echo "Existing PingPulse installation detected — cleaning up..."
  pingpulse stop 2>/dev/null || true
  # Keep the bin directory, only remove config/data
  find "$HOME/.pingpulse" -maxdepth 1 -not -name bin -not -name .pingpulse -delete 2>/dev/null || true
  rm -rf "$HOME/.pingpulse/logs" "$HOME/.pingpulse/data" 2>/dev/null || true
  echo "Old installation removed."
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
