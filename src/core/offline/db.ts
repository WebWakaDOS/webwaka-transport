/**
 * WebWaka Transport Suite — Offline-First IndexedDB (Dexie)
 * Stores pending mutations, offline transactions, and cached trip data
 * Invariant: Offline-First — all mutations queue locally before syncing
 */
import Dexie, { type Table } from 'dexie';

export interface OfflineMutation {
  id?: number;
  entity_type: 'trip' | 'seat' | 'booking' | 'transaction';
  entity_id: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  payload: Record<string, unknown>;
  version: number;
  status: 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';
  retry_count: number;
  created_at: number;
  synced_at?: number;
  error?: string;
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

class TransportOfflineDB extends Dexie {
  mutations!: Table<OfflineMutation>;
  transactions!: Table<OfflineTransaction>;
  trips!: Table<CachedTrip>;
  bookings!: Table<OfflineBooking>;

  constructor() {
    super('webwaka-transport-offline');
    this.version(1).stores({
      mutations: '++id, entity_type, entity_id, status, created_at',
      transactions: '++id, local_id, agent_id, trip_id, synced, created_at',
      trips: 'id, origin, destination, departure_time, state, cached_at',
      bookings: '++id, local_id, customer_id, trip_id, status, synced',
    });
  }
}

// Singleton per browser context
let _db: TransportOfflineDB | null = null;

export function getOfflineDB(): TransportOfflineDB {
  if (!_db) _db = new TransportOfflineDB();
  return _db;
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
  const db = getOfflineDB();
  return db.mutations.add({
    entity_type, entity_id, action, payload, version,
    status: 'PENDING', retry_count: 0, created_at: Date.now(),
  });
}

export async function getPendingMutations(): Promise<OfflineMutation[]> {
  return getOfflineDB().mutations.where('status').equals('PENDING').toArray();
}

export async function markMutationSynced(id: number): Promise<void> {
  await getOfflineDB().mutations.update(id, { status: 'SYNCED', synced_at: Date.now() });
}

export async function markMutationFailed(id: number, error: string): Promise<void> {
  const db = getOfflineDB();
  const mut = await db.mutations.get(id);
  if (mut) {
    await db.mutations.update(id, {
      status: 'FAILED',
      retry_count: (mut.retry_count ?? 0) + 1,
      error,
    });
  }
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
  if (txn?.id) await db.transactions.update(txn.id, { synced: true });
}

// ============================================================
// Trip Cache Helpers
// ============================================================

export async function cacheTrips(trips: CachedTrip[]): Promise<void> {
  const db = getOfflineDB();
  await db.trips.bulkPut(trips);
}

export async function getCachedTrips(origin?: string, destination?: string): Promise<CachedTrip[]> {
  const db = getOfflineDB();
  let query = db.trips.toCollection();
  if (origin) query = db.trips.where('origin').startsWithIgnoreCase(origin);
  const results = await query.toArray();
  if (destination) return results.filter(t => t.destination.toLowerCase().includes(destination.toLowerCase()));
  return results;
}

export async function getPendingMutationCount(): Promise<number> {
  return getOfflineDB().mutations.where('status').equals('PENDING').count();
}
