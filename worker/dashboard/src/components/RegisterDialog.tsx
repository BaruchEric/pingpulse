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

  const handleCopy = async () => {
    const cmd = getCommand();
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Failed to copy to clipboard.");
    }
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

            <p className="text-xs text-zinc-400">
              Token expires in 15 minutes and can only be used once.
              You'll be prompted for a client name and location.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
