/**
 * WebWaka Transport Suite — SyncEngine unit tests
 * Tests: API routing, retry/backoff, conflict handling, abandon logic
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { SyncEngine } from './sync';
import {
  queueMutation,
  getPendingMutationCount,
  _resetOfflineDB,
  getUnresolvedConflicts,
} from './db';

// ============================================================
// Mock fetch
// ============================================================
const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

function mockOk(body: unknown = { success: true }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function mockStatus(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockNetworkError(): Promise<Response> {
  return Promise.reject(new Error('Network error'));
}

// ============================================================
// Setup
// ============================================================
beforeEach(async () => {
  await _resetOfflineDB();
  mockFetch.mockReset();
  vi.stubGlobal('navigator', {
    onLine: true,
    serviceWorker: undefined,
  });
});

// ============================================================
// API Route Mapping
// ============================================================
describe('SyncEngine — API route mapping', () => {
  it('routes booking CREATE to POST /api/booking/bookings', async () => {
    mockFetch.mockResolvedValueOnce(mockOk());
    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_1', 'CREATE', { trip_id: 'tr_1', seats: ['s1'] });
    const result = await engine.flush();
    expect(result.synced).toBe(1);
    expect(mockFetch).toHaveBeenCalledWith('/api/booking/bookings', expect.objectContaining({ method: 'POST' }));
  });

  it('routes booking UPDATE to PATCH /api/booking/bookings/:id', async () => {
    mockFetch.mockResolvedValueOnce(mockOk());
    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_2', 'UPDATE', { id: 'bk_2', status: 'confirmed' });
    await engine.flush();
    expect(mockFetch).toHaveBeenCalledWith('/api/booking/bookings/bk_2', expect.objectContaining({ method: 'PATCH' }));
  });

  it('routes transaction CREATE to POST /api/agent-sales/transactions', async () => {
    mockFetch.mockResolvedValueOnce(mockOk());
    const engine = new SyncEngine();
    await queueMutation('transaction', 'tx_1', 'CREATE', { trip_id: 'tr_1', amount: 5000_00 });
    await engine.flush();
    expect(mockFetch).toHaveBeenCalledWith('/api/agent-sales/transactions', expect.objectContaining({ method: 'POST' }));
  });

  it('routes seat UPDATE to PATCH /api/seat-inventory/trips/:tripId/seats/:seatId', async () => {
    mockFetch.mockResolvedValueOnce(mockOk());
    const engine = new SyncEngine();
    await queueMutation('seat', 's_1', 'UPDATE', { id: 's_1', trip_id: 'tr_1', status: 'confirmed' });
    await engine.flush();
    expect(mockFetch).toHaveBeenCalledWith('/api/seat-inventory/trips/tr_1/seats/s_1', expect.objectContaining({ method: 'PATCH' }));
  });

  it('routes trip CREATE to POST /api/operator/trips', async () => {
    mockFetch.mockResolvedValueOnce(mockOk());
    const engine = new SyncEngine();
    await queueMutation('trip', 'tr_new', 'CREATE', { origin: 'Lagos', destination: 'Abuja' });
    await engine.flush();
    expect(mockFetch).toHaveBeenCalledWith('/api/operator/trips', expect.objectContaining({ method: 'POST' }));
  });

  it('abandons mutations with no valid route (missing required fields)', async () => {
    const engine = new SyncEngine();
    // seat UPDATE without id/trip_id in payload → no route
    await queueMutation('seat', 's_bad', 'UPDATE', { status: 'confirmed' }); // missing id and trip_id
    const result = await engine.flush();
    expect(result.abandoned).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// Success path
// ============================================================
describe('SyncEngine — success path', () => {
  it('marks mutation as SYNCED on 200 response', async () => {
    mockFetch.mockResolvedValueOnce(mockOk());
    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_ok', 'CREATE', { trip_id: 'tr_1' });
    const result = await engine.flush();
    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);
    expect(await getPendingMutationCount()).toBe(0);
  });

  it('sends Authorization header when auth token is set', async () => {
    mockFetch.mockResolvedValueOnce(mockOk());
    const engine = new SyncEngine();
    engine.setAuthToken('test-jwt-token');
    await queueMutation('booking', 'bk_auth', 'CREATE', { trip_id: 'tr_1' });
    await engine.flush();
    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((callArgs[1]!.headers as Record<string, string>)['Authorization']).toBe('Bearer test-jwt-token');
  });

  it('flushes multiple mutations in sequence', async () => {
    mockFetch.mockResolvedValue(mockOk());
    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_a', 'CREATE', { trip_id: 'tr_1' });
    await queueMutation('booking', 'bk_b', 'CREATE', { trip_id: 'tr_2' });
    await queueMutation('transaction', 'tx_a', 'CREATE', { amount: 3000_00 });
    const result = await engine.flush();
    expect(result.synced).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('is idempotent — second flush while flushing returns zero', async () => {
    let resolveFirst!: (v: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>(res => { resolveFirst = res; }));
    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_idem', 'CREATE', { trip_id: 'tr_1' });
    const flushA = engine.flush();
    const flushB = engine.flush(); // while A is in flight
    resolveFirst(mockOk());
    const [a, b] = await Promise.all([flushA, flushB]);
    expect(a.synced).toBe(1);
    expect(b.synced).toBe(0); // B was rejected immediately
  });
});

// ============================================================
// Retry / backoff
// ============================================================
describe('SyncEngine — retry and backoff', () => {
  it('re-queues mutation with backoff on network error', async () => {
    mockFetch.mockImplementationOnce(() => mockNetworkError());
    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_retry', 'CREATE', { trip_id: 'tr_1' });
    const result = await engine.flush();
    expect(result.failed).toBe(1);
    expect(result.synced).toBe(0);
    // Mutation is still in the DB but with next_retry_at in the future
    // So getPendingMutationCount returns 0 right now
    expect(await getPendingMutationCount()).toBe(0);
  });

  it('re-queues mutation with backoff on HTTP 500', async () => {
    mockFetch.mockResolvedValueOnce(mockStatus(500));
    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_5xx', 'CREATE', { trip_id: 'tr_1' });
    const result = await engine.flush();
    expect(result.failed).toBe(1);
  });

  it('abandons mutation after MAX_RETRIES (5) failures', async () => {
    const engine = new SyncEngine();
    // Queue mutation then mark it at retry_count = 4 (one more will abandon)
    const id = await queueMutation('booking', 'bk_maxretry', 'CREATE', { trip_id: 'tr_1' });
    // Simulate 5 previous failures (retry_count = MAX_RETRIES = 5) → next attempt abandons
    const { getOfflineDB } = await import('./db');
    const db = getOfflineDB();
    await db.mutations.update(id, { retry_count: 5, next_retry_at: 0 });
    // Now flush — HTTP 500 on 6th attempt (retry_count 5 >= MAX_RETRIES 5) → abandon
    mockFetch.mockResolvedValueOnce(mockStatus(500));
    const result = await engine.flush();
    expect(result.abandoned).toBe(1);
    expect(result.failed).toBe(0);
  });
});

// ============================================================
// Conflict handling (409)
// ============================================================
describe('SyncEngine — conflict handling', () => {
  it('logs conflict and abandons on 409', async () => {
    const serverResponse = { error: 'Version conflict', server_version: 3 };
    mockFetch.mockResolvedValueOnce(mockStatus(409, serverResponse));
    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_conflict', 'UPDATE', { id: 'bk_conflict', status: 'confirmed' });
    const result = await engine.flush();
    expect(result.conflicts).toBe(1);
    expect(result.abandoned).toBe(0);
    // Conflict should be in conflict_log
    const conflicts = await getUnresolvedConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.entity_id).toBe('bk_conflict');
    expect(conflicts[0]!.http_status).toBe(409);
  });
});

// ============================================================
// Auth errors (401/403)
// ============================================================
describe('SyncEngine — auth errors', () => {
  it('abandons mutation on 401 without retry', async () => {
    mockFetch.mockResolvedValueOnce(mockStatus(401));
    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_401', 'CREATE', { trip_id: 'tr_1' });
    const result = await engine.flush();
    expect(result.abandoned).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('abandons mutation on 403 without retry', async () => {
    mockFetch.mockResolvedValueOnce(mockStatus(403));
    const engine = new SyncEngine();
    await queueMutation('seat', 's_403', 'UPDATE', { id: 's_403', trip_id: 'tr_1', status: 'blocked' });
    const result = await engine.flush();
    expect(result.abandoned).toBe(1);
  });
});

// ============================================================
// Empty queue
// ============================================================
describe('SyncEngine — empty queue', () => {
  it('returns zero counts when queue is empty', async () => {
    const engine = new SyncEngine();
    const result = await engine.flush();
    expect(result).toEqual({ synced: 0, failed: 0, conflicts: 0, abandoned: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
