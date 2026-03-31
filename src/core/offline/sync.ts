/**
 * WebWaka Transport Suite — SyncEngine
 * Flushes the Dexie offline mutation queue to the server API.
 * Invariants: Offline-First, Exponential Backoff, Conflict-Aware
 *
 * Usage:
 *   await syncEngine.flush();          // manual trigger
 *   await syncEngine.queueAndSync(...) // queue + trigger in one call
 *   syncEngine.registerBackgroundSync() // registers SW background sync tag
 */
import {
  type OfflineMutation,
  getPendingMutations,
  markMutationSyncing,
  markMutationSynced,
  markMutationFailed,
  markMutationAbandoned,
  logConflict,
  getAllPendingTransactions,
  markTransactionSynced,
  incrementTransactionRetry,
} from './db';

// ============================================================
// Mutation → API route mapping
// ============================================================

interface ApiRequest {
  url: string;
  method: string;
  body: unknown;
}

function buildApiRequest(mutation: OfflineMutation): ApiRequest | null {
  const { entity_type, action, payload } = mutation;

  switch (entity_type) {
    case 'booking': {
      if (action === 'CREATE') return { url: '/api/booking/bookings', method: 'POST', body: payload };
      if (action === 'UPDATE' && payload['id']) return { url: `/api/booking/bookings/${payload['id']}`, method: 'PATCH', body: payload };
      if (action === 'DELETE' && payload['id']) return { url: `/api/booking/bookings/${payload['id']}`, method: 'DELETE', body: null };
      break;
    }
    case 'transaction': {
      if (action === 'CREATE') return { url: '/api/agent-sales/transactions', method: 'POST', body: payload };
      break;
    }
    case 'seat': {
      const tripId = payload['trip_id'];
      const seatId = payload['id'];
      if (action === 'UPDATE' && tripId && seatId) {
        return { url: `/api/seat-inventory/trips/${tripId}/seats/${seatId}`, method: 'PATCH', body: payload };
      }
      break;
    }
    case 'trip': {
      if (action === 'CREATE') return { url: '/api/operator/trips', method: 'POST', body: payload };
      if (action === 'UPDATE' && payload['id']) return { url: `/api/operator/trips/${payload['id']}`, method: 'PATCH', body: payload };
      if (action === 'DELETE' && payload['id']) return { url: `/api/operator/trips/${payload['id']}`, method: 'DELETE', body: null };
      break;
    }
  }
  return null;
}

// ============================================================
// SyncResult
// ============================================================

export interface SyncResult {
  synced: number;
  failed: number;
  conflicts: number;
  abandoned: number;
}

// ============================================================
// SyncEngine
// ============================================================

const MAX_RETRIES = 5;

export class SyncEngine {
  private _isFlushing = false;
  private _authToken: string | undefined = undefined;

  /** Set the JWT for authenticating sync requests */
  setAuthToken(token: string): void {
    this._authToken = token;
  }

  clearAuthToken(): void {
    this._authToken = undefined;
  }

  get isFlushing(): boolean {
    return this._isFlushing;
  }

