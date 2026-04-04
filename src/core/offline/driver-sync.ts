/**
 * WebWaka Transport Suite — Driver Trip Completion Sync
 *
 * QA-TRA-3: Offline driver app stores completed trip records in Dexie.js
 * (IndexedDB) when the device has no network connection.  This module
 * flushes the pending queue to D1 via the ride-hailing API whenever
 * connectivity is restored.
 *
 * Usage (called automatically by useDriverSync hook in driver-app-module.tsx):
 *   await flushDriverTripCompletions();
 *
 * Invariants:
 *   - Idempotent: uses `local_id` as the server-side idempotency key.
 *   - Non-fatal: individual failures are logged, not thrown.
 *   - Ordered: oldest completions are synced first.
 *   - Max 3 retries per record before it is abandoned to avoid permanent queuing.
 */

import {
  getPendingDriverTripCompletions,
  markDriverTripCompletionSynced,
  markDriverTripCompletionFailed,
  type DriverTripCompletion,
} from './db';

const MAX_RETRIES = 3;

interface SyncResult {
  synced: number;
  failed: number;
  skipped: number;
}

/**
 * POST a single driver trip completion to the server.
 * The Idempotency-Key header ensures the server ignores duplicate POSTs
 * if the request is retried after a network error.
 */
async function uploadCompletion(record: DriverTripCompletion): Promise<void> {
  const response = await fetch(`/api/ride-hailing/${record.ride_request_id}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': record.local_id,
    },
    body: JSON.stringify({
      driver_id: record.driver_id,
      operator_id: record.operator_id,
      distance_km: record.distance_km ?? null,
      duration_minutes: record.duration_minutes ?? null,
      wait_time_seconds: record.wait_time_seconds ?? null,
      final_fare_kobo: record.final_fare_kobo ?? null,
      completed_at: record.completed_at,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(`Upload failed [${response.status}]: ${errText}`);
  }
}

/**
 * Flush all unsynced driver trip completions from IndexedDB to D1.
 * Returns a summary of how many records were synced, failed, or skipped.
 */
export async function flushDriverTripCompletions(): Promise<SyncResult> {
  const pending = await getPendingDriverTripCompletions();
  const result: SyncResult = { synced: 0, failed: 0, skipped: 0 };

  for (const record of pending) {
    if (!record.id) continue;

    // Skip records that have exceeded the retry limit
    if ((record.retry_count ?? 0) >= MAX_RETRIES) {
      result.skipped++;
      continue;
    }

    try {
      await uploadCompletion(record);
      await markDriverTripCompletionSynced(record.id);
      result.synced++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markDriverTripCompletionFailed(record.id, message);
      result.failed++;
    }
  }

  return result;
}

/**
 * Register an online event listener that automatically flushes the queue
 * when the browser regains connectivity.
 *
 * Call this once during app initialisation (e.g. in main.tsx or App.tsx).
 * Returns a cleanup function that removes the listener.
 */
export function registerDriverSyncOnReconnect(
  onComplete?: (result: SyncResult) => void
): () => void {
  const handler = async () => {
    try {
      const result = await flushDriverTripCompletions();
      if ((result.synced > 0 || result.failed > 0) && onComplete) {
        onComplete(result);
      }
    } catch {
      // Non-fatal — the next reconnect will retry
    }
  };

  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}
