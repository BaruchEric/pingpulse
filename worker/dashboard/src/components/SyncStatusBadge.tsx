import { useMemo, useSyncExternalStore } from "react";

interface SyncStatus {
  last_sync: number | null;
  total_records: number;
  latest_probe_ts: number | null;
}

function formatSync(lastSync: number | null, now: number): { syncedRecently: boolean; syncLabel: string } {
  if (lastSync === null) {
    return { syncedRecently: false, syncLabel: "Never synced" };
  }
  const agoMs = now - lastSync;
  const syncedRecently = agoMs < 2 * 60 * 1000;
  let syncLabel: string;
  if (agoMs < 60_000) {
    syncLabel = "Synced just now";
  } else if (agoMs < 3_600_000) {
    syncLabel = `Synced ${Math.round(agoMs / 60_000)}m ago`;
  } else {
    syncLabel = `Synced ${Math.round(agoMs / 3_600_000)}h ago`;
  }
  return { syncedRecently, syncLabel };
}

// External store for sync status to satisfy react-hooks/set-state-in-effect
function createSyncStore(clientId: string) {
  let status: SyncStatus | null = null;
  let listeners: Array<() => void> = [];
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const notify = () => listeners.forEach((l) => l());

  const doFetch = async () => {
    try {
      const res = await fetch(`/api/metrics/${clientId}/sync-status`);
      if (!res.ok) return;
      const json = await res.json() as SyncStatus;
      status = json;
      notify();
    } catch {
      // ignore
    }
  };

  return {
    subscribe(listener: () => void) {
      listeners.push(listener);
      if (listeners.length === 1) {
        void doFetch();
        intervalId = setInterval(() => void doFetch(), 30_000);
      }
      return () => {
        listeners = listeners.filter((l) => l !== listener);
        if (listeners.length === 0 && intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
      };
    },
    getSnapshot() {
      return status;
    },
  };
}

// Cache stores per clientId to avoid recreating on re-render
const storeCache = new Map<string, ReturnType<typeof createSyncStore>>();

function getStore(clientId: string) {
  let store = storeCache.get(clientId);
  if (!store) {
    store = createSyncStore(clientId);
    storeCache.set(clientId, store);
  }
  return store;
}

export function SyncStatusBadge({ clientId }: { clientId: string }) {
  const store = getStore(clientId);
  const status = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Tick every 30s to keep "Xm ago" fresh
  const tick = useSyncExternalStore(
    (cb) => {
      const id = setInterval(cb, 30_000);
      return () => clearInterval(id);
    },
    () => Math.floor(Date.now() / 30_000),
  );

  const now = tick * 30_000;

  const { syncedRecently, syncLabel } = useMemo(
    () => formatSync(status?.last_sync ?? null, now),
    [status?.last_sync, now],
  );

  const probeCount = useMemo(() => {
    const total = status?.total_records ?? 0;
    return total >= 1000
      ? `${(total / 1000).toFixed(1).replace(/\.0$/, "")}k`
      : String(total);
  }, [status?.total_records]);

  if (!status) return null;

  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span
        className={`h-2 w-2 rounded-full ${
          syncedRecently ? "bg-green-500" : "bg-yellow-500"
        }`}
      />
      <span className="text-zinc-400">
        {syncLabel} &middot; {probeCount} probes
      </span>
    </span>
  );
}
