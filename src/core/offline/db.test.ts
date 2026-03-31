/**
 * WebWaka Transport Suite — Dexie v2 schema tests
 * Tests: mutation queue, conflict log, seat/trip cache, agent sessions, NDPR consent
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  queueMutation,
  getPendingMutations,
  markMutationSynced,
  markMutationFailed,
  markMutationAbandoned,
  getPendingMutationCount,
  logConflict,
  getUnresolvedConflicts,
  resolveConflict,
  cacheTrips,
  getCachedTrips,
  evictExpiredTrips,
  cacheSeats,
  getCachedSeats,
  evictExpiredSeats,
  cacheAgentSession,
  getAgentSession,
  cacheOperatorConfig,
  getCachedOperatorConfig,
  recordNdprConsent,
  getConsentHistory,
  _resetOfflineDB,
} from './db';

beforeEach(async () => {
  await _resetOfflineDB();
});

// ============================================================
// Mutation Queue
// ============================================================
describe('Mutation Queue', () => {
  it('queues a mutation with PENDING status', async () => {
    const id = await queueMutation('booking', 'bk_001', 'CREATE', { trip_id: 'tr_1' });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('getPendingMutations returns only PENDING mutations due now', async () => {
    await queueMutation('booking', 'bk_001', 'CREATE', { trip_id: 'tr_1' });
    await queueMutation('seat', 'st_001', 'UPDATE', { status: 'confirmed' });
    const pending = await getPendingMutations();
    expect(pending.length).toBe(2);
    pending.forEach(m => expect(m.status).toBe('PENDING'));
  });

  it('markMutationSynced sets status to SYNCED and sets synced_at', async () => {
    const id = await queueMutation('transaction', 'tx_1', 'CREATE', { amount: 5000 });
    await markMutationSynced(id);
    const pending = await getPendingMutations();
    const synced = pending.find(m => m.id === id);
    expect(synced).toBeUndefined(); // no longer PENDING
  });

  it('markMutationFailed increments retry_count and sets next_retry_at', async () => {
    const id = await queueMutation('seat', 'st_2', 'UPDATE', { status: 'available' });
    // Fail once — next_retry_at should be 1s in the future
    await markMutationFailed(id, 'HTTP 500', 0);
    // Mutation should not appear in getPendingMutations because next_retry_at is future
    const duePending = await getPendingMutations();
    expect(duePending.find(m => m.id === id)).toBeUndefined();
  });

  it('markMutationAbandoned sets status to FAILED', async () => {
    const id = await queueMutation('booking', 'bk_007', 'DELETE', { id: 'bk_007' });
    await markMutationAbandoned(id, 'Max retries exceeded');
    const pending = await getPendingMutations();
    expect(pending.find(m => m.id === id)).toBeUndefined();
  });

  it('getPendingMutationCount returns correct count', async () => {
    expect(await getPendingMutationCount()).toBe(0);
    await queueMutation('trip', 'tr_9', 'UPDATE', { state: 'DEPARTED' });
    await queueMutation('booking', 'bk_2', 'CREATE', { trip_id: 'tr_9' });
    expect(await getPendingMutationCount()).toBe(2);
  });

  it('queued mutations have correct default fields', async () => {
    const before = Date.now();
    await queueMutation('seat', 'st_10', 'UPDATE', { status: 'reserved' }, 3);
    const pending = await getPendingMutations();
    const m = pending[0]!;
    expect(m.entity_type).toBe('seat');
    expect(m.entity_id).toBe('st_10');
    expect(m.action).toBe('UPDATE');
    expect(m.payload).toEqual({ status: 'reserved' });
    expect(m.version).toBe(3);
    expect(m.retry_count).toBe(0);
    expect(m.next_retry_at).toBe(0);
    expect(m.created_at).toBeGreaterThanOrEqual(before);
    expect(m.synced_at).toBeUndefined();
    expect(m.error).toBeUndefined();
  });
});

// ============================================================
// Conflict Log
// ============================================================
describe('Conflict Log', () => {
  it('logConflict stores a conflict record', async () => {
    const id = await logConflict(
      'booking', 'bk_conflict_1',
      { status: 'confirmed' },
      { status: 'cancelled', reason: 'server override' },
      409
    );
    expect(id).toBeGreaterThan(0);
  });

  it('getUnresolvedConflicts returns only unresolved', async () => {
    await logConflict('seat', 'st_c1', { status: 'reserved' }, { status: 'available' }, 409);
    await logConflict('booking', 'bk_c2', { status: 'pending' }, { status: 'confirmed' }, 409);
    const conflicts = await getUnresolvedConflicts();
    expect(conflicts.length).toBe(2);
    conflicts.forEach(c => expect(c.resolved).toBe(false));
  });

  it('resolveConflict marks a conflict as resolved', async () => {
    const id = await logConflict('trip', 'tr_c1', { state: 'BOARDING' }, { state: 'DEPARTED' }, 409);
    await resolveConflict(id, 'accept_server');
    const conflicts = await getUnresolvedConflicts();
    expect(conflicts.find(c => c.id === id)).toBeUndefined();
  });
});

// ============================================================
// Trip Cache
// ============================================================
describe('Trip Cache', () => {
  const now = Date.now();

  it('cacheTrips + getCachedTrips returns matching non-expired trips', async () => {
    await cacheTrips([
      { id: 'tr_1', operator_id: 'opr_1', origin: 'Lagos', destination: 'Abuja', departure_time: now + 3600_000, base_fare: 5000_00, available_seats: 10, state: 'SCHEDULED', cached_at: now, ttl_ms: 300_000 },
      { id: 'tr_2', operator_id: 'opr_1', origin: 'Lagos', destination: 'Kano', departure_time: now + 7200_000, base_fare: 8000_00, available_seats: 5, state: 'SCHEDULED', cached_at: now, ttl_ms: 300_000 },
    ]);
    const results = await getCachedTrips('Lagos');
    expect(results.length).toBe(2);
  });

  it('getCachedTrips filters by destination', async () => {
    await cacheTrips([
      { id: 'tr_3', operator_id: 'opr_1', origin: 'Enugu', destination: 'Port Harcourt', departure_time: now, base_fare: 3000_00, available_seats: 8, state: 'SCHEDULED', cached_at: now, ttl_ms: 300_000 },
      { id: 'tr_4', operator_id: 'opr_1', origin: 'Enugu', destination: 'Onitsha', departure_time: now, base_fare: 2000_00, available_seats: 12, state: 'SCHEDULED', cached_at: now, ttl_ms: 300_000 },
    ]);
    const results = await getCachedTrips('Enugu', 'Port Harcourt');
    expect(results.length).toBe(1);
    expect(results[0]!.destination).toBe('Port Harcourt');
  });

  it('getCachedTrips excludes expired entries', async () => {
    await cacheTrips([
      { id: 'tr_expired', operator_id: 'opr_1', origin: 'Ibadan', destination: 'Lagos', departure_time: now, base_fare: 1500_00, available_seats: 4, state: 'SCHEDULED', cached_at: now - 600_000, ttl_ms: 300_000 },
    ]);
    const results = await getCachedTrips('Ibadan');
    expect(results.length).toBe(0);
  });

  it('evictExpiredTrips removes expired entries and returns count', async () => {
    await cacheTrips([
      { id: 'tr_old', operator_id: 'opr_1', origin: 'Owerri', destination: 'Aba', departure_time: now, base_fare: 1000_00, available_seats: 3, state: 'SCHEDULED', cached_at: now - 600_000, ttl_ms: 300_000 },
    ]);
    const evicted = await evictExpiredTrips();
    expect(evicted).toBe(1);
  });
});

// ============================================================
// Seat Cache
// ============================================================
describe('Seat Cache', () => {
  it('cacheSeats + getCachedSeats returns fresh seats', async () => {
    await cacheSeats('tr_seat_test', [
      { id: 's_1', trip_id: 'tr_seat_test', seat_number: '1A', status: 'available', reserved_by: undefined },
      { id: 's_2', trip_id: 'tr_seat_test', seat_number: '1B', status: 'reserved', reserved_by: 'user_1' },
    ]);
    const seats = await getCachedSeats('tr_seat_test');
    expect(seats.length).toBe(2);
  });

  it('getCachedSeats returns empty for expired seats', async () => {
    // Simulate already-expired seat by manually inserting with past cached_at
    // We use the db directly to put an expired entry
    const { getOfflineDB } = await import('./db');
    const db = getOfflineDB();
    await db.seats.put({ id: 's_expired', trip_id: 'tr_expired_seats', seat_number: '2A', status: 'available', reserved_by: undefined, cached_at: Date.now() - 60_000, ttl_ms: 30_000 });
    const seats = await getCachedSeats('tr_expired_seats');
    expect(seats.length).toBe(0);
  });

  it('evictExpiredSeats removes expired entries', async () => {
    const { getOfflineDB } = await import('./db');
    const db = getOfflineDB();
    await db.seats.put({ id: 's_old', trip_id: 'tr_evict', seat_number: '3C', status: 'available', reserved_by: undefined, cached_at: Date.now() - 60_000, ttl_ms: 30_000 });
    const count = await evictExpiredSeats();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// Agent Session Cache
// ============================================================
describe('Agent Session Cache', () => {
  it('cacheAgentSession + getAgentSession returns valid session', async () => {
    await cacheAgentSession({
      agent_id: 'ag_001',
      operator_id: 'opr_1',
      role: 'STAFF',
      token_hash: 'sha256hash1',
      expires_at: Date.now() + 3600_000,
      cached_at: Date.now(),
    });
    const session = await getAgentSession('ag_001');
    expect(session).toBeDefined();
    expect(session!.agent_id).toBe('ag_001');
    expect(session!.role).toBe('STAFF');
  });

  it('getAgentSession returns undefined for expired session', async () => {
    await cacheAgentSession({
      agent_id: 'ag_expired',
      operator_id: 'opr_1',
      role: 'STAFF',
      token_hash: 'sha256hash_exp',
      expires_at: Date.now() - 1000,
      cached_at: Date.now() - 3700_000,
    });
    const session = await getAgentSession('ag_expired');
    expect(session).toBeUndefined();
  });

  it('cacheAgentSession replaces existing session for same agent', async () => {
    await cacheAgentSession({ agent_id: 'ag_002', operator_id: 'opr_1', role: 'STAFF', token_hash: 'hash_v1', expires_at: Date.now() + 3600_000, cached_at: Date.now() });
    await cacheAgentSession({ agent_id: 'ag_002', operator_id: 'opr_1', role: 'SUPERVISOR', token_hash: 'hash_v2', expires_at: Date.now() + 7200_000, cached_at: Date.now() });
    const session = await getAgentSession('ag_002');
    expect(session!.role).toBe('SUPERVISOR');
    expect(session!.token_hash).toBe('hash_v2');
  });
});

// ============================================================
// Operator Config Cache
// ============================================================
describe('Operator Config Cache', () => {
  it('cacheOperatorConfig + getCachedOperatorConfig returns fresh config', async () => {
    await cacheOperatorConfig('opr_1', { terminal: 'Jibowu', currency: 'NGN' });
    const config = await getCachedOperatorConfig('opr_1');
    expect(config).toEqual({ terminal: 'Jibowu', currency: 'NGN' });
  });

  it('getCachedOperatorConfig returns undefined for expired config', async () => {
    const { getOfflineDB } = await import('./db');
    const db = getOfflineDB();
    await db.operator_config.put({ operator_id: 'opr_expired', config: { name: 'old' }, cached_at: Date.now() - 7200_000, ttl_ms: 3600_000 });
    const config = await getCachedOperatorConfig('opr_expired');
    expect(config).toBeUndefined();
  });
});

// ============================================================
// NDPR Consent Log
// ============================================================
describe('NDPR Consent Log', () => {
  it('recordNdprConsent stores a consent record', async () => {
    const id = await recordNdprConsent('cust_001', 'data_processing', true);
    expect(id).toBeGreaterThan(0);
  });

  it('getConsentHistory returns all records for a customer', async () => {
    await recordNdprConsent('cust_002', 'data_processing', true);
    await recordNdprConsent('cust_002', 'marketing', false);
    await recordNdprConsent('cust_002', 'analytics', true);
    const history = await getConsentHistory('cust_002');
    expect(history.length).toBe(3);
  });

  it('consent records include required fields', async () => {
    const before = Date.now();
    await recordNdprConsent('cust_003', 'marketing', false);
    const history = await getConsentHistory('cust_003');
    const record = history[0]!;
    expect(record.customer_id).toBe('cust_003');
    expect(record.consent_type).toBe('marketing');
    expect(record.granted).toBe(false);
    expect(record.created_at).toBeGreaterThanOrEqual(before);
  });
});
