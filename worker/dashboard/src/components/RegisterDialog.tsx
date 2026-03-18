import { useState } from "react";
import { api } from "@/lib/api";

export function RegisterDialog({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const { token } = await api.generateToken();
      setToken(token);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!token) return;
    const cmd = `pingpulse register --token ${token}`;
    navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Register New Client</h2>
        <p className="mt-1 text-sm text-zinc-400">Generate a registration token, then run the command on the target machine.</p>

        {!token ? (
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="mt-4 w-full rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {loading ? "Generating..." : "Generate Token"}
          </button>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-300 break-all">
              pingpulse register --token {token}
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
            <p className="text-xs text-zinc-500">Token expires in 15 minutes and can only be used once.</p>
          </div>
        )}
      </div>
    </div>
  );
}
