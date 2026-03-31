/**
 * WebWaka Transport Suite — Offline-First IndexedDB (Dexie v2)
 * Stores pending mutations, offline transactions, cached trip/seat data,
 * agent sessions, conflict logs, and NDPR consent records.
 * Invariant: Offline-First — all mutations queue locally before syncing.
 */
import Dexie, { type Table } from 'dexie';

// ============================================================
// Schema types
// ============================================================

export interface OfflineMutation {
  id?: number;
  entity_type: 'trip' | 'seat' | 'booking' | 'transaction';
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
  created_at: number;
  synced: boolean;
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
  role: string;
  token_hash: string;     // SHA-256 of the JWT (not stored plaintext)
  expires_at: number;     // epoch ms
  cached_at: number;
}

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

export async function saveOfflineTransaction(txn: Omit<OfflineTransaction, 'id'>): Promise<number> {
  return getOfflineDB().transactions.add(txn);
}

export async function getPendingTransactions(agent_id: string): Promise<OfflineTransaction[]> {
  return getOfflineDB().transactions.where({ agent_id, synced: false }).toArray();
}

export async function markTransactionSynced(local_id: string): Promise<void> {
  const db = getOfflineDB();
  const txn = await db.transactions.where('local_id').equals(local_id).first();
  if (txn?.id !== undefined) await db.transactions.update(txn.id, { synced: true });
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

export async function getAgentSession(agent_id: string): Promise<AgentSession | undefined> {
  const now = Date.now();
  const session = await getOfflineDB().agent_sessions
    .where('agent_id').equals(agent_id).first();
  if (!session) return undefined;
  if (session.expires_at < now) {
    if (session.id !== undefined) await getOfflineDB().agent_sessions.delete(session.id);
    return undefined;
  }
  return session;
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
// C-003: Conflict Resolution Helpers
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