  /**
   * Flush all PENDING mutations that are due for retry.
   * Cross-tab safe via Web Locks API — only one tab flushes at a time.
   * Falls back to the per-instance _isFlushing guard in environments
   * that do not support navigator.locks (e.g. Node test environment).
   */
  async flush(): Promise<SyncResult> {
    // Use Web Locks API for cross-tab mutual exclusion when available
    if (typeof navigator !== 'undefined' && navigator.locks) {
      const acquired = await new Promise<SyncResult | null>((resolve) => {
        navigator.locks.request(
          'webwaka-sync-lock',
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              // Another tab holds the lock — skip
              resolve(null);
              return;
            }
            resolve(await this._doFlush());
          }
        );
      });
      return acquired ?? { synced: 0, failed: 0, conflicts: 0, abandoned: 0 };
    }

    // Fallback: per-instance guard (SSR / Node / older browsers)
    if (this._isFlushing) return { synced: 0, failed: 0, conflicts: 0, abandoned: 0 };
    return this._doFlush();
  }

  /** Internal flush implementation — must only be called while holding the sync lock. */
  private async _doFlush(): Promise<SyncResult> {
    if (this._isFlushing) return { synced: 0, failed: 0, conflicts: 0, abandoned: 0 };
    this._isFlushing = true;

    const result: SyncResult = { synced: 0, failed: 0, conflicts: 0, abandoned: 0 };

    try {
      // Phase 1: flush offline mutations (seat, trip, booking, transaction mutations)
      const mutations = await getPendingMutations();

      for (const mutation of mutations) {
        if (mutation.id === undefined) continue;
        await this._processMutation(mutation, result);
      }

      // Phase 2: flush offline agent transactions (TRN-2 agent POS)
      const pendingTx = await getAllPendingTransactions();

      for (const tx of pendingTx) {
        try {
          const response = await fetch('/api/agent-sales/sync', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this._authToken ?? ''}`,
              'X-Idempotency-Key': tx.idempotencyKey,
            },
            body: JSON.stringify({ transactions: [tx] }),
          });
          if (response.ok || response.status === 409) {
            await markTransactionSynced(tx.local_id);
            result.synced++;
          } else {
            await incrementTransactionRetry(tx.local_id);
            result.failed++;
          }
        } catch {
          // Network error — will retry on next flush
        }
      }
    } finally {
      this._isFlushing = false;
    }

    return result;
  }

  /** Queue a mutation and immediately trigger sync if online */
  async queueAndSync(
    entity_type: OfflineMutation['entity_type'],
    entity_id: string,
    action: OfflineMutation['action'],
    payload: Record<string, unknown>,
    version = 1
  ): Promise<void> {
    const { queueMutation } = await import('./db');
    await queueMutation(entity_type, entity_id, action, payload, version);
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      await this.flush();
    } else {
      this.registerBackgroundSync();
    }
  }

  /**
   * Register a Background Sync event with the Service Worker.
   * The SW will call flush() via TRIGGER_SYNC message when connectivity is restored.
   */
  registerBackgroundSync(): void {
    if (typeof navigator === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then(reg => {
        if ('sync' in reg) {
          return (reg as ServiceWorkerRegistration & { sync: { register: (tag: string) => Promise<void> } })
            .sync.register('webwaka-transport-sync');
        }
      })
      .catch(() => {
        // Background Sync not supported — sync will happen on next app open
      });
  }

  // ============================================================
  // Internal
  // ============================================================

  private async _processMutation(mutation: OfflineMutation, result: SyncResult): Promise<void> {
    const id = mutation.id!;
    const apiReq = buildApiRequest(mutation);

    if (!apiReq) {
      // Unroutable mutation — abandon immediately
      await markMutationAbandoned(id, 'No API route for this mutation');
      result.abandoned++;
      return;
    }

    await markMutationSyncing(id);

    let response: Response;
    try {
      // Attach idempotency key — mutation.id is a stable UUID that persists
      // across retries. The server returns the cached response on replay.
      const idempotencyKey = String(id);
      response = await this._fetchWithAuth(apiReq, idempotencyKey);
    } catch (networkErr) {
      // Network failure — back off and retry
      const errMsg = networkErr instanceof Error ? networkErr.message : 'Network error';
      if (mutation.retry_count >= MAX_RETRIES) {
        await markMutationAbandoned(id, `Max retries exceeded: ${errMsg}`);
        result.abandoned++;
      } else {
        await markMutationFailed(id, errMsg, mutation.retry_count);
        result.failed++;
      }
      return;
    }

    if (response.ok) {
      await markMutationSynced(id);
      result.synced++;
      return;
    }

    if (response.status === 409) {
      // Conflict — log it and abandon (human or reconciliation job resolves it)
      let serverPayload: Record<string, unknown> = {};
      try {
        serverPayload = await response.json() as Record<string, unknown>;
      } catch { /* ignore parse errors */ }
      await logConflict(
        mutation.entity_type,
        mutation.entity_id,
        mutation.payload,
        serverPayload,
        response.status
      );
      await markMutationAbandoned(id, `Conflict: ${response.status}`);
      result.conflicts++;
      return;
    }

    if (response.status === 401 || response.status === 403) {
      // Auth error — abandon (token may have expired, user needs to re-login)
      await markMutationAbandoned(id, `Auth error: ${response.status}`);
      result.abandoned++;
      return;
    }

    // Server error (5xx) or other 4xx — retry with backoff
    const errMsg = `HTTP ${response.status}`;
    if (mutation.retry_count >= MAX_RETRIES) {
      await markMutationAbandoned(id, `Max retries exceeded: ${errMsg}`);
      result.abandoned++;
    } else {
      await markMutationFailed(id, errMsg, mutation.retry_count);
      result.failed++;
    }
  }

  private async _fetchWithAuth(req: ApiRequest, idempotencyKey?: string): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this._authToken) {
      headers['Authorization'] = `Bearer ${this._authToken}`;
    }
    if (idempotencyKey) {
      headers['X-Idempotency-Key'] = idempotencyKey;
    }
    return fetch(req.url, {
      method: req.method,
      headers,
      ...(req.body !== null ? { body: JSON.stringify(req.body) } : {}),
    });
  }
}

// ============================================================
// Singleton — share one engine across the app
// ============================================================
export const syncEngine = new SyncEngine();

// ============================================================
// Service Worker message handler setup
// Wire this up in main.tsx: setupSyncMessageHandler()
// ============================================================

let _syncHandlerRegistered = false;

export function setupSyncMessageHandler(): void {
  if (_syncHandlerRegistered) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', async event => {
    const { data } = event;
    if (!data || data.type !== 'TRIGGER_SYNC') return;

    const replyPort: MessagePort | undefined = data.port;

    try {
      const result = await syncEngine.flush();
      replyPort?.postMessage({ type: 'SYNC_DONE', result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown sync error';
      replyPort?.postMessage({ type: 'SYNC_ERROR', error: message });
    }
  });

  _syncHandlerRegistered = true;
}

// For testing — reset the handler flag
export function _resetSyncHandlerForTests(): void {
  _syncHandlerRegistered = false;
}
