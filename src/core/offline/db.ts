/**
 * WebWaka Transport Suite — Offline-First IndexedDB (Dexie v2)
 * Stores pending mutations, offline transactions, offline tickets,
 * cached trip/seat data, agent sessions, conflict logs, and NDPR consent.
 * Invariant: Offline-First — all mutations queue locally before syncing.
 */
import Dexie, { type Table } from 'dexie';

// ============================================================
// Schema types
// ============================================================

export interface OfflineMutation {
  id?: number;
  entity_type: 'trip' | 'seat' | 'booking' | 'transaction' | 'ticket';
  entity_id: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  payload: Record<string, unknown>;
  version: number;
  status: 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';
  retry_count: number;
  next_retry_at: number;    // epoch ms — 0 means retry immediately
  created_at: number;
  synced_at: number | undefined;
  error: string | undefined;
}

export interface OfflineTransaction {
  id?: number;
  local_id: string;
  agent_id: string;
  trip_id: string;
  seat_ids: string[];
  passenger_names: string[];
  total_amount: number; // kobo
  payment_method: 'cash' | 'mobile_money' | 'card';
  idempotencyKey: string;
  retry_count: number;
  error_at: number | undefined;
  created_at: number;
  synced: boolean;
  synced_at: number | undefined;
}

/**
 * OfflineTicket — passenger-facing ticket record.
 * Distinct from OfflineTransaction (agent ledger entry):
 * - carries QR payload for boarding scan
 * - tracks conflict state (seat already booked online)
 * - carries ticket_number for display on the physical receipt
 *
 * Table: `tickets`
 */
export interface OfflineTicket {
  id?: number;
  ticket_number: string;           // locally generated: TKT-<ts>-<random6>
  operator_id: string;
  agent_id: string;
  trip_id: string;
  seat_ids: string[];
  passenger_names: string[];
  fare_kobo: number;               // per-seat fare in kobo
  total_kobo: number;              // seat_ids.length × fare_kobo
  payment_method: 'cash' | 'mobile_money' | 'card';
  /**
   * QR payload encoded into the printable QR code.
   * Format (JSON stringified): { ticket_number, trip_id, seat_ids, agent_id }
   * Scanned by the supervisor boarding-scan endpoint.
   */
  qr_payload: string;
  status: 'draft' | 'confirmed' | 'cancelled';
  synced: boolean;
  synced_at: number | undefined;
  /**
   * Conflict tracking — set when the server returns 409 during sync
   * (e.g., a seat was already confirmed by another agent online).
   */
  conflict_at: number | undefined;
  conflict_reason: string | undefined;
  server_response: Record<string, unknown> | undefined;
  retry_count: number;
  created_at: number;
}

export interface CachedTrip {
  id: string;
  operator_id: string;
  origin: string;
  destination: string;
  departure_time: number;
  base_fare: number; // kobo
  available_seats: number;
  state: string;
  cached_at: number;
  ttl_ms: number; // cache lifetime in ms (default 5 min)
}

export interface CachedSeat {
  id: string;                // seat_id (unique across trips)
  trip_id: string;
  seat_number: string;
  status: 'available' | 'reserved' | 'confirmed' | 'blocked';
  reserved_by: string | undefined;
  cached_at: number;
  ttl_ms: number;            // typically 30s to match server reservation TTL
}

export interface OfflineBooking {
  id?: number;
  local_id: string;
  customer_id: string;
  trip_id: string;
  seat_ids: string[];
  passenger_names: string[];
  total_amount: number; // kobo
  payment_method: string;
  payment_reference: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  created_at: number;
  synced: boolean;
}

/** Cached JWT + profile for offline agent authentication */
export interface AgentSession {
  id?: number;
  agent_id: string;
  operator_id: string;
  name: string;           // Display name for multi-agent switcher UI
  role: string;
  token_hash: string;     // SHA-256 of the JWT (not stored plaintext)
  expires_at: number;     // epoch ms
  cached_at: number;
}

