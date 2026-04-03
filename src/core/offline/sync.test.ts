/**
 * WebWaka Transport Suite — SyncEngine unit tests
 * Tests: API routing, retry/backoff, conflict handling, abandon logic,
 *        ticket sync (Phase 3), seat-already-booked conflict resolution
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { SyncEngine } from './sync';
import {
  queueMutation,
  getPendingMutationCount,
  _resetOfflineDB,
  getUnresolvedConflicts,
  saveOfflineTicket,
  getAllPendingTickets,
  getConflictedTickets,
  markTicketConflict,
} from './db';

// ============================================================
// Mock fetch
// ============================================================
const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

function mockOk(body: unknown = { success: true }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function mockCreated(body: unknown = { success: true }): Response {
  return new Response(JSON.stringify(body), { status: 201 });
}

function mockStatus(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockNetworkError(): Promise<Response> {
  return Promise.reject(new Error('Network error'));
}

// ============================================================
// Helpers
// ============================================================

function makeTicket(overrides: Partial<{
  operator_id: string;
  agent_id: string;
  trip_id: string;
  seat_ids: string[];
  passenger_names: string[];
  ticket_number: string;
  fare_kobo: number;
  total_kobo: number;
  payment_method: 'cash' | 'mobile_money' | 'card';
  status: 'draft' | 'confirmed' | 'cancelled';
}> = {}) {
  return saveOfflineTicket({
    operator_id: 'opr_1',
    agent_id: 'ag_001',
    trip_id: 'tr_lagos_abuja',
    seat_ids: ['s_1A'],
    passenger_names: ['Adebayo Okafor'],
    fare_kobo: 450_000,
    total_kobo: 450_000,
    payment_method: 'cash',
    status: 'draft',
    ...overrides,
  });
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
// API Route Mapping — generic mutations
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

  it('routes ticket CREATE to POST /api/agent-sales/transactions', async () => {
    mockFetch.mockResolvedValueOnce(mockOk());
    const engine = new SyncEngine();
    await queueMutation('ticket', 'TKT-001', 'CREATE', {
      ticket_number: 'TKT-001',
      trip_id: 'tr_1',
      seat_ids: ['s_1A'],
      agent_id: 'ag_001',
    });
    await engine.flush();
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/agent-sales/transactions',
      expect.objectContaining({ method: 'POST' })
    );
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
// Success path — generic mutations
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
// Retry / backoff — generic mutations
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
// Conflict handling — generic mutations (409)
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
// Auth errors — generic mutations (401/403)
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

// ============================================================
// Phase 3: Ticket sync — success paths
// ============================================================
describe('SyncEngine Phase 3 — ticket flush (success)', () => {
  it('sends ticket to POST /api/agent-sales/sync with correct payload shape', async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ ticket_number: 'TKT-TEST-01', booking_id: 'bk_001' }));
    const engine = new SyncEngine();
    await makeTicket({ ticket_number: 'TKT-TEST-01' });
    const result = await engine.flush();
    expect(result.synced).toBe(1);
    // Verify the URL and method
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('/api/agent-sales/sync');
    expect(call[1]!.method).toBe('POST');
    // Verify the payload structure
    const body = JSON.parse(call[1]!.body as string) as Record<string, unknown>;
    expect(body['tickets']).toHaveLength(1);
    const sentTicket = (body['tickets'] as Record<string, unknown>[])[0]!;
    expect(sentTicket['ticket_number']).toBe('TKT-TEST-01');
    expect(sentTicket['trip_id']).toBe('tr_lagos_abuja');
    expect(sentTicket['seat_ids']).toEqual(['s_1A']);
    expect(sentTicket['qr_payload']).toBeDefined();
  });

  it('marks ticket as synced and confirmed on 200 response', async () => {
    mockFetch.mockResolvedValueOnce(mockOk());
    const engine = new SyncEngine();
    const tn = 'TKT-SYNC-OK-01';
    await makeTicket({ ticket_number: tn });
    await engine.flush();
    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.synced).toBe(true);
    expect(t!.status).toBe('confirmed');
    expect(t!.synced_at).toBeDefined();
  });

  it('marks ticket as synced on 201 Created response', async () => {
    mockFetch.mockResolvedValueOnce(mockCreated());
    const engine = new SyncEngine();
    const tn = 'TKT-SYNC-201-01';
    await makeTicket({ ticket_number: tn });
    await engine.flush();
    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.synced).toBe(true);
  });

  it('sends X-Idempotency-Key header using ticket_number', async () => {
    mockFetch.mockResolvedValueOnce(mockOk());
    const engine = new SyncEngine();
    const tn = 'TKT-IDEM-KEY-01';
    await makeTicket({ ticket_number: tn });
    await engine.flush();
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = call[1]!.headers as Record<string, string>;
    expect(headers['X-Idempotency-Key']).toBe(`ticket-${tn}`);
  });

  it('syncs multiple tickets in sequence', async () => {
    mockFetch.mockResolvedValue(mockOk());
    const engine = new SyncEngine();
    await makeTicket({ ticket_number: 'TKT-MULTI-01', seat_ids: ['s_1A'] });
    await makeTicket({ ticket_number: 'TKT-MULTI-02', seat_ids: ['s_1B'] });
    await makeTicket({ ticket_number: 'TKT-MULTI-03', seat_ids: ['s_1C'] });
    const result = await engine.flush();
    expect(result.synced).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ============================================================
// Phase 3: Ticket sync — seat conflict (409)
// The most critical scenario: seat already booked online
// ============================================================
describe('SyncEngine Phase 3 — seat conflict resolution (409)', () => {
  it('records a conflict in both tickets table and conflict_log on 409', async () => {
    const serverBody = {
      error: 'seat_conflict',
      conflicted_seats: ['s_1A'],
      message: 'Seat 1A was confirmed by an online booking while agent was offline',
    };
    mockFetch.mockResolvedValueOnce(mockStatus(409, serverBody));
    const engine = new SyncEngine();
    const tn = 'TKT-CONFLICT-409-01';
    await makeTicket({ ticket_number: tn });

    const result = await engine.flush();
    expect(result.conflicts).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(0);

    // Ticket should be in conflict state
    const conflicted = await getConflictedTickets();
    expect(conflicted.length).toBe(1);
    expect(conflicted[0]!.ticket_number).toBe(tn);
    expect(conflicted[0]!.conflict_reason).toContain('s_1A');
    expect(conflicted[0]!.conflict_at).toBeDefined();

    // conflict_log should also have an entry for the UI conflict resolution panel
    const logEntries = await getUnresolvedConflicts();
    expect(logEntries.length).toBe(1);
    expect(logEntries[0]!.entity_type).toBe('ticket');
    expect(logEntries[0]!.entity_id).toBe(tn);
    expect(logEntries[0]!.http_status).toBe(409);
  });

  it('conflict_reason includes the conflicted seat identifiers from server response', async () => {
    mockFetch.mockResolvedValueOnce(mockStatus(409, {
      error: 'seat_conflict',
      conflicted_seats: ['s_3B', 's_3C'],
    }));
    const engine = new SyncEngine();
    const tn = 'TKT-CONFLICT-MULTI-SEAT-01';
    await makeTicket({ ticket_number: tn, seat_ids: ['s_3B', 's_3C'] });
    await engine.flush();

    const conflicted = await getConflictedTickets();
    const t = conflicted.find(c => c.ticket_number === tn);
    expect(t).toBeDefined();
    expect(t!.conflict_reason).toContain('s_3B');
    expect(t!.conflict_reason).toContain('s_3C');
  });

  it('conflicted ticket does NOT appear in getAllPendingTickets', async () => {
    mockFetch.mockResolvedValueOnce(mockStatus(409, { error: 'seat_conflict', conflicted_seats: ['s_5A'] }));
    const engine = new SyncEngine();
    const tn = 'TKT-CONFLICT-NO-PENDING-01';
    await makeTicket({ ticket_number: tn });
    await engine.flush();

    const pending = await getAllPendingTickets();
    expect(pending.find(t => t.ticket_number === tn)).toBeUndefined();
  });

  it('server_response is stored on conflicted ticket for display in conflict UI', async () => {
    const serverBody = { error: 'seat_conflict', conflicted_seats: ['s_7D'], booking_id: 'bk_online_001' };
    mockFetch.mockResolvedValueOnce(mockStatus(409, serverBody));
    const engine = new SyncEngine();
    const tn = 'TKT-CONFLICT-SERVER-RESP-01';
    await makeTicket({ ticket_number: tn });
    await engine.flush();

    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.server_response).toEqual(serverBody);
  });

  it('409 without conflicted_seats field falls back to ticket seat_ids in conflict reason', async () => {
    // Server sends 409 but without structured conflicted_seats (edge case)
    mockFetch.mockResolvedValueOnce(mockStatus(409, { error: 'version_conflict' }));
    const engine = new SyncEngine();
    const tn = 'TKT-CONFLICT-FALLBACK-01';
    await makeTicket({ ticket_number: tn, seat_ids: ['s_9E'] });
    await engine.flush();

    const conflicted = await getConflictedTickets();
    const t = conflicted.find(c => c.ticket_number === tn);
    expect(t).toBeDefined();
    // Falls back to the ticket's own seat_ids
    expect(t!.conflict_reason).toContain('s_9E');
  });

  it('auth error (401) on ticket marks as conflict with auth message, no retry', async () => {
    mockFetch.mockResolvedValueOnce(mockStatus(401));
    const engine = new SyncEngine();
    const tn = 'TKT-AUTH-ERROR-01';
    await makeTicket({ ticket_number: tn });
    const result = await engine.flush();
    expect(result.abandoned).toBe(1);
    expect(result.synced).toBe(0);

    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.conflict_reason).toContain('Authentication error');
  });

  it('pre-conflicted tickets from markTicketConflict are skipped during flush', async () => {
    const tn = 'TKT-PRE-CONFLICTED-01';
    await makeTicket({ ticket_number: tn });
    // Mark as conflicted before sync runs
    await markTicketConflict(tn, 'Pre-existing conflict', {});
    const engine = new SyncEngine();
    const result = await engine.flush();
    // No fetch call for pre-conflicted ticket
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.synced).toBe(0);
    expect(result.conflicts).toBe(0);
  });
});

// ============================================================
// Phase 3: Ticket sync — retry on server errors
// ============================================================
describe('SyncEngine Phase 3 — ticket retry on transient errors', () => {
  it('increments retry_count on 500, ticket stays in pending queue', async () => {
    mockFetch.mockResolvedValueOnce(mockStatus(500));
    const engine = new SyncEngine();
    const tn = 'TKT-RETRY-5XX-01';
    await makeTicket({ ticket_number: tn });
    const result = await engine.flush();
    expect(result.failed).toBe(1);
    expect(result.synced).toBe(0);

    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.retry_count).toBe(1);
    expect(t!.synced).toBe(false);
    expect(t!.conflict_at).toBeUndefined();
  });

  it('increments retry_count on network error', async () => {
    mockFetch.mockImplementationOnce(() => mockNetworkError());
    const engine = new SyncEngine();
    const tn = 'TKT-RETRY-NET-01';
    await makeTicket({ ticket_number: tn });
    const result = await engine.flush();
    expect(result.failed).toBe(1);

    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.retry_count).toBe(1);
  });

  it('tickets with retry_count >= 5 are excluded from flush', async () => {
    const tn = 'TKT-MAX-RETRY-SYNC-01';
    await makeTicket({ ticket_number: tn });
    // Manually set retry_count to 5
    const { getOfflineDB } = await import('./db');
    const db = getOfflineDB();
    const t = await db.tickets.where('ticket_number').equals(tn).first();
    await db.tickets.update(t!.id!, { retry_count: 5 });

    const engine = new SyncEngine();
    const result = await engine.flush();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(0);
  });
});

// ============================================================
// Phase 3 + Phase 1 mixed: both mutations and tickets in one flush
// ============================================================
describe('SyncEngine — mixed flush (mutations + tickets)', () => {
  it('syncs both mutations and tickets in a single flush call', async () => {
    // 2 mutation syncs + 1 ticket sync = 3 fetch calls
    mockFetch.mockResolvedValue(mockOk());
    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_mix_1', 'CREATE', { trip_id: 'tr_1' });
    await queueMutation('seat', 's_mix_1', 'UPDATE', { id: 's_mix_1', trip_id: 'tr_1', status: 'confirmed' });
    await makeTicket({ ticket_number: 'TKT-MIX-01' });
    const result = await engine.flush();
    expect(result.synced).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('ticket conflict does not block mutation sync', async () => {
    // Booking mutation → 200, ticket → 409
    mockFetch
      .mockResolvedValueOnce(mockOk())
      .mockResolvedValueOnce(mockStatus(409, { error: 'seat_conflict', conflicted_seats: ['s_2B'] }));

    const engine = new SyncEngine();
    await queueMutation('booking', 'bk_with_conflict', 'CREATE', { trip_id: 'tr_1' });
    await makeTicket({ ticket_number: 'TKT-PARTIAL-CONFLICT-01', seat_ids: ['s_2B'] });
    const result = await engine.flush();
    expect(result.synced).toBe(1);
    expect(result.conflicts).toBe(1);
    expect(result.failed).toBe(0);
  });
});
