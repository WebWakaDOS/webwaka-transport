/**
 * WebWaka Transport Suite — Offline / Sync React Hooks
 * Invariants: Offline-First, auto-sync on connectivity restore
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { getPendingMutationCount } from './db';
import { syncEngine } from './sync';

// ============================================================
// useOnlineStatus
// ============================================================

/** Returns true when the browser believes it has network connectivity. */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}

// ============================================================
// useSyncQueue
// ============================================================

export interface SyncQueueState {
  pendingCount: number;
  isSyncing: boolean;
  lastSyncAt: number | undefined;
  triggerSync: () => Promise<void>;
}

/**
 * Manages the offline mutation queue display + manual sync trigger.
 * Auto-syncs when connectivity is restored.
 * Polls the pending count every 5s.
 */
export function useSyncQueue(): SyncQueueState {
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | undefined>(undefined);
  const online = useOnlineStatus();
  const prevOnlineRef = useRef(online);

  const refreshCount = useCallback(async () => {
    const count = await getPendingMutationCount();
    setPendingCount(count);
  }, []);

  const triggerSync = useCallback(async () => {
    if (isSyncing || !online) return;
    setIsSyncing(true);
    try {
      await syncEngine.flush();
      setLastSyncAt(Date.now());
    } finally {
      setIsSyncing(false);
      await refreshCount();
    }
  }, [isSyncing, online, refreshCount]);

  // Poll pending count every 5 seconds
  useEffect(() => {
    refreshCount();
    const interval = setInterval(refreshCount, 5_000);
    return () => clearInterval(interval);
  }, [refreshCount]);

  // Auto-sync when going from offline → online
  useEffect(() => {
    const wasOffline = !prevOnlineRef.current;
    const isNowOnline = online;
    prevOnlineRef.current = online;
    if (wasOffline && isNowOnline && pendingCount > 0) {
      triggerSync();
    }
  }, [online, pendingCount, triggerSync]);

  return { pendingCount, isSyncing, lastSyncAt, triggerSync };
}

// ============================================================
// usePendingSync (backwards-compat alias)
// ============================================================

/** @deprecated Use useSyncQueue instead */
export function usePendingSync(): number {
  return useSyncQueue().pendingCount;
}