/** Offline grace period: sessions remain valid offline for 8 h after JWT expiry */
export const OFFLINE_GRACE_MS = 8 * 60 * 60 * 1_000;

/** Conflict log: records sync conflicts for auditing / manual resolution */
export interface ConflictRecord {
  id?: number;
  entity_type: OfflineMutation['entity_type'];
  entity_id: string;
  local_payload: Record<string, unknown>;
  server_payload: Record<string, unknown>;
  http_status: number;
  created_at: number;
  resolved: boolean;
}

/** Operator config cache — sourced from TENANT_CONFIG_KV */
export interface CachedOperatorConfig {
  operator_id: string;
  config: Record<string, unknown>;
  cached_at: number;
  ttl_ms: number;
}

/** NDPR consent audit trail */
export interface NdprConsentRecord {
  id?: number;
  customer_id: string;
  consent_type: 'data_processing' | 'marketing' | 'analytics';
  granted: boolean;
  ip_address: string | undefined;
  user_agent: string | undefined;
  created_at: number;
}

// ============================================================
// Database class
// ============================================================

class TransportOfflineDB extends Dexie {
  mutations!: Table<OfflineMutation>;
  transactions!: Table<OfflineTransaction>;
  tickets!: Table<OfflineTicket>;
  trips!: Table<CachedTrip>;
  seats!: Table<CachedSeat>;
  bookings!: Table<OfflineBooking>;
  agent_sessions!: Table<AgentSession>;
  conflict_log!: Table<ConflictRecord>;
  operator_config!: Table<CachedOperatorConfig>;
  ndpr_consent!: Table<NdprConsentRecord>;

