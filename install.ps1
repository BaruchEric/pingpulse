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
    if ($userPath.Split(';') -notcontains $installDir) {
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
