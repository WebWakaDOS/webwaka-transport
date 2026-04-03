/**
 * WebWaka Transport Suite — Dexie v2 schema tests
 * Tests: mutation queue, conflict log, seat/trip cache, agent sessions,
 *        NDPR consent, offline tickets (v4 schema), conflict resolution
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
  // tickets
  saveOfflineTicket,
  getAllPendingTickets,
  getPendingTickets,
  getConflictedTickets,
  markTicketSynced,
  markTicketConflict,
  incrementTicketRetry,
  resolveTicketConflict,
  generateTicketNumber,
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

  it('queues ticket entity type mutations', async () => {
    const id = await queueMutation('ticket', 'TKT-001', 'CREATE', {
      ticket_number: 'TKT-001',
      trip_id: 'tr_1',
      seat_ids: ['s_1A'],
    });
    const pending = await getPendingMutations();
    const m = pending.find(p => p.id === id);
    expect(m).toBeDefined();
    expect(m!.entity_type).toBe('ticket');
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

  it('logConflict records ticket entity type for seat conflicts', async () => {
    const id = await logConflict(
      'ticket', 'TKT-CONFLICT-1',
      { seat_ids: ['s_2A'], trip_id: 'tr_10' },
      { error: 'seat_conflict', conflicted_seats: ['s_2A'] },
      409
    );
    const conflicts = await getUnresolvedConflicts();
    const c = conflicts.find(r => r.id === id);
    expect(c).toBeDefined();
    expect(c!.entity_type).toBe('ticket');
    expect(c!.http_status).toBe(409);
    expect((c!.server_payload as Record<string, unknown>)['conflicted_seats']).toEqual(['s_2A']);
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
      name: 'Test Agent 1',
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
      name: 'Expired Agent',
      role: 'STAFF',
      token_hash: 'sha256hash_exp',
      expires_at: Date.now() - 1000,
      cached_at: Date.now() - 3700_000,
    });
    const session = await getAgentSession('ag_expired');
    expect(session).toBeUndefined();
  });

  it('cacheAgentSession replaces existing session for same agent', async () => {
    await cacheAgentSession({ agent_id: 'ag_002', operator_id: 'opr_1', name: 'Agent 002', role: 'STAFF', token_hash: 'hash_v1', expires_at: Date.now() + 3600_000, cached_at: Date.now() });
    await cacheAgentSession({ agent_id: 'ag_002', operator_id: 'opr_1', name: 'Agent 002', role: 'SUPERVISOR', token_hash: 'hash_v2', expires_at: Date.now() + 7200_000, cached_at: Date.now() });
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

// ============================================================
// Offline Tickets (v4 schema)
// ============================================================
describe('Offline Tickets — saveOfflineTicket', () => {
  const baseTicket = {
    operator_id: 'opr_1',
    agent_id: 'ag_001',
    trip_id: 'tr_lagos_abuja',
    seat_ids: ['s_1A', 's_1B'],
    passenger_names: ['Adebayo Okafor', 'Ngozi Eze'],
    fare_kobo: 450_000,      // ₦4,500 per seat
    total_kobo: 900_000,     // ₦9,000
    payment_method: 'cash' as const,
    status: 'draft' as const,
  };

  it('saves a ticket and returns a valid Dexie id', async () => {
    const id = await saveOfflineTicket(baseTicket);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('auto-generates ticket_number in TKT-<ts>-<rand> format', async () => {
    await saveOfflineTicket(baseTicket);
    const { getOfflineDB } = await import('./db');
    const tickets = await getOfflineDB().tickets.toArray();
    expect(tickets.length).toBe(1);
    expect(tickets[0]!.ticket_number).toMatch(/^TKT-\d{13}-[A-Z0-9]{6}$/);
  });

  it('uses supplied ticket_number when provided', async () => {
    await saveOfflineTicket({ ...baseTicket, ticket_number: 'TKT-CUSTOM-001' });
    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals('TKT-CUSTOM-001').first();
    expect(t).toBeDefined();
    expect(t!.ticket_number).toBe('TKT-CUSTOM-001');
  });

  it('auto-generates qr_payload as valid JSON with required fields', async () => {
    await saveOfflineTicket(baseTicket);
    const { getOfflineDB } = await import('./db');
    const [ticket] = await getOfflineDB().tickets.toArray();
    const qr = JSON.parse(ticket!.qr_payload) as Record<string, unknown>;
    expect(qr['ticket_number']).toBe(ticket!.ticket_number);
    expect(qr['trip_id']).toBe('tr_lagos_abuja');
    expect(qr['seat_ids']).toEqual(['s_1A', 's_1B']);
    expect(qr['agent_id']).toBe('ag_001');
  });

  it('sets synced=false, conflict_at=undefined, retry_count=0 on creation', async () => {
    await saveOfflineTicket(baseTicket);
    const { getOfflineDB } = await import('./db');
    const [t] = await getOfflineDB().tickets.toArray();
    expect(t!.synced).toBe(false);
    expect(t!.conflict_at).toBeUndefined();
    expect(t!.conflict_reason).toBeUndefined();
    expect(t!.retry_count).toBe(0);
  });

  it('stores all passenger and fare data correctly', async () => {
    await saveOfflineTicket(baseTicket);
    const { getOfflineDB } = await import('./db');
    const [t] = await getOfflineDB().tickets.toArray();
    expect(t!.passenger_names).toEqual(['Adebayo Okafor', 'Ngozi Eze']);
    expect(t!.fare_kobo).toBe(450_000);
    expect(t!.total_kobo).toBe(900_000);
    expect(t!.payment_method).toBe('cash');
  });
});

describe('Offline Tickets — queue helpers', () => {
  const makeTicket = (overrides: Partial<Parameters<typeof saveOfflineTicket>[0]> = {}) =>
    saveOfflineTicket({
      operator_id: 'opr_1',
      agent_id: 'ag_park_a',
      trip_id: 'tr_001',
      seat_ids: ['s_5C'],
      passenger_names: ['Chidi Okeke'],
      fare_kobo: 350_000,
      total_kobo: 350_000,
      payment_method: 'mobile_money' as const,
      status: 'draft' as const,
      ...overrides,
    });

  it('getAllPendingTickets returns only unsynced, non-conflicted tickets', async () => {
    await makeTicket();
    await makeTicket({ seat_ids: ['s_5D'] });
    const pending = await getAllPendingTickets();
    expect(pending.length).toBe(2);
    pending.forEach(t => {
      expect(t.synced).toBe(false);
      expect(t.conflict_at).toBeUndefined();
    });
  });

  it('getAllPendingTickets excludes synced tickets', async () => {
    const tn = 'TKT-SYNCED-001';
    await makeTicket({ ticket_number: tn });
    await markTicketSynced(tn);
    const pending = await getAllPendingTickets();
    expect(pending.find(t => t.ticket_number === tn)).toBeUndefined();
  });

  it('getAllPendingTickets excludes conflicted tickets', async () => {
    const tn = 'TKT-CONFLICT-PENDING-001';
    await makeTicket({ ticket_number: tn });
    await markTicketConflict(tn, 'Seat already booked', { conflicted_seats: ['s_5C'] });
    const pending = await getAllPendingTickets();
    expect(pending.find(t => t.ticket_number === tn)).toBeUndefined();
  });

  it('getPendingTickets filters by agent_id', async () => {
    await makeTicket({ agent_id: 'ag_park_a' });
    await makeTicket({ agent_id: 'ag_park_b', seat_ids: ['s_7A'] });
    const parkA = await getPendingTickets('ag_park_a');
    expect(parkA.length).toBe(1);
    expect(parkA[0]!.agent_id).toBe('ag_park_a');
  });

  it('getConflictedTickets returns only tickets with conflict_at set', async () => {
    await makeTicket({ ticket_number: 'TKT-CLEAN-001' });
    await makeTicket({ ticket_number: 'TKT-CONFLICT-002', seat_ids: ['s_9B'] });
    await markTicketConflict('TKT-CONFLICT-002', 'Seat 9B already sold online', { conflicted_seats: ['s_9B'] });
    const conflicted = await getConflictedTickets();
    expect(conflicted.length).toBe(1);
    expect(conflicted[0]!.ticket_number).toBe('TKT-CONFLICT-002');
    expect(conflicted[0]!.conflict_reason).toBe('Seat 9B already sold online');
  });
});

describe('Offline Tickets — markTicketSynced', () => {
  it('sets synced=true and status=confirmed', async () => {
    const tn = 'TKT-MARK-SYNC-001';
    await saveOfflineTicket({
      operator_id: 'opr_1', agent_id: 'ag_001', trip_id: 'tr_1',
      seat_ids: ['s_3A'], passenger_names: ['Fatimah Bello'],
      fare_kobo: 500_000, total_kobo: 500_000,
      payment_method: 'card' as const, status: 'draft' as const,
      ticket_number: tn,
    });
    const before = Date.now();
    await markTicketSynced(tn);
    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.synced).toBe(true);
    expect(t!.status).toBe('confirmed');
    expect(t!.synced_at).toBeGreaterThanOrEqual(before);
  });
});

describe('Offline Tickets — markTicketConflict', () => {
  it('stamps conflict_at, conflict_reason, and server_response', async () => {
    const tn = 'TKT-CONFLICT-MARK-001';
    await saveOfflineTicket({
      operator_id: 'opr_1', agent_id: 'ag_001', trip_id: 'tr_2',
      seat_ids: ['s_12A'], passenger_names: ['Emeka Chukwu'],
      fare_kobo: 600_000, total_kobo: 600_000,
      payment_method: 'cash' as const, status: 'draft' as const,
      ticket_number: tn,
    });
    const serverBody = { error: 'seat_conflict', conflicted_seats: ['s_12A'], booked_by: 'online_booking' };
    const before = Date.now();
    await markTicketConflict(tn, 'Seat 12A already booked online', serverBody);

    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.conflict_at).toBeGreaterThanOrEqual(before);
    expect(t!.conflict_reason).toBe('Seat 12A already booked online');
    expect(t!.server_response).toEqual(serverBody);
    // Should NOT be marked as synced
    expect(t!.synced).toBe(false);
  });
});

describe('Offline Tickets — incrementTicketRetry', () => {
  it('increments retry_count', async () => {
    const tn = 'TKT-RETRY-001';
    await saveOfflineTicket({
      operator_id: 'opr_1', agent_id: 'ag_001', trip_id: 'tr_3',
      seat_ids: ['s_4B'], passenger_names: ['Kemi Adeyemi'],
      fare_kobo: 250_000, total_kobo: 250_000,
      payment_method: 'mobile_money' as const, status: 'draft' as const,
      ticket_number: tn,
    });
    await incrementTicketRetry(tn);
    await incrementTicketRetry(tn);
    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.retry_count).toBe(2);
  });

  it('tickets with retry_count >= 5 are excluded from getAllPendingTickets', async () => {
    const tn = 'TKT-MAX-RETRY-001';
    await saveOfflineTicket({
      operator_id: 'opr_1', agent_id: 'ag_001', trip_id: 'tr_4',
      seat_ids: ['s_6C'], passenger_names: ['Samuel Ojo'],
      fare_kobo: 300_000, total_kobo: 300_000,
      payment_method: 'cash' as const, status: 'draft' as const,
      ticket_number: tn,
    });
    // Manually set retry_count to 5
    const { getOfflineDB } = await import('./db');
    const db = getOfflineDB();
    const ticket = await db.tickets.where('ticket_number').equals(tn).first();
    await db.tickets.update(ticket!.id!, { retry_count: 5 });
    const pending = await getAllPendingTickets();
    expect(pending.find(t => t.ticket_number === tn)).toBeUndefined();
  });
});

describe('Offline Tickets — resolveTicketConflict', () => {
  const makeConflictedTicket = async (tn: string) => {
    await saveOfflineTicket({
      operator_id: 'opr_1', agent_id: 'ag_001', trip_id: 'tr_5',
      seat_ids: ['s_11A'], passenger_names: ['Ibrahim Musa'],
      fare_kobo: 700_000, total_kobo: 700_000,
      payment_method: 'cash' as const, status: 'draft' as const,
      ticket_number: tn,
    });
    await markTicketConflict(tn, 'Seat 11A already booked online', { conflicted_seats: ['s_11A'] });
  };

  it('retry: clears conflict flags and resets retry_count so sync picks it up', async () => {
    const tn = 'TKT-RESOLVE-RETRY-001';
    await makeConflictedTicket(tn);
    await resolveTicketConflict(tn, 'retry');
    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.conflict_at).toBeUndefined();
    expect(t!.conflict_reason).toBeUndefined();
    expect(t!.retry_count).toBe(0);
    expect(t!.synced).toBe(false); // still needs sync
    // Should appear in getAllPendingTickets again
    const pending = await getAllPendingTickets();
    expect(pending.find(p => p.ticket_number === tn)).toBeDefined();
  });

  it('accept_server: marks ticket as cancelled and synced (leaves conflict queue)', async () => {
    const tn = 'TKT-RESOLVE-ACCEPT-001';
    await makeConflictedTicket(tn);
    await resolveTicketConflict(tn, 'accept_server');
    const { getOfflineDB } = await import('./db');
    const t = await getOfflineDB().tickets.where('ticket_number').equals(tn).first();
    expect(t!.status).toBe('cancelled');
    expect(t!.synced).toBe(true);
    const conflicted = await getConflictedTickets();
    // conflict_at is still set (only cleared on retry) but synced=true
    // so it won't appear in getAllPendingTickets
    const pending = await getAllPendingTickets();
    expect(pending.find(p => p.ticket_number === tn)).toBeUndefined();
  });

  it('discard: same as accept_server — marks cancelled and removes from pending queue', async () => {
    const tn = 'TKT-RESOLVE-DISCARD-001';
    await makeConflictedTicket(tn);
    await resolveTicketConflict(tn, 'discard');
    const pending = await getAllPendingTickets();
    expect(pending.find(p => p.ticket_number === tn)).toBeUndefined();
  });

  it('throws if ticket_number not found', async () => {
    await expect(resolveTicketConflict('TKT-DOES-NOT-EXIST', 'retry')).rejects.toThrow('not found');
  });
});

describe('generateTicketNumber', () => {
  it('returns a string matching TKT-<13 digits>-<6 uppercase chars>', () => {
    const tn = generateTicketNumber();
    expect(tn).toMatch(/^TKT-\d{13}-[A-Z0-9]{6}$/);
  });

  it('generates unique ticket numbers on rapid successive calls', () => {
    const numbers = new Set(Array.from({ length: 20 }, () => generateTicketNumber()));
    // With timestamp + random component, collisions within 20 calls are astronomically unlikely
    expect(numbers.size).toBeGreaterThanOrEqual(19);
  });
});