  constructor() {
    super('webwaka-transport-offline');

    // v1 schema (preserved for migration compatibility)
    this.version(1).stores({
      mutations: '++id, entity_type, entity_id, status, created_at',
      transactions: '++id, local_id, agent_id, trip_id, synced, created_at',
      trips: 'id, origin, destination, departure_time, state, cached_at',
      bookings: '++id, local_id, customer_id, trip_id, status, synced',
    });

    // v2 schema: adds new fields + new tables
    this.version(2).stores({
      mutations: '++id, entity_type, entity_id, status, next_retry_at, created_at',
      transactions: '++id, local_id, agent_id, trip_id, synced, created_at',
      trips: 'id, operator_id, origin, destination, departure_time, state, cached_at',
      seats: 'id, trip_id, status, cached_at',
      bookings: '++id, local_id, customer_id, trip_id, status, synced',
      agent_sessions: '++id, agent_id, operator_id, expires_at',
      conflict_log: '++id, entity_type, entity_id, created_at, resolved',
      operator_config: 'operator_id, cached_at',
      ndpr_consent: '++id, customer_id, consent_type, created_at',
    }).upgrade(tx => {
      // Backfill next_retry_at for existing mutations
      return tx.table<OfflineMutation>('mutations').toCollection().modify(mut => {
        if (mut.next_retry_at === undefined) {
          mut.next_retry_at = 0;
        }
      });
    });

    // v3 schema: adds idempotencyKey index to transactions
    this.version(3).stores({
      mutations: '++id, entity_type, entity_id, status, next_retry_at, created_at',
      transactions: '++id, local_id, agent_id, trip_id, synced, idempotencyKey, created_at',
      trips: 'id, operator_id, origin, destination, departure_time, state, cached_at',
      seats: 'id, trip_id, status, cached_at',
      bookings: '++id, local_id, customer_id, trip_id, status, synced',
      agent_sessions: '++id, agent_id, operator_id, expires_at',
      conflict_log: '++id, entity_type, entity_id, created_at, resolved',
      operator_config: 'operator_id, cached_at',
      ndpr_consent: '++id, customer_id, consent_type, created_at',
    }).upgrade(tx => {
      // Backfill idempotencyKey and retry_count for existing transactions
      return tx.table<OfflineTransaction>('transactions').toCollection().modify(t => {
        if (!t.idempotencyKey) {
          t.idempotencyKey = `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        }
        if (t.retry_count === undefined) t.retry_count = 0;
        if (t.error_at === undefined) t.error_at = undefined;
        if (t.synced_at === undefined) t.synced_at = undefined;
      });
    });

    /**
     * v4 schema: adds the `tickets` table.
     *
     * `tickets` is a passenger-facing ticket record that differs from
     * `transactions` (the agent's ledger entry) in three key ways:
     *   1. It carries a pre-generated `qr_payload` for boarding scan.
     *   2. It records `conflict_at` / `conflict_reason` when the server
     *      returns 409 (seat already booked online) during sync.
     *   3. It surfaces `ticket_number` for printing on physical receipts.
     *
     * Indexes: ticket_number (unique lookup), trip_id, agent_id, synced,
     *          conflict_at (for the conflict resolution UI).
     */
    this.version(4).stores({
      mutations: '++id, entity_type, entity_id, status, next_retry_at, created_at',
      transactions: '++id, local_id, agent_id, trip_id, synced, idempotencyKey, created_at',
      tickets: '++id, ticket_number, trip_id, agent_id, synced, conflict_at, created_at',
      trips: 'id, operator_id, origin, destination, departure_time, state, cached_at',
      seats: 'id, trip_id, status, cached_at',
      bookings: '++id, local_id, customer_id, trip_id, status, synced',
      agent_sessions: '++id, agent_id, operator_id, expires_at',
      conflict_log: '++id, entity_type, entity_id, created_at, resolved',
      operator_config: 'operator_id, cached_at',
      ndpr_consent: '++id, customer_id, consent_type, created_at',
    });
    // No data migration needed for v4 — tickets table is brand new.
  }
}

// Singleton per browser context
let _db: TransportOfflineDB | null = null;

export function getOfflineDB(): TransportOfflineDB {
  if (!_db) _db = new TransportOfflineDB();
  return _db;
}

// Allow resetting the singleton in tests
// Deletes the fake-indexeddb store so data doesn't bleed between test cases.
export async function _resetOfflineDB(): Promise<void> {
  if (_db) {
    try {
      await _db.delete();
    } catch { /* ignore */ }
    _db = null;
  }
}

// ============================================================
// Mutation Queue Helpers
// ============================================================

export async function queueMutation(
  entity_type: OfflineMutation['entity_type'],
  entity_id: string,
  action: OfflineMutation['action'],
  payload: Record<string, unknown>,
  version = 1
): Promise<number> {
  return getOfflineDB().mutations.add({
    entity_type, entity_id, action, payload, version,
    status: 'PENDING',
    retry_count: 0,
    next_retry_at: 0,
    created_at: Date.now(),
    synced_at: undefined,
    error: undefined,
  });
}

export async function getPendingMutations(): Promise<OfflineMutation[]> {
  const now = Date.now();
  return getOfflineDB().mutations
    .where('status').equals('PENDING')
    .and(m => m.next_retry_at <= now)
    .toArray();
}

export async function markMutationSyncing(id: number): Promise<void> {
  await getOfflineDB().mutations.update(id, { status: 'SYNCING' });
}

export async function markMutationSynced(id: number): Promise<void> {
  await getOfflineDB().mutations.update(id, { status: 'SYNCED', synced_at: Date.now() });
}

export async function markMutationFailed(id: number, error: string, retry_count: number): Promise<void> {
  const backoffMs = Math.min(1_000 * Math.pow(2, retry_count), 32_000);
  await getOfflineDB().mutations.update(id, {
    status: 'PENDING',
    retry_count: retry_count + 1,
    next_retry_at: Date.now() + backoffMs,
    error,
  });
}

export async function markMutationAbandoned(id: number, error: string): Promise<void> {
  await getOfflineDB().mutations.update(id, { status: 'FAILED', error });
}

export async function getPendingMutationCount(): Promise<number> {
  const now = Date.now();
  return getOfflineDB().mutations
    .where('status').equals('PENDING')
    .and(m => m.next_retry_at <= now)
    .count();
}

// ============================================================
// Conflict Log
// ============================================================

export async function logConflict(
  entity_type: ConflictRecord['entity_type'],
  entity_id: string,
  local_payload: Record<string, unknown>,
  server_payload: Record<string, unknown>,
  http_status: number
): Promise<number> {
  return getOfflineDB().conflict_log.add({
    entity_type, entity_id, local_payload, server_payload, http_status,
    created_at: Date.now(),
    resolved: false,
  });
}

export async function getUnresolvedConflicts(): Promise<ConflictRecord[]> {
  return getOfflineDB().conflict_log.filter(c => !c.resolved).toArray();
}

// ============================================================
// Offline Transaction Helpers (TRN-2 Agent POS)
// ============================================================

type NewOfflineTransaction = Omit<OfflineTransaction, 'id' | 'idempotencyKey' | 'retry_count' | 'error_at' | 'synced_at'> & {
  idempotencyKey?: string;
  retry_count?: number;
  error_at?: number;
  synced_at?: number;
};

export async function saveOfflineTransaction(txn: NewOfflineTransaction): Promise<number> {
  const record: Omit<OfflineTransaction, 'id'> = {
    ...txn,
    idempotencyKey: txn.idempotencyKey || `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    retry_count: txn.retry_count ?? 0,
    error_at: txn.error_at,
    synced_at: txn.synced_at,
  };
  return getOfflineDB().transactions.add(record);
}

/** Pending transactions for a specific agent — for the agent POS UI.
 *  Uses a single-field .where() on the indexed agent_id column, then
 *  applies JavaScript filter for synced/retry_count to avoid requiring
 *  a compound index that doesn't exist. */
export async function getPendingTransactions(agent_id: string): Promise<OfflineTransaction[]> {
  const rows = await getOfflineDB().transactions
    .where('agent_id').equals(agent_id)
    .toArray();
  return rows.filter(t => !t.synced && (t.retry_count ?? 0) < 5);
}

/** All pending transactions regardless of agent — for SyncEngine flush.
 *  Uses .filter() instead of .where().equals() to avoid boolean vs 0 IndexedDB
 *  key-type mismatch (IDBKeyRange.only(0) does NOT match stored `false`). */
export async function getAllPendingTransactions(): Promise<OfflineTransaction[]> {
  const all = await getOfflineDB().transactions.toArray();
  return all.filter(t => !t.synced && (t.retry_count ?? 0) < 5);
}

export async function markTransactionSynced(local_id: string): Promise<void> {
  const db = getOfflineDB();
  const txn = await db.transactions.where('local_id').equals(local_id).first();
  if (txn?.id !== undefined) {
    await db.transactions.update(txn.id, { synced: true, synced_at: Date.now() });
  }
}

/** Increment retry_count; set error_at when retry_count reaches 5 */
export async function incrementTransactionRetry(local_id: string): Promise<void> {
  const db = getOfflineDB();
  const txn = await db.transactions.where('local_id').equals(local_id).first();
  if (txn?.id === undefined) return;
  const newCount = (txn.retry_count ?? 0) + 1;
  await db.transactions.update(txn.id, {
    retry_count: newCount,
    error_at: newCount >= 5 ? Date.now() : txn.error_at,
  });
}

// ============================================================
// Offline Ticket Helpers (TRN-2 Agent POS — tickets table)
// ============================================================

/** Generate a human-readable local ticket number, e.g. TKT-1714000000000-a3f7b2 */
export function generateTicketNumber(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `TKT-${ts}-${rand}`;
}

type NewOfflineTicket = Omit<
  OfflineTicket,
  'id' | 'ticket_number' | 'qr_payload' | 'synced' | 'synced_at' | 'conflict_at' | 'conflict_reason' | 'server_response' | 'retry_count' | 'created_at'
> & {
  ticket_number?: string;
  qr_payload?: string;
  created_at?: number;
};

/**
 * Save an offline ticket to Dexie.
 * Automatically:
 *   - generates `ticket_number` if not supplied
 *   - generates `qr_payload` (JSON with ticket_number, trip_id, seat_ids, agent_id)
 * Returns the Dexie auto-increment id.
 */
export async function saveOfflineTicket(ticket: NewOfflineTicket): Promise<number> {
  const ticket_number = ticket.ticket_number ?? generateTicketNumber();
  const qr_payload = ticket.qr_payload ?? JSON.stringify({
    ticket_number,
    trip_id: ticket.trip_id,
    seat_ids: ticket.seat_ids,
    agent_id: ticket.agent_id,
  });

  const record: Omit<OfflineTicket, 'id'> = {
    ...ticket,
    ticket_number,
    qr_payload,
    created_at: ticket.created_at ?? Date.now(),
    synced: false,
    synced_at: undefined,
    conflict_at: undefined,
    conflict_reason: undefined,
    server_response: undefined,
    retry_count: 0,
  };
  return getOfflineDB().tickets.add(record);
}

/** All unsynced tickets (no conflict filter) — for the SyncEngine flush. */
export async function getAllPendingTickets(): Promise<OfflineTicket[]> {
  const all = await getOfflineDB().tickets.toArray();
  return all.filter(t => !t.synced && !t.conflict_at && (t.retry_count ?? 0) < 5);
}

/** Tickets for a specific agent — for the Agent POS "Pending" tab. */
export async function getPendingTickets(agent_id: string): Promise<OfflineTicket[]> {
  const rows = await getOfflineDB().tickets
    .where('agent_id').equals(agent_id)
    .toArray();
  return rows.filter(t => !t.synced && !t.conflict_at);
}

/** Tickets with unresolved seat conflicts — for the conflict resolution UI. */
export async function getConflictedTickets(): Promise<OfflineTicket[]> {
  const all = await getOfflineDB().tickets.toArray();
  return all.filter(t => !!t.conflict_at);
}

export async function markTicketSynced(ticket_number: string, synced_at?: number): Promise<void> {
  const db = getOfflineDB();
  const ticket = await db.tickets.where('ticket_number').equals(ticket_number).first();
  if (ticket?.id !== undefined) {
    await db.tickets.update(ticket.id, {
      synced: true,
      status: 'confirmed',
      synced_at: synced_at ?? Date.now(),
    });
  }
}

/**
 * Mark a ticket as conflicted (409 from server).
 * Conflicted tickets are surfaced in the conflict resolution UI.
 * The agent can choose to: retry (re-queue), accept server state (discard),
 * or transfer the passenger to another seat.
 */
export async function markTicketConflict(
  ticket_number: string,
  reason: string,
  server_response: Record<string, unknown>
): Promise<void> {
  const db = getOfflineDB();
  const ticket = await db.tickets.where('ticket_number').equals(ticket_number).first();
  if (ticket?.id !== undefined) {
    await db.tickets.update(ticket.id, {
      conflict_at: Date.now(),
      conflict_reason: reason,
      server_response,
    });
  }
}

export async function incrementTicketRetry(ticket_number: string): Promise<void> {
  const db = getOfflineDB();
  const ticket = await db.tickets.where('ticket_number').equals(ticket_number).first();
  if (ticket?.id === undefined) return;
  await db.tickets.update(ticket.id, {
    retry_count: (ticket.retry_count ?? 0) + 1,
  });
}

/**
 * Resolve a conflicted ticket.
 * - `retry`: clears conflict flags, resets retry_count so sync picks it up again
 * - `accept_server`: marks the ticket as cancelled (server already confirmed another booking)
 * - `discard`: marks the ticket as cancelled and removes it from the conflict queue
 */
export async function resolveTicketConflict(
  ticket_number: string,
  resolution: 'retry' | 'accept_server' | 'discard'
): Promise<void> {
  const db = getOfflineDB();
  const ticket = await db.tickets.where('ticket_number').equals(ticket_number).first();
  if (ticket?.id === undefined) throw new Error(`Ticket ${ticket_number} not found`);

  if (resolution === 'retry') {
    await db.tickets.update(ticket.id, {
      conflict_at: undefined,
      conflict_reason: undefined,
      server_response: undefined,
      retry_count: 0,
    });
  } else {
    // accept_server or discard — mark cancelled and flag as "resolved"
    await db.tickets.update(ticket.id, {
      status: 'cancelled',
      synced: true,  // treat as resolved so it leaves the pending queue
      synced_at: Date.now(),
    });
  }
}

// ============================================================
// Trip Cache Helpers
// ============================================================

const TRIP_CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

export async function cacheTrips(trips: CachedTrip[]): Promise<void> {
  const now = Date.now();
  const withTTL = trips.map(t => ({
    ...t,
    cached_at: t.cached_at ?? now,
    ttl_ms: t.ttl_ms ?? TRIP_CACHE_TTL_MS,
  }));
  await getOfflineDB().trips.bulkPut(withTTL);
}

export async function getCachedTrips(origin?: string, destination?: string): Promise<CachedTrip[]> {
  const db = getOfflineDB();
  const now = Date.now();
  let query = db.trips.toCollection();
  if (origin) query = db.trips.where('origin').startsWithIgnoreCase(origin);
  const results = await query.toArray();
  // Filter: not expired + optional destination match
  return results.filter(t => {
    const notExpired = now - t.cached_at < t.ttl_ms;
    const destMatch = destination
      ? t.destination.toLowerCase().includes(destination.toLowerCase())
      : true;
    return notExpired && destMatch;
  });
}

export async function evictExpiredTrips(): Promise<number> {
  const db = getOfflineDB();
  const now = Date.now();
  const all = await db.trips.toArray();
  const expired = all.filter(t => now - t.cached_at >= t.ttl_ms);
  if (expired.length === 0) return 0;
  await db.trips.bulkDelete(expired.map(t => t.id));
  return expired.length;
}

// ============================================================
// Seat Cache Helpers (TRN-1 Seat Inventory offline picker)
// ============================================================

const SEAT_CACHE_TTL_MS = 30_000; // 30 seconds — matches server reservation TTL

export async function cacheSeats(trip_id: string, seats: Omit<CachedSeat, 'cached_at' | 'ttl_ms'>[], cached_at?: number): Promise<void> {
  const ts = cached_at ?? Date.now();
  const withMeta = seats.map(s => ({ ...s, cached_at: ts, ttl_ms: SEAT_CACHE_TTL_MS }));
  await getOfflineDB().seats.bulkPut(withMeta);
}

export async function getCachedSeats(trip_id: string): Promise<CachedSeat[]> {
  const now = Date.now();
  const all = await getOfflineDB().seats.where('trip_id').equals(trip_id).toArray();
  return all.filter(s => now - s.cached_at < s.ttl_ms);
}

export async function evictExpiredSeats(): Promise<number> {
  const db = getOfflineDB();
  const now = Date.now();
  const all = await db.seats.toArray();
  const expired = all.filter(s => now - s.cached_at >= s.ttl_ms);
  if (expired.length === 0) return 0;
  await db.seats.bulkDelete(expired.map(s => s.id));
  return expired.length;
}

// ============================================================
// Agent Session Cache (offline auth — TRN-2)
// ============================================================

export async function cacheAgentSession(session: Omit<AgentSession, 'id'>): Promise<number> {
  const db = getOfflineDB();
  // Remove any existing session for this agent
  await db.agent_sessions.where('agent_id').equals(session.agent_id).delete();
  return db.agent_sessions.add(session);
}

export async function getAgentSession(
  agent_id: string,
  opts: { offline?: boolean } = {}
): Promise<(AgentSession & { gracePeriod: boolean }) | undefined> {
  const now = Date.now();
  const session = await getOfflineDB().agent_sessions
    .where('agent_id').equals(agent_id).first();
  if (!session) return undefined;

  const isExpired = session.expires_at < now;

  if (opts.offline) {
    // Offline: grant up to OFFLINE_GRACE_MS beyond JWT expiry
    if (session.expires_at + OFFLINE_GRACE_MS < now) {
      if (session.id !== undefined) await getOfflineDB().agent_sessions.delete(session.id);
      return undefined;
    }
    // gracePeriod: true when JWT has expired but we are within the grace window
    return { ...session, gracePeriod: isExpired };
  } else {
    // Online: strict JWT expiry
    if (isExpired) {
      if (session.id !== undefined) await getOfflineDB().agent_sessions.delete(session.id);
      return undefined;
    }
    return { ...session, gracePeriod: false };
  }
}

/** Return all non-expired agent sessions — used by the multi-agent switcher */
export async function listAgentSessions(): Promise<AgentSession[]> {
  const now = Date.now();
  const all = await getOfflineDB().agent_sessions.toArray();
  return all.filter(s => s.expires_at + OFFLINE_GRACE_MS > now);
}

// ============================================================
// Operator Config Cache
// ============================================================

const CONFIG_CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour

export async function cacheOperatorConfig(
  operator_id: string,
  config: Record<string, unknown>,
  ttl_ms = CONFIG_CACHE_TTL_MS
): Promise<void> {
  await getOfflineDB().operator_config.put({ operator_id, config, cached_at: Date.now(), ttl_ms });
}

export async function getCachedOperatorConfig(
  operator_id: string
): Promise<Record<string, unknown> | undefined> {
  const entry = await getOfflineDB().operator_config.get(operator_id);
  if (!entry) return undefined;
  if (Date.now() - entry.cached_at >= entry.ttl_ms) {
    await getOfflineDB().operator_config.delete(operator_id);
    return undefined;
  }
  return entry.config;
}

// ============================================================
// NDPR Consent Log
// ============================================================

export async function recordNdprConsent(
  customer_id: string,
  consent_type: NdprConsentRecord['consent_type'],
  granted: boolean
): Promise<number> {
  return getOfflineDB().ndpr_consent.add({
    customer_id, consent_type, granted,
    ip_address: undefined,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    created_at: Date.now(),
  });
}

export async function getConsentHistory(customer_id: string): Promise<NdprConsentRecord[]> {
  return getOfflineDB().ndpr_consent.where('customer_id').equals(customer_id).toArray();
}

// ============================================================
// C-003: Conflict Resolution Helpers (generic — mutation level)
// ============================================================

export async function getConflicts(): Promise<ConflictRecord[]> {
  return getOfflineDB().conflict_log
    .where('resolved')
    .equals(0)
    .sortBy('created_at');
}

export async function resolveConflict(
  id: number,
  resolution: 'accept_server' | 'retry' | 'discard'
): Promise<void> {
  const db = getOfflineDB();
  const conflict = await db.conflict_log.get(id);
  if (!conflict) throw new Error(`Conflict ${id} not found`);

  if (resolution === 'retry') {
    // Re-queue the local mutation for another sync attempt
    await db.mutations.add({
      entity_type: conflict.entity_type,
      entity_id: conflict.entity_id,
      action: 'UPDATE',
      payload: conflict.local_payload,
      version: 1,
      status: 'PENDING',
      retry_count: 0,
      next_retry_at: 0,
      created_at: Date.now(),
      synced_at: undefined,
      error: undefined,
    });
  }

  // Mark conflict as resolved (both accept_server and discard close the ticket)
  await db.conflict_log.update(id, { resolved: true });
}
