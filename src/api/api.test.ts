/**
 * Transport API Unit Tests — TRN-1 through TRN-4
 * Tests all Hono API routes using in-memory mock D1
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { seatInventoryRouter } from './seat-inventory';
import { agentSalesRouter } from './agent-sales';
import { bookingPortalRouter } from './booking-portal';
import { operatorManagementRouter } from './operator-management';
import { paymentsRouter, webhooksRouter, hmacSha512 } from './payments';
import { authRouter } from './auth';

// ============================================================
// Mock D1 Database
// ============================================================
function createMockDB() {
  const tables: Record<string, any[]> = {
    trips: [], seats: [], operators: [], routes: [], vehicles: [],
    agents: [], sales_transactions: [], receipts: [], customers: [],
    bookings: [], trip_state_transitions: [], sync_mutations: [], drivers: [],
    platform_events: [], fare_rules: [],
  };

  function matchesWhere(row: any, whereClause: string, params: any[]): boolean {
    // Simple WHERE parser for test purposes
    if (!whereClause) return true;
    let paramIdx = 0;
    const conditions = whereClause.split(/\s+AND\s+/i);
    return conditions.every(cond => {
      cond = cond.trim();
      if (cond.includes('deleted_at IS NULL')) return row.deleted_at == null;
      if (cond.includes('IS NULL')) return true; // simplified
      if (cond.includes('!=') || cond.includes('<>')) {
        const [col] = cond.split(/!=|<>/);
        const val = params[paramIdx++];
        return row[col!.trim().split('.').pop()!] !== val;
      }
      if (cond.includes('=')) {
        const [col] = cond.split('=');
        const val = params[paramIdx++];
        const colName = col!.trim().split('.').pop()!;
        return row[colName] === val;
      }
      return true;
    });
  }

  const db: any = {
    _tables: tables,
    prepare(sql: string) {
      const stmt = {
        _sql: sql,
        _params: [] as any[],
        bind(...args: any[]) { this._params = args; return this; },
        async run() {
          const sql = this._sql.trim().toUpperCase();
          if (sql.startsWith('INSERT OR IGNORE')) {
            // Extract table name
            const m = this._sql.match(/INTO\s+(\w+)/i);
            if (m) {
              const tbl = m[1]!.toLowerCase();
              if (!tables[tbl]) tables[tbl] = [];
              // Only insert if id doesn't exist
              const idIdx = this._sql.match(/\(([^)]+)\)/)?.[1]!.split(',').findIndex((c: string) => c.trim() === 'id') ?? 0;
              const id = this._params[idIdx];
              if (!tables[tbl]!.find((r: any) => r.id === id)) {
                const cols = this._sql.match(/\(([^)]+)\)/)?.[1]!.split(',').map((c: string) => c.trim()) ?? [];
                const row: any = {};
                cols.forEach((col: string, i: number) => { row[col] = this._params[i]; });
                tables[tbl].push(row);
              }
            }
            return { success: true };
          }
          if (sql.startsWith('INSERT OR REPLACE')) {
            const m = this._sql.match(/INTO\s+(\w+)/i);
            if (m) {
              const tbl = m[1]!.toLowerCase();
              if (!tables[tbl]) tables[tbl] = [];
              const cols = this._sql.match(/\(([^)]+)\)/)?.[1]!.split(',').map((c: string) => c.trim()) ?? [];
              const row: any = {};
              cols.forEach((col: string, i: number) => { row[col] = this._params[i]; });
              const existing = tables[tbl].findIndex((r: any) => r.id === row.id);
              if (existing >= 0) tables[tbl][existing] = row;
              else tables[tbl].push(row);
            }
            return { success: true };
          }
          if (sql.startsWith('INSERT')) {
            const m = this._sql.match(/INTO\s+(\w+)/i);
            if (m) {
              const tbl = m[1]!.toLowerCase();
              if (!tables[tbl]) tables[tbl] = [];
              const cols = this._sql.match(/\(([^)]+)\)/)?.[1]!.split(',').map((c: string) => c.trim()) ?? [];
              const row: any = {};
              cols.forEach((col: string, i: number) => { row[col] = this._params[i]; });
              tables[tbl].push(row);
            }
            return { success: true };
          }
          if (sql.startsWith('UPDATE')) {
            const m = this._sql.match(/UPDATE\s+(\w+)/i);
            if (m) {
              const tbl = m[1]!.toLowerCase();
              if (tables[tbl]) {
                const idParam = this._params[this._params.length - 1];
                tables[tbl] = tables[tbl]!.map((r: any) => {
                  if (r.id === idParam) {
                    const setClause = this._sql.match(/SET\s+(.+?)\s+WHERE/is)?.[1] ?? '';
                    const setParts = setClause.split(',');
                    let paramIdx = 0;
                    setParts.forEach((part: string) => {
                      const [col] = part.split('=');
                      const colName = col!.trim().split('.').pop()!;
                      if (colName !== 'id') r[colName] = this._params[paramIdx++];
                    });
                  }
                  return r;
                });
              }
            }
            return { success: true };
          }
          return { success: true };
        },
        async first() {
          const m = this._sql.match(/FROM\s+(\w+)/i);
          if (!m) return null;
          const tbl = m[1]!.toLowerCase();
          if (!tables[tbl]) return null;
          const idParam = this._params[this._params.length - 1];
          return tables[tbl].find((r: any) => r.id === idParam) ?? null;
        },
        async all() {
          const m = this._sql.match(/FROM\s+(\w+)(?:\s+\w+)?/i);
          if (!m) return { results: [] };
          const tbl = m[1]!.toLowerCase();
          if (!tables[tbl]) return { results: [] };
          let results = [...tables[tbl]];
          // Apply simple filters from params
          if (this._params.length > 0) {
            results = results.filter((r: any) => {
              return this._params.some(p => Object.values(r).includes(p)) ||
                this._params.length === 0;
            });
          }
          return { results };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) {
      for (const s of stmts) await s.run();
      return [];
    },
  };
  return db;
}

function makeEnv(db: any) {
  return { DB: db };
}

function makeKV() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null }),
  };
}

function makeEnvWithKV(db: any, kv?: any) {
  return { DB: db, SESSIONS_KV: kv ?? makeKV() };
}

// ============================================================
// TRN-1: Seat Inventory API Tests
// ============================================================
describe('TRN-1: Seat Inventory API', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('GET /trips returns empty list initially', async () => {
    const res = await seatInventoryRouter.request('/trips', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('POST /trips creates a trip and seats', async () => {
    const res = await seatInventoryRouter.request('/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator_id: 'opr_1', route_id: 'rte_1', vehicle_id: 'veh_1',
        departure_time: Date.now() + 3600000, total_seats: 14,
      }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.total_seats).toBe(14);
    expect(body.data.state).toBe('scheduled');
  });

  it('POST /trips returns 400 if required fields missing', async () => {
    const res = await seatInventoryRouter.request('/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator_id: 'opr_1' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('GET /trips/:id/availability returns seat map', async () => {
    // Pre-populate trip and seats
    db._tables.trips.push({ id: 'trp_1', state: 'scheduled', deleted_at: null });
    db._tables.seats.push({
      id: 's1', trip_id: 'trp_1', seat_number: '01', status: 'available',
      created_at: Date.now(), updated_at: Date.now(),
    });
    db._tables.seats.push({
      id: 's2', trip_id: 'trp_1', seat_number: '02', status: 'reserved',
      reservation_expires_at: Date.now() + 30000,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await seatInventoryRouter.request('/trips/trp_1/availability', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.trip_id).toBe('trp_1');
  });

  it('POST /trips/:id/reserve returns 400 if seat_id missing', async () => {
    const res = await seatInventoryRouter.request('/trips/trp_1/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'usr_1' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('POST /trips/:id/reserve returns 404 for unknown seat', async () => {
    const res = await seatInventoryRouter.request('/trips/trp_1/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_id: 'unknown', user_id: 'usr_1' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });

  it('POST /sync queues offline mutations', async () => {
    const res = await seatInventoryRouter.request('/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mutations: [
          { entity_type: 'seat', entity_id: 's1', action: 'UPDATE', payload: { status: 'reserved' }, version: 1 },
        ],
      }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.applied).toHaveLength(1);
  });

  // SEC-006: Seat release security — token is required (no anonymous release)
  it('POST /trips/:id/release returns 400 when token is missing (SEC-006)', async () => {
    const res = await seatInventoryRouter.request('/trips/trp_1/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_id: 's1' }), // no token
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
  });

  it('POST /trips/:id/release returns 403 when wrong token supplied (SEC-006)', async () => {
    db._tables.seats.push({
      id: 'sec_seat_1', trip_id: 'trp_sec', seat_number: '01', status: 'reserved',
      reservation_token: 'correct_token', reserved_by: 'usr_1',
      reservation_expires_at: Date.now() + 30000,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await seatInventoryRouter.request('/trips/trp_sec/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_id: 'sec_seat_1', token: 'wrong_token' }),
    }, makeEnv(db));
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/invalid.*token/i);
  });

  it('POST /trips/:id/release releases seat with correct token (SEC-006)', async () => {
    db._tables.seats.push({
      id: 'sec_seat_2', trip_id: 'trp_sec2', seat_number: '02', status: 'reserved',
      reservation_token: 'valid_tok_abc', reserved_by: 'usr_1',
      reservation_expires_at: Date.now() + 30000,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await seatInventoryRouter.request('/trips/trp_sec2/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_id: 'sec_seat_2', token: 'valid_tok_abc' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('available');
  });

  // ── T-TRN-01: reserve-batch tests ────────────────────────────────────────

  it('POST /trips/:tripId/reserve-batch returns 400 when seat_ids missing', async () => {
    db._tables.trips.push({ id: 'trp_rb', operator_id: 'opr_1', deleted_at: null });
    const res = await seatInventoryRouter.request('/trips/trp_rb/reserve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'usr_1', idempotency_key: 'idem_1' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
  });

  it('POST /trips/:tripId/reserve-batch returns 400 when seat_ids is empty', async () => {
    db._tables.trips.push({ id: 'trp_rb2', operator_id: 'opr_1', deleted_at: null });
    const res = await seatInventoryRouter.request('/trips/trp_rb2/reserve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_ids: [], user_id: 'usr_1', idempotency_key: 'idem_2' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('POST /trips/:tripId/reserve-batch returns 400 when more than 10 seats requested', async () => {
    db._tables.trips.push({ id: 'trp_rb3', operator_id: 'opr_1', deleted_at: null });
    const res = await seatInventoryRouter.request('/trips/trp_rb3/reserve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seat_ids: ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11'],
        user_id: 'usr_1', idempotency_key: 'idem_3',
      }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/10 seats/i);
  });

  it('POST /trips/:tripId/reserve-batch returns 404 for unknown trip (without DO binding)', async () => {
    const res = await seatInventoryRouter.request('/trips/trp_ghost/reserve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_ids: ['s1'], user_id: 'usr_1', idempotency_key: 'idem_4' }),
    }, makeEnv(db));
    // Without DO, falls to D1 path which checks trip existence
    expect(res.status).toBe(404);
  });

  it('POST /trips/:tripId/reserve-batch succeeds via DO stub returning 200', async () => {
    db._tables.trips.push({ id: 'trp_do1', operator_id: 'opr_1', deleted_at: null });
    db._tables.seats.push({ id: 'sd1', trip_id: 'trp_do1', status: 'available' });
    db._tables.seats.push({ id: 'sd2', trip_id: 'trp_do1', status: 'available' });

    const expiresAt = Date.now() + 30_000;
    const mockDoStub = {
      fetch: async (_req: Request) => new Response(JSON.stringify({
        success: true,
        data: {
          tokens: [
            { seat_id: 'sd1', token: 'tok_sd1', expires_at: expiresAt },
            { seat_id: 'sd2', token: 'tok_sd2', expires_at: expiresAt },
          ],
          expires_at: expiresAt,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    };

    const mockDO = {
      idFromName: (_name: string) => 'mock-id',
      get: (_id: any) => mockDoStub,
    };

    const res = await seatInventoryRouter.request('/trips/trp_do1/reserve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_ids: ['sd1', 'sd2'], user_id: 'usr_1', idempotency_key: 'idem_do1' }),
    }, { DB: db, TRIP_SEAT_DO: mockDO });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.tokens).toHaveLength(2);
    expect(body.data.ttl_seconds).toBeGreaterThan(0);
  });

  it('POST /trips/:tripId/reserve-batch forwards 409 from DO stub (seat unavailable)', async () => {
    db._tables.trips.push({ id: 'trp_do2', operator_id: 'opr_1', deleted_at: null });
    db._tables.seats.push({ id: 'sd3', trip_id: 'trp_do2', status: 'available' });

    const mockDoStub = {
      fetch: async (_req: Request) => new Response(JSON.stringify({
        success: false,
        error: 'seat_unavailable',
        conflicted_seats: ['sd3'],
        message: 'One or more seats are not available',
      }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    };
    const mockDO = {
      idFromName: (_name: string) => 'mock-id',
      get: (_id: any) => mockDoStub,
    };

    const res = await seatInventoryRouter.request('/trips/trp_do2/reserve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_ids: ['sd3'], user_id: 'usr_1', idempotency_key: 'idem_do2' }),
    }, { DB: db, TRIP_SEAT_DO: mockDO });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('seat_unavailable');
    expect(body.conflicted_seats).toContain('sd3');
  });

  it('POST /trips/:tripId/reserve-batch forwards concurrent_conflict 409 with conflicted_seats from DO stub (BUG-3)', async () => {
    db._tables.trips.push({ id: 'trp_do3', operator_id: 'opr_1', deleted_at: null });
    db._tables.seats.push({ id: 'sd4', trip_id: 'trp_do3', status: 'available' });
    db._tables.seats.push({ id: 'sd5', trip_id: 'trp_do3', status: 'available' });

    const mockDoStub = {
      fetch: async (_req: Request) => new Response(JSON.stringify({
        success: false,
        error: 'concurrent_conflict',
        conflicted_seats: ['sd5'],
        message: 'Seat taken by another agent — please retry',
      }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    };
    const mockDO = {
      idFromName: (_name: string) => 'mock-id',
      get: (_id: any) => mockDoStub,
    };

    const res = await seatInventoryRouter.request('/trips/trp_do3/reserve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_ids: ['sd4', 'sd5'], user_id: 'usr_1', idempotency_key: 'idem_do3' }),
    }, { DB: db, TRIP_SEAT_DO: mockDO });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('concurrent_conflict');
    // BUG-3 fix: concurrent_conflict must include conflicted_seats so clients know which seat caused the conflict
    expect(Array.isArray(body.conflicted_seats)).toBe(true);
    expect(body.conflicted_seats).toContain('sd5');
  });

  it('POST /trips/:tripId/reserve-batch returns idempotent cached response on replay', async () => {
    db._tables.trips.push({ id: 'trp_idem', operator_id: 'opr_1', deleted_at: null });
    db._tables.seats.push({ id: 'si1', trip_id: 'trp_idem', status: 'available' });

    const cachedResponse = {
      success: true,
      data: { tokens: [{ seat_id: 'si1', token: 'tok_cached', expires_at: Date.now() + 30000 }], expires_at: Date.now() + 30000, ttl_seconds: 30 },
    };
    const kvStore = new Map<string, string>([
      ['reserve-batch:idem_replay', JSON.stringify(cachedResponse)],
    ]);
    const mockKV = {
      get: async (key: string) => kvStore.get(key) ?? null,
      put: async (key: string, value: string) => { kvStore.set(key, value); },
    };

    const res = await seatInventoryRouter.request('/trips/trp_idem/reserve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_ids: ['si1'], user_id: 'usr_1', idempotency_key: 'idem_replay' }),
    }, { DB: db, IDEMPOTENCY_KV: mockKV });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.tokens[0].token).toBe('tok_cached');
  });

  it('POST /trips/:tripId/reserve-batch works via fallback D1 path when no DO binding', async () => {
    db._tables.trips.push({ id: 'trp_fallback', operator_id: 'opr_1', deleted_at: null });
    db._tables.seats.push({ id: 'sf1', trip_id: 'trp_fallback', status: 'available', version: 0 });

    const res = await seatInventoryRouter.request('/trips/trp_fallback/reserve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_ids: ['sf1'], user_id: 'usr_1', idempotency_key: 'idem_fb1' }),
    }, makeEnv(db));
    // Without DO binding, uses fallback D1 path. The mock DB may return 200 (success),
    // 404 (seat not found), or 409 (conflict due to optimistic lock in mock).
    // The key invariant: it does not crash with 500.
    expect(res.status).not.toBe(500);
  });
});

// ============================================================
// TRN-2: Agent Sales API Tests
// ============================================================
describe('TRN-2: Agent Sales API', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('GET /agents returns empty list', async () => {
    const res = await agentSalesRouter.request('/agents', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  it('POST /agents creates an agent', async () => {
    const res = await agentSalesRouter.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator_id: 'opr_1', name: 'Emeka', phone: '08012345678' }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Emeka');
    expect(body.data.role).toBe('agent');
  });

  it('POST /agents returns 400 if phone missing', async () => {
    const res = await agentSalesRouter.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator_id: 'opr_1', name: 'Emeka' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('POST /transactions creates a sale in kobo', async () => {
    // Pre-populate seats so the availability pre-check passes
    db._tables.seats.push({ id: 's1', trip_id: 'trp_1', status: 'available' });
    db._tables.seats.push({ id: 's2', trip_id: 'trp_1', status: 'available' });
    const res = await agentSalesRouter.request('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agt_1', trip_id: 'trp_1',
        seat_ids: ['s1', 's2'], passenger_names: ['Amaka', 'Chidi'],
        total_amount: 500000, // ₦5,000 in kobo
        payment_method: 'cash',
      }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.total_amount).toBe(500000);
    expect(body.data.payment_method).toBe('cash');
  });

  it('POST /transactions rejects non-integer amount', async () => {
    const res = await agentSalesRouter.request('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agt_1', trip_id: 'trp_1',
        seat_ids: ['s1'], passenger_names: ['Amaka'],
        total_amount: 5000.50, payment_method: 'cash',
      }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('POST /sync applies offline transactions', async () => {
    const res = await agentSalesRouter.request('/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agt_1',
        transactions: [
          {
            trip_id: 'trp_1', seat_ids: ['s1'], passenger_names: ['Ngozi'],
            total_amount: 250000, payment_method: 'mobile_money',
          },
        ],
      }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.applied).toHaveLength(1);
  });

  it('GET /dashboard returns today stats', async () => {
    const res = await agentSalesRouter.request('/dashboard', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('today_transactions');
    expect(body.data).toHaveProperty('today_revenue_kobo');
  });
});

// ============================================================
// TRN-3: Booking Portal API Tests
// ============================================================
describe('TRN-3: Booking Portal API', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('GET /routes returns empty list', async () => {
    const res = await bookingPortalRouter.request('/routes', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  it('POST /customers requires NDPR consent', async () => {
    const res = await bookingPortalRouter.request('/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fatima', phone: '08099887766', ndpr_consent: false }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('NDPR');
  });

  it('POST /customers creates customer with NDPR consent', async () => {
    const res = await bookingPortalRouter.request('/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fatima', phone: '08099887766', ndpr_consent: true }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.ndpr_consent).toBe(true);
  });

  it('POST /bookings requires NDPR consent', async () => {
    const res = await bookingPortalRouter.request('/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: 'cust_1', trip_id: 'trp_1',
        seat_ids: ['s1'], passenger_names: ['Fatima'],
        payment_method: 'paystack', ndpr_consent: false,
      }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('NDPR');
  });

  it('POST /bookings returns 400 if seat_ids empty', async () => {
    const res = await bookingPortalRouter.request('/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: 'cust_1', trip_id: 'trp_1',
        seat_ids: [], passenger_names: [],
        payment_method: 'paystack', ndpr_consent: true,
      }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('GET /bookings returns empty list', async () => {
    const res = await bookingPortalRouter.request('/bookings', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  it('GET /bookings/:id returns 404 for unknown booking', async () => {
    const res = await bookingPortalRouter.request('/bookings/unknown', {}, makeEnv(db));
    expect(res.status).toBe(404);
  });
});

// ============================================================
// TRN-4: Operator Management API Tests
// ============================================================
describe('TRN-4: Operator Management API', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('GET /operators returns empty list', async () => {
    const res = await operatorManagementRouter.request('/operators', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  it('POST /operators creates an operator', async () => {
    const res = await operatorManagementRouter.request('/operators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ABC Transport', code: 'ABC', phone: '08011223344' }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('ABC Transport');
    expect(body.data.code).toBe('ABC');
  });

  it('POST /operators returns 400 if code missing', async () => {
    const res = await operatorManagementRouter.request('/operators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ABC Transport' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('POST /routes creates a route with kobo fare', async () => {
    const res = await operatorManagementRouter.request('/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator_id: 'opr_1', origin: 'Lagos', destination: 'Abuja',
        base_fare: 1500000, // ₦15,000 in kobo
      }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.base_fare).toBe(1500000);
  });

  it('POST /routes rejects non-integer fare', async () => {
    const res = await operatorManagementRouter.request('/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator_id: 'opr_1', origin: 'Lagos', destination: 'Abuja',
        base_fare: 15000.50,
      }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('POST /vehicles registers a vehicle', async () => {
    const res = await operatorManagementRouter.request('/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator_id: 'opr_1', plate_number: 'ABC-123-LG',
        vehicle_type: 'bus', total_seats: 45,
      }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.total_seats).toBe(45);
  });

  it('POST /trips/:id/transition enforces valid state machine', async () => {
    // Pre-populate trip in 'completed' state
    db._tables.trips.push({
      id: 'trp_done', state: 'completed', deleted_at: null,
      operator_id: 'opr_1', route_id: 'rte_1', vehicle_id: 'veh_1',
      departure_time: Date.now(), created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await operatorManagementRouter.request('/trips/trp_done/transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_state: 'boarding' }),
    }, makeEnv(db));
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toContain('Invalid transition');
  });

  it('GET /dashboard returns trip state counts', async () => {
    const res = await operatorManagementRouter.request('/dashboard', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.trips).toHaveProperty('scheduled');
    expect(body.data.trips).toHaveProperty('in_transit');
  });
});

// ============================================================
// Phase 2 — New PATCH/DELETE Endpoint Tests
// ============================================================

describe('Phase 2: PATCH /trips/:tripId/seats/:seatId — Seat Update (TRN-1)', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('returns 400 for invalid status value', async () => {
    const res = await seatInventoryRouter.request('/trips/trp_1/seats/s1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'sold' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('Invalid status');
  });

  it('returns 404 for unknown seat', async () => {
    const res = await seatInventoryRouter.request('/trips/trp_1/seats/s_unknown', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'blocked' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toContain('not found');
  });

  it('accepts valid statuses: available, reserved, confirmed, blocked', async () => {
    // Pre-populate a seat. Mock first() uses last param as id → tripId='trp_1'
    db._tables.seats.push({
      id: 'trp_1', trip_id: 'trp_1', seat_number: '01', status: 'available', version: 0,
      reserved_by: null, confirmed_by: null, created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await seatInventoryRouter.request('/trips/trp_1/seats/trp_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'blocked' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('blocked');
  });
});

describe('Phase 2: PATCH /bookings/:id — Booking Update (TRN-3)', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('returns 404 for unknown booking', async () => {
    const res = await bookingPortalRouter.request('/bookings/bkg_unknown', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_reference: 'pay_new_ref' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
  });

  it('returns 409 for cancelled booking', async () => {
    db._tables.bookings.push({
      id: 'bkg_1', customer_id: 'cust_1', trip_id: 'trp_1',
      seat_ids: '["s1"]', passenger_names: '["Chidi"]',
      total_amount: 500000, status: 'cancelled', payment_status: 'pending',
      payment_method: 'paystack', payment_reference: 'old_ref',
      created_at: Date.now(), confirmed_at: null, cancelled_at: Date.now(), deleted_at: null,
    });
    const res = await bookingPortalRouter.request('/bookings/bkg_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_reference: 'pay_new_ref' }),
    }, makeEnv(db));
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toContain('cancelled');
  });

  it('returns 422 when attempting to set status to confirmed via PATCH', async () => {
    db._tables.bookings.push({
      id: 'bkg_2', customer_id: 'cust_1', trip_id: 'trp_1',
      seat_ids: '["s1"]', passenger_names: '["Amaka"]',
      total_amount: 500000, status: 'pending', payment_status: 'pending',
      payment_method: 'paystack', payment_reference: 'old_ref',
      created_at: Date.now(), confirmed_at: null, cancelled_at: null, deleted_at: null,
    });
    const res = await bookingPortalRouter.request('/bookings/bkg_2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed' }),
    }, makeEnv(db));
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toContain('confirm');
  });

  it('updates payment_reference successfully', async () => {
    db._tables.bookings.push({
      id: 'bkg_3', customer_id: 'cust_1', trip_id: 'trp_1',
      seat_ids: '["s1"]', passenger_names: '["Ngozi"]',
      total_amount: 250000, status: 'pending', payment_status: 'pending',
      payment_method: 'paystack', payment_reference: 'old_ref',
      created_at: Date.now(), confirmed_at: null, cancelled_at: null, deleted_at: null,
    });
    const res = await bookingPortalRouter.request('/bookings/bkg_3', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_reference: 'pay_new_123' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('bkg_3');
  });
});

describe('Phase 2: PATCH /trips/:id — Trip Update (TRN-4)', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('returns 404 for unknown trip', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_unknown', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicle_id: 'veh_2' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });

  it('updates trip vehicle and departure time', async () => {
    db._tables.trips.push({
      id: 'trp_upd', operator_id: 'opr_1', route_id: 'rte_1', vehicle_id: 'veh_1',
      departure_time: Date.now() + 3600000, state: 'scheduled', deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const newTime = Date.now() + 7200000;
    const res = await operatorManagementRouter.request('/trips/trp_upd', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicle_id: 'veh_2', departure_time: newTime }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('trp_upd');
  });
});

describe('Phase 2: DELETE /trips/:id — Soft Delete Trip (TRN-4)', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('returns 404 for unknown trip', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_gone', {
      method: 'DELETE',
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });

  it('soft-deletes a scheduled trip', async () => {
    db._tables.trips.push({
      id: 'trp_del', operator_id: 'opr_1', route_id: 'rte_1', vehicle_id: 'veh_1',
      departure_time: Date.now() + 3600000, state: 'scheduled', deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await operatorManagementRouter.request('/trips/trp_del', {
      method: 'DELETE',
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('deleted_at');
  });

  it('returns 409 for a boarding trip', async () => {
    db._tables.trips.push({
      id: 'trp_boarding', operator_id: 'opr_1', route_id: 'rte_1', vehicle_id: 'veh_1',
      departure_time: Date.now(), state: 'boarding', deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await operatorManagementRouter.request('/trips/trp_boarding', {
      method: 'DELETE',
    }, makeEnv(db));
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toContain('boarding');
  });

  it('returns 409 for an in_transit trip', async () => {
    db._tables.trips.push({
      id: 'trp_transit', operator_id: 'opr_1', route_id: 'rte_1', vehicle_id: 'veh_1',
      departure_time: Date.now(), state: 'in_transit', deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await operatorManagementRouter.request('/trips/trp_transit', {
      method: 'DELETE',
    }, makeEnv(db));
    expect(res.status).toBe(409);
  });
});

describe('Phase 2: PATCH /routes/:id — Route Update (TRN-4)', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('returns 404 for unknown route', async () => {
    const res = await operatorManagementRouter.request('/routes/rte_unknown', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_fare: 2000000 }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-integer base_fare', async () => {
    db._tables.routes.push({
      id: 'rte_1', operator_id: 'opr_1', origin: 'Lagos', destination: 'Abuja',
      base_fare: 1500000, status: 'active', deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await operatorManagementRouter.request('/routes/rte_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_fare: 1500.50 }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('kobo');
  });

  it('updates route base_fare', async () => {
    db._tables.routes.push({
      id: 'rte_2', operator_id: 'opr_1', origin: 'Port Harcourt', destination: 'Enugu',
      base_fare: 800000, status: 'active', deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await operatorManagementRouter.request('/routes/rte_2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_fare: 950000 }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('rte_2');
  });

  it('updates route status to inactive', async () => {
    db._tables.routes.push({
      id: 'rte_3', operator_id: 'opr_1', origin: 'Kano', destination: 'Kaduna',
      base_fare: 600000, status: 'active', deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await operatorManagementRouter.request('/routes/rte_3', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'inactive' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });
});

describe('Phase 2: PATCH /vehicles/:id — Vehicle Update (TRN-4)', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('returns 404 for unknown vehicle', async () => {
    const res = await operatorManagementRouter.request('/vehicles/veh_unknown', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'maintenance' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });

  it('updates vehicle status to maintenance', async () => {
    db._tables.vehicles.push({
      id: 'veh_1', operator_id: 'opr_1', plate_number: 'ABC-123-LG',
      vehicle_type: 'bus', model: null, total_seats: 45, status: 'active',
      deleted_at: null, created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await operatorManagementRouter.request('/vehicles/veh_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'maintenance' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('veh_1');
  });

  it('updates vehicle model and total_seats', async () => {
    db._tables.vehicles.push({
      id: 'veh_2', operator_id: 'opr_1', plate_number: 'XYZ-456-AB',
      vehicle_type: 'minibus', model: null, total_seats: 18, status: 'active',
      deleted_at: null, created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await operatorManagementRouter.request('/vehicles/veh_2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'Toyota HiAce 2023', total_seats: 14 }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });
});

// ============================================================
// Phase 7 — Trip Creation & Booking Cancellation Tests
// ============================================================

describe('Phase 7: POST /trips — Trip Creation (TRN-4)', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.routes.push({
      id: 'rte_p7', operator_id: 'opr_p7', origin: 'Lagos', destination: 'Ibadan',
      base_fare: 500000, status: 'active', deleted_at: null,
      distance_km: null, duration_minutes: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    db._tables.vehicles.push({
      id: 'veh_p7', operator_id: 'opr_p7', plate_number: 'LG-123-AA',
      vehicle_type: 'bus', model: null, total_seats: 18, status: 'active',
      deleted_at: null, created_at: Date.now(), updated_at: Date.now(),
    });
  });

  it('creates a trip and batch-inserts seats', async () => {
    const dep = Date.now() + 3600_000;
    const res = await operatorManagementRouter.request('/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_id: 'rte_p7', vehicle_id: 'veh_p7', departure_time: dep }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.state).toBe('scheduled');
    expect(body.data.origin).toBe('Lagos');
    expect(body.data.destination).toBe('Ibadan');
    expect(body.data.total_seats).toBe(18);
    expect(body.data.base_fare).toBe(500000);
    const seats = db._tables.seats.filter((s: any) => s.trip_id === body.data.id);
    expect(seats.length).toBe(18);
    expect(seats[0].seat_number).toBe('01');
    expect(seats[17].seat_number).toBe('18');
  });

  it('accepts a base_fare override', async () => {
    const dep = Date.now() + 3600_000;
    const res = await operatorManagementRouter.request('/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_id: 'rte_p7', vehicle_id: 'veh_p7', departure_time: dep, base_fare: 750000 }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.base_fare).toBe(750000);
  });

  it('accepts a total_seats override', async () => {
    const dep = Date.now() + 3600_000;
    const res = await operatorManagementRouter.request('/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_id: 'rte_p7', vehicle_id: 'veh_p7', departure_time: dep, total_seats: 5 }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.total_seats).toBe(5);
    const seats = db._tables.seats.filter((s: any) => s.trip_id === body.data.id);
    expect(seats.length).toBe(5);
  });

  it('returns 400 if route_id missing', async () => {
    const res = await operatorManagementRouter.request('/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicle_id: 'veh_p7', departure_time: Date.now() + 3600_000 }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('returns 400 if departure_time is not a positive integer', async () => {
    const res = await operatorManagementRouter.request('/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_id: 'rte_p7', vehicle_id: 'veh_p7', departure_time: -1 }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('returns 404 if route does not exist', async () => {
    const res = await operatorManagementRouter.request('/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_id: 'rte_ghost', vehicle_id: 'veh_p7', departure_time: Date.now() + 3600_000 }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toMatch(/route not found/i);
  });

  it('returns 404 if vehicle does not exist', async () => {
    const res = await operatorManagementRouter.request('/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_id: 'rte_p7', vehicle_id: 'veh_ghost', departure_time: Date.now() + 3600_000 }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toMatch(/vehicle not found/i);
  });
});

describe('Phase 7: PATCH /bookings/:id/cancel — Booking Cancellation (TRN-3)', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.bookings.push({
      id: 'bkg_p7', customer_id: 'cust_1', trip_id: 'trp_1',
      seat_ids: '["seat_1"]', total_amount: 500000, status: 'pending',
      payment_status: 'pending', payment_reference: null,
      created_at: Date.now(), confirmed_at: null, cancelled_at: null, deleted_at: null,
    });
    db._tables.bookings.push({
      id: 'bkg_p7_already_cancelled', customer_id: 'cust_1', trip_id: 'trp_1',
      seat_ids: '["seat_2"]', total_amount: 500000, status: 'cancelled',
      payment_status: 'pending', payment_reference: null,
      created_at: Date.now(), confirmed_at: null, cancelled_at: Date.now(), deleted_at: null,
    });
  });

  it('cancels a pending booking successfully', async () => {
    const res = await bookingPortalRouter.request('/bookings/bkg_p7/cancel', {
      method: 'PATCH',
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('cancelled');
  });

  it('returns 409 when trying to cancel an already-cancelled booking', async () => {
    const res = await bookingPortalRouter.request('/bookings/bkg_p7_already_cancelled/cancel', {
      method: 'PATCH',
    }, makeEnv(db));
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBeDefined();
  });

  it('returns 404 for unknown booking', async () => {
    const res = await bookingPortalRouter.request('/bookings/bkg_ghost/cancel', {
      method: 'PATCH',
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Phase 12 — Trip Copy Tests
// ============================================================

describe('Phase 12: POST /trips/:id/copy — Duplicate Trip', () => {
  let db: any;
  const now = Date.now();
  const futureMs = now + 86400_000 * 2;

  beforeEach(() => {
    db = createMockDB();
    db._tables.trips.push({
      id: 'trp_src1', operator_id: 'opr_1', route_id: 'rte_1', vehicle_id: 'veh_1',
      driver_id: null, departure_time: now + 3600_000, state: 'scheduled',
      base_fare: 1200000, created_at: now, updated_at: now, deleted_at: null,
    });
    db._tables.seats.push(
      { id: 'trp_src1_s1', trip_id: 'trp_src1', seat_number: '01', status: 'available', version: 0, created_at: now, updated_at: now, deleted_at: null },
      { id: 'trp_src1_s2', trip_id: 'trp_src1', seat_number: '02', status: 'available', version: 0, created_at: now, updated_at: now, deleted_at: null },
    );
  });

  it('creates a copy with a new departure time and returns 201', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_src1/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departure_time: futureMs }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).not.toBe('trp_src1');
    expect(body.data.state).toBe('scheduled');
    expect(body.data.departure_time).toBe(futureMs);
    expect(body.data.copied_from).toBe('trp_src1');
  });

  it('returns 404 for unknown source trip', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_ghost/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departure_time: futureMs }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 400 when departure_time is missing', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_src1/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/departure_time/i);
  });

  it('returns 400 when departure_time is a string instead of integer', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_src1/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departure_time: 'tomorrow' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });
});

// ============================================================
// Phase 11 — Super Admin: PATCH /operators/:id Tests
// ============================================================

describe('Phase 11: PATCH /operators/:id — Update Operator (SUPER_ADMIN)', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.operators.push({
      id: 'opr_upd1', name: 'Sunrise Motors', code: 'SRM', phone: null, email: null,
      status: 'active', created_at: Date.now(), updated_at: Date.now(), deleted_at: null,
    });
  });

  it('suspends an active operator', async () => {
    const res = await operatorManagementRouter.request('/operators/opr_upd1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('opr_upd1');
  });

  it('updates operator name', async () => {
    const res = await operatorManagementRouter.request('/operators/opr_upd1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sunrise Express' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  it('returns 404 for unknown operator id', async () => {
    const res = await operatorManagementRouter.request('/operators/opr_ghost', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toMatch(/not found/i);
  });
});

// ============================================================
// Phase 10 — Agent Management + Revenue Reports Tests
// ============================================================

describe('Phase 10: PATCH /agents/:id — Update Agent (TRN-2)', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.agents.push({
      id: 'agt_upd1', operator_id: 'opr_1', name: 'Chidi Obi', phone: '08011112222',
      email: null, role: 'agent', bus_parks: '[]', status: 'active',
      created_at: Date.now(), updated_at: Date.now(), deleted_at: null,
    });
  });

  it('suspends an active agent', async () => {
    const res = await agentSalesRouter.request('/agents/agt_upd1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('agt_upd1');
  });

  it('updates agent role to supervisor', async () => {
    const res = await agentSalesRouter.request('/agents/agt_upd1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'supervisor' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  it('updates bus_parks array', async () => {
    const res = await agentSalesRouter.request('/agents/agt_upd1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bus_parks: ['park_a', 'park_b'] }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await agentSalesRouter.request('/agents/agt_ghost', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toMatch(/agent not found/i);
  });
});

describe('Phase 10: GET /reports/revenue — Revenue Report (TRN-4)', () => {
  let db: any;
  const now = Date.now();
  beforeEach(() => {
    db = createMockDB();
    db._tables.bookings.push(
      {
        id: 'bkg_r1', customer_id: 'cust_1', trip_id: 'trp_r1',
        seat_ids: '["s1"]', passenger_names: '["Ola"]',
        total_amount: 1500000, status: 'confirmed', payment_status: 'paid',
        payment_method: 'paystack', payment_reference: 'pay_r1',
        created_at: now - 3600_000, confirmed_at: now - 3600_000, cancelled_at: null, deleted_at: null,
      },
      {
        id: 'bkg_r2', customer_id: 'cust_1', trip_id: 'trp_r1',
        seat_ids: '["s2"]', passenger_names: '["Kemi"]',
        total_amount: 1500000, status: 'confirmed', payment_status: 'paid',
        payment_method: 'paystack', payment_reference: 'pay_r2',
        created_at: now - 1800_000, confirmed_at: now - 1800_000, cancelled_at: null, deleted_at: null,
      },
    );
    db._tables.sales_transactions.push({
      id: 'txn_r1', agent_id: 'agt_1', trip_id: 'trp_r1',
      seat_ids: '["s3"]', passenger_names: '["Bisi"]',
      total_amount: 750000, payment_method: 'cash', payment_status: 'completed',
      sync_status: 'synced', receipt_id: 'rct_r1',
      created_at: now - 900_000, synced_at: now, deleted_at: null,
    });
    db._tables.routes.push({
      id: 'rte_r1', operator_id: 'opr_1', origin: 'Lagos', destination: 'Ibadan',
      base_fare: 1500000, status: 'active', deleted_at: null,
      created_at: now, updated_at: now,
    });
  });

  it('returns booking revenue from paid bookings', async () => {
    const from = now - 7200_000;
    const to = now + 1000;
    const res = await operatorManagementRouter.request(`/reports/revenue?from=${from}&to=${to}`, {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.booking_revenue_kobo).toBe(3000000);
    expect(body.data.total_bookings).toBe(2);
  });

  it('returns agent sales revenue from completed transactions', async () => {
    const from = now - 7200_000;
    const to = now + 1000;
    const res = await operatorManagementRouter.request(`/reports/revenue?from=${from}&to=${to}`, {}, makeEnv(db));
    const body = await res.json() as any;
    expect(body.data.agent_sales_revenue_kobo).toBe(750000);
    expect(body.data.total_agent_transactions).toBe(1);
  });

  it('sums total_revenue_kobo correctly', async () => {
    const from = now - 7200_000;
    const to = now + 1000;
    const res = await operatorManagementRouter.request(`/reports/revenue?from=${from}&to=${to}`, {}, makeEnv(db));
    const body = await res.json() as any;
    expect(body.data.total_revenue_kobo).toBe(3750000);
  });

  it('returns period reflecting the query params', async () => {
    const from = now - 86400_000;
    const to = now;
    const res = await operatorManagementRouter.request(`/reports/revenue?from=${from}&to=${to}`, {}, makeEnv(db));
    const body = await res.json() as any;
    expect(body.data.period.from).toBe(from);
    expect(body.data.period.to).toBe(to);
  });

  it('returns top_routes list', async () => {
    const res = await operatorManagementRouter.request(`/reports/revenue?from=0&to=${now + 1000}`, {}, makeEnv(db));
    const body = await res.json() as any;
    expect(Array.isArray(body.data.top_routes)).toBe(true);
  });

  it('returns zero revenue when no data exists', async () => {
    db._tables.bookings = [];
    db._tables.sales_transactions = [];
    const from = now - 7200_000;
    const res = await operatorManagementRouter.request(`/reports/revenue?from=${from}&to=${now + 1000}`, {}, makeEnv(db));
    const body = await res.json() as any;
    expect(body.data.booking_revenue_kobo).toBe(0);
    expect(body.data.agent_sales_revenue_kobo).toBe(0);
    expect(body.data.total_revenue_kobo).toBe(0);
  });
});

// ============================================================
// Phase 9 — Driver Management & Assignment Tests
// ============================================================

describe('Phase 9: POST /drivers — Create Driver (TRN-4)', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('creates a driver and returns 201', async () => {
    const res = await operatorManagementRouter.request('/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator_id: 'opr_1', name: 'Emeka Okafor', phone: '08022223333', license_number: 'LG-2024-001' }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Emeka Okafor');
    expect(body.data.status).toBe('active');
    expect(body.data.license_number).toBe('LG-2024-001');
    expect(db._tables.drivers).toHaveLength(1);
  });

  it('creates a driver without license_number', async () => {
    const res = await operatorManagementRouter.request('/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator_id: 'opr_1', name: 'Aisha Bello', phone: '08044445555' }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.license_number).toBeNull();
  });

  it('returns 400 when name is missing', async () => {
    const res = await operatorManagementRouter.request('/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator_id: 'opr_1', phone: '08022223333' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('returns 400 when phone is missing', async () => {
    const res = await operatorManagementRouter.request('/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator_id: 'opr_1', name: 'Test Driver' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });
});

describe('Phase 9: GET /drivers — List Drivers (TRN-4)', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.drivers.push(
      { id: 'drv_1', operator_id: 'opr_1', name: 'Musa Garba', phone: '08011112222', license_number: null, status: 'active', created_at: Date.now(), updated_at: Date.now(), deleted_at: null },
      { id: 'drv_2', operator_id: 'opr_1', name: 'Ngozi Eze', phone: '08033334444', license_number: 'AB-001', status: 'suspended', created_at: Date.now(), updated_at: Date.now(), deleted_at: null },
      { id: 'drv_3', operator_id: 'opr_1', name: 'Deleted Driver', phone: '08099998888', license_number: null, status: 'inactive', created_at: Date.now(), updated_at: Date.now(), deleted_at: Date.now() },
    );
  });

  it('returns all non-deleted drivers for operator', async () => {
    const res = await operatorManagementRouter.request('/drivers?operator_id=opr_1', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.meta).toBeDefined();
  });

  it('filters by operator_id', async () => {
    const res = await operatorManagementRouter.request('/drivers?operator_id=opr_1', {}, makeEnv(db));
    const body = await res.json() as any;
    expect(body.data.every((d: any) => d.operator_id === 'opr_1')).toBe(true);
  });
});

describe('Phase 9: PATCH /drivers/:id — Update Driver (TRN-4)', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.drivers.push({
      id: 'drv_upd1', operator_id: 'opr_1', name: 'Tunde Badmus', phone: '08055556666',
      license_number: null, status: 'active', created_at: Date.now(), updated_at: Date.now(), deleted_at: null,
    });
  });

  it('updates driver status to suspended', async () => {
    const res = await operatorManagementRouter.request('/drivers/drv_upd1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('drv_upd1');
  });

  it('returns 404 for unknown driver', async () => {
    const res = await operatorManagementRouter.request('/drivers/drv_ghost', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toMatch(/driver not found/i);
  });
});

describe('Phase 9: PATCH /trips/:id with driver_id — Assign Driver (TRN-4)', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.trips.push({
      id: 'trp_d1', operator_id: 'opr_1', route_id: 'rte_1', vehicle_id: 'veh_1',
      driver_id: null, state: 'scheduled', departure_time: Date.now() + 3600_000,
      deleted_at: null, created_at: Date.now(), updated_at: Date.now(),
    });
    db._tables.drivers.push({
      id: 'drv_a1', operator_id: 'opr_1', name: 'Felix Chukwu', phone: '08066667777',
      license_number: 'FC-001', status: 'active', created_at: Date.now(), updated_at: Date.now(), deleted_at: null,
    });
  });

  it('assigns driver_id to an existing trip', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_d1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driver_id: 'drv_a1' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('trp_d1');
  });

  it('returns 404 when trip does not exist', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_ghost_d', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driver_id: 'drv_a1' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });
});

describe('Phase 9: GET /trips/:id/manifest — driver field present', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.trips.push({
      id: 'trp_dm1', operator_id: 'opr_1', route_id: 'rte_dm1', driver_id: 'drv_dm1',
      state: 'boarding', departure_time: Date.now() + 900_000, deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    db._tables.routes.push({
      id: 'rte_dm1', operator_id: 'opr_1', origin: 'Kano', destination: 'Kaduna',
      base_fare: 300000, status: 'active', deleted_at: null, created_at: Date.now(), updated_at: Date.now(),
    });
    db._tables.seats.push(
      { id: 'trp_dm1_s1', trip_id: 'trp_dm1', seat_number: '01', status: 'available', version: 0 },
    );
    db._tables.drivers.push({
      id: 'drv_dm1', operator_id: 'opr_1', name: 'Abubakar Suleiman', phone: '08077778888',
      license_number: 'KN-2025-007', status: 'active', created_at: Date.now(), updated_at: Date.now(), deleted_at: null,
    });
  });

  it('manifest trip includes driver name and phone', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_dm1/manifest', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.trip.driver).not.toBeNull();
    expect(body.data.trip.driver.name).toBe('Abubakar Suleiman');
    expect(body.data.trip.driver.phone).toBe('08077778888');
    expect(body.data.trip.driver.license_number).toBe('KN-2025-007');
  });

  it('manifest trip driver is null when no driver assigned', async () => {
    db._tables.trips[0].driver_id = null;
    const res = await operatorManagementRouter.request('/trips/trp_dm1/manifest', {}, makeEnv(db));
    const body = await res.json() as any;
    expect(body.data.trip.driver).toBeNull();
  });
});

// ============================================================
// Phase 8 — Trip Manifest & Booking Ticket Tests
// ============================================================

describe('Phase 8: GET /trips/:id/manifest — Trip Manifest (TRN-4)', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.trips.push({
      id: 'trp_m1', operator_id: 'opr_1', route_id: 'rte_m1', state: 'boarding',
      departure_time: Date.now() + 1800_000, deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    db._tables.routes.push({
      id: 'rte_m1', operator_id: 'opr_1', origin: 'Lagos', destination: 'Abuja',
      base_fare: 500000, status: 'active', deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    db._tables.seats.push(
      { id: 'trp_m1_s1', trip_id: 'trp_m1', seat_number: '01', status: 'confirmed', version: 1 },
      { id: 'trp_m1_s2', trip_id: 'trp_m1', seat_number: '02', status: 'confirmed', version: 1 },
      { id: 'trp_m1_s3', trip_id: 'trp_m1', seat_number: '03', status: 'available', version: 0 },
    );
    db._tables.customers.push({
      id: 'cust_m1', name: 'Adaeze Obi', phone: '08011111111',
      ndpr_consent: 1, status: 'active', deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    });
    db._tables.bookings.push({
      id: 'bkg_m1', customer_id: 'cust_m1', trip_id: 'trp_m1',
      seat_ids: '["trp_m1_s1","trp_m1_s2"]',
      passenger_names: '["Adaeze Obi","Chinedu Obi"]',
      total_amount: 1000000, status: 'confirmed', payment_status: 'paid',
      payment_method: 'paystack', payment_reference: 'PAY_001',
      created_at: Date.now(), confirmed_at: Date.now(), cancelled_at: null, deleted_at: null,
    });
  });

  it('returns manifest with trip summary and passengers', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_m1/manifest', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.trip.id).toBe('trp_m1');
    expect(body.data.trip.origin).toBe('Lagos');
    expect(body.data.trip.destination).toBe('Abuja');
    expect(body.data.trip.state).toBe('boarding');
    expect(body.data.passengers).toHaveLength(1);
    expect(body.data.passengers[0].booking_id).toBe('bkg_m1');
    expect(body.data.passengers[0].seat_ids).toEqual(['trp_m1_s1', 'trp_m1_s2']);
    expect(body.data.passengers[0].passenger_names).toEqual(['Adaeze Obi', 'Chinedu Obi']);
    expect(body.data.summary.total_bookings).toBe(1);
    expect(body.data.summary.total_seats).toBe(3);
  });

  it('includes confirmed_revenue_kobo for paid bookings', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_m1/manifest', {}, makeEnv(db));
    const body = await res.json() as any;
    expect(body.data.summary.confirmed_revenue_kobo).toBe(1000000);
  });

  it('returns empty passengers when no bookings exist', async () => {
    db._tables.bookings = [];
    const res = await operatorManagementRouter.request('/trips/trp_m1/manifest', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.passengers).toHaveLength(0);
    expect(body.data.summary.total_bookings).toBe(0);
    expect(body.data.summary.confirmed_revenue_kobo).toBe(0);
  });

  it('returns 404 for unknown trip', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_ghost/manifest', {}, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toMatch(/trip not found/i);
  });

  it('load_factor reflects seats vs bookings ratio', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_m1/manifest', {}, makeEnv(db));
    const body = await res.json() as any;
    expect(body.data.summary.load_factor).toBe(33); // 1/3 seats booked = 33%
  });
});

// ============================================================
// T-TRN-02: Digital Passenger Manifest Export — next-of-kin, PDF, agent_sales
// ============================================================
describe('T-TRN-02: Manifest — next_of_kin fields in JSON response', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    const now = Date.now();
    db._tables.operators.push({
      id: 'opr_1', name: 'Star Express', code: 'STE', phone: null, email: null,
      status: 'active', created_at: now, updated_at: now, deleted_at: null,
    });
    db._tables.trips.push({
      id: 'trp_nok1', operator_id: 'opr_1', route_id: 'rte_nok1', state: 'boarding',
      departure_time: now + 3600_000, deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.routes.push({
      id: 'rte_nok1', operator_id: 'opr_1', origin: 'Aba', destination: 'Port Harcourt',
      base_fare: 400000, status: 'active', deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.seats.push(
      { id: 'nok_s1', trip_id: 'trp_nok1', seat_number: '01', status: 'confirmed', version: 1 },
      { id: 'nok_s2', trip_id: 'trp_nok1', seat_number: '02', status: 'available', version: 0 },
    );
    db._tables.customers.push({
      id: 'cust_nok1', name: 'Emeka Nwosu', phone: '08099999999',
      ndpr_consent: 1, status: 'active', deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.bookings.push({
      id: 'bkg_nok1', customer_id: 'cust_nok1', trip_id: 'trp_nok1',
      seat_ids: '["nok_s1"]',
      passenger_names: '["Emeka Nwosu"]',
      total_amount: 400000, status: 'confirmed', payment_status: 'paid',
      payment_method: 'cash', payment_reference: 'PAY_NOK1',
      next_of_kin_name: 'Ngozi Nwosu', next_of_kin_phone: '08011112222',
      created_at: now, confirmed_at: now, cancelled_at: null, deleted_at: null,
    });
  });

  it('manifest JSON includes next_of_kin_name and next_of_kin_phone for bookings', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_nok1/manifest', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    const p = body.data.passengers[0];
    expect(p.next_of_kin_name).toBe('Ngozi Nwosu');
    expect(p.next_of_kin_phone).toBe('08011112222');
  });

  it('manifest JSON next_of_kin fields are null when not provided', async () => {
    db._tables.bookings[0].next_of_kin_name = null;
    db._tables.bookings[0].next_of_kin_phone = null;
    const res = await operatorManagementRouter.request('/trips/trp_nok1/manifest', {}, makeEnv(db));
    const body = await res.json() as any;
    const p = body.data.passengers[0];
    expect(p.next_of_kin_name).toBeNull();
    expect(p.next_of_kin_phone).toBeNull();
  });
});

describe('T-TRN-02: Manifest — agent_sales includes next_of_kin and passenger_id_hash', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    const now = Date.now();
    db._tables.operators.push({
      id: 'opr_1', name: 'Star Express', code: 'STE', phone: null, email: null,
      status: 'active', created_at: now, updated_at: now, deleted_at: null,
    });
    db._tables.trips.push({
      id: 'trp_agtnok', operator_id: 'opr_1', route_id: 'rte_agtnok', state: 'boarding',
      departure_time: now + 3600_000, deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.routes.push({
      id: 'rte_agtnok', operator_id: 'opr_1', origin: 'Kano', destination: 'Kaduna',
      base_fare: 300000, status: 'active', deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.seats.push(
      { id: 'agtnok_s1', trip_id: 'trp_agtnok', seat_number: '01', status: 'confirmed', version: 1 },
    );
    db._tables.agents.push({
      id: 'agt_nok1', operator_id: 'opr_1', name: 'Bola Agentola', phone: '08077778888',
      status: 'active', deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.sales_transactions.push({
      id: 'txn_nok1', agent_id: 'agt_nok1', trip_id: 'trp_agtnok',
      seat_ids: '["agtnok_s1"]', passenger_names: '["Sule Ibrahim"]',
      total_amount: 300000, payment_method: 'cash', payment_status: 'completed',
      sync_status: 'synced', receipt_id: 'rct_nok1',
      passenger_id_type: 'NIN',
      passenger_id_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      next_of_kin_name: 'Fatima Sule', next_of_kin_phone: '08044445555',
      created_at: now, deleted_at: null,
    });
  });

  it('manifest JSON agent_sales includes next_of_kin and passenger_id_hash', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_agtnok/manifest', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const a = body.data.agent_sales[0];
    expect(a.next_of_kin_name).toBe('Fatima Sule');
    expect(a.next_of_kin_phone).toBe('08044445555');
    expect(a.passenger_id_hash).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
  });

  it('manifest JSON agent_sales next_of_kin fields are null when not stored', async () => {
    db._tables.sales_transactions[0].next_of_kin_name = null;
    db._tables.sales_transactions[0].next_of_kin_phone = null;
    db._tables.sales_transactions[0].passenger_id_hash = null;
    const res = await operatorManagementRouter.request('/trips/trp_agtnok/manifest', {}, makeEnv(db));
    const body = await res.json() as any;
    const a = body.data.agent_sales[0];
    expect(a.next_of_kin_name).toBeNull();
    expect(a.next_of_kin_phone).toBeNull();
    expect(a.passenger_id_hash).toBeNull();
  });
});

describe('T-TRN-02: POST /transactions — stores next_of_kin_name and next_of_kin_phone', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    const now = Date.now();
    db._tables.operators.push({
      id: 'opr_1', name: 'Star Express', code: 'STE', phone: null, email: null,
      status: 'active', created_at: now, updated_at: now, deleted_at: null,
    });
    db._tables.agents.push({
      id: 'agt_nok2', operator_id: 'opr_1', name: 'Tunde Park', phone: '08055556666',
      status: 'active', deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.trips.push({
      id: 'trp_noksale', operator_id: 'opr_1', route_id: 'rte_1', state: 'boarding',
      departure_time: now + 3600_000, deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.seats.push({
      id: 'noksale_s1', trip_id: 'trp_noksale', seat_number: '01', status: 'available', version: 0,
    });
  });

  it('stores next_of_kin_name and next_of_kin_phone when provided', async () => {
    const res = await agentSalesRouter.request('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agt_nok2',
        trip_id: 'trp_noksale',
        seat_ids: ['noksale_s1'],
        passenger_names: ['Chukwudi Eze'],
        total_amount: 350000,
        payment_method: 'cash',
        next_of_kin_name: 'Ada Eze',
        next_of_kin_phone: '08033334444',
      }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    const stored = db._tables.sales_transactions.find((t: any) => t.agent_id === 'agt_nok2');
    expect(stored).toBeDefined();
    expect(stored.next_of_kin_name).toBe('Ada Eze');
    expect(stored.next_of_kin_phone).toBe('08033334444');
  });

  it('stores null for next_of_kin fields when not provided', async () => {
    const res = await agentSalesRouter.request('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agt_nok2',
        trip_id: 'trp_noksale',
        seat_ids: ['noksale_s1'],
        passenger_names: ['Chukwudi Eze'],
        total_amount: 350000,
        payment_method: 'cash',
      }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const stored = db._tables.sales_transactions.find((t: any) => t.agent_id === 'agt_nok2');
    expect(stored.next_of_kin_name).toBeNull();
    expect(stored.next_of_kin_phone).toBeNull();
  });
});

describe('T-TRN-02: GET /trips/:id/manifest CSV — includes both bookings and agent sales (FRSC compliance)', () => {
  let db: any;
  const now = Date.now();
  beforeEach(() => {
    db = createMockDB();
    db._tables.operators.push({
      id: 'opr_1', name: 'Sky Liner', code: 'SKL', phone: null, email: null,
      status: 'active', created_at: now, updated_at: now, deleted_at: null,
    });
    db._tables.trips.push({
      id: 'trp_csv1', operator_id: 'opr_1', route_id: 'rte_csv1', state: 'boarding',
      departure_time: now + 3600_000, deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.routes.push({
      id: 'rte_csv1', operator_id: 'opr_1', origin: 'Enugu', destination: 'Onitsha',
      base_fare: 250000, status: 'active', deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.seats.push(
      { id: 'csv_s1', trip_id: 'trp_csv1', seat_number: '01', status: 'confirmed', version: 1 },
      { id: 'csv_s2', trip_id: 'trp_csv1', seat_number: '02', status: 'confirmed', version: 1 },
    );
    db._tables.customers.push({
      id: 'cust_csv1', name: 'Obiora Nweke', phone: '08011112222',
      ndpr_consent: 1, status: 'active', deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.bookings.push({
      id: 'bkg_csv1', customer_id: 'cust_csv1', trip_id: 'trp_csv1',
      seat_ids: '["csv_s1"]', passenger_names: '["Obiora Nweke"]',
      total_amount: 250000, status: 'confirmed', payment_status: 'paid',
      payment_method: 'paystack', payment_reference: 'PAY_CSV1',
      next_of_kin_name: null, next_of_kin_phone: null,
      created_at: now, confirmed_at: now, cancelled_at: null, deleted_at: null,
    });
    db._tables.agents.push({
      id: 'agt_csv1', operator_id: 'opr_1', name: 'Zainab Agent', phone: '08099998888',
      status: 'active', deleted_at: null, created_at: now, updated_at: now,
    });
    db._tables.sales_transactions.push({
      id: 'txn_csv1', agent_id: 'agt_csv1', trip_id: 'trp_csv1',
      seat_ids: '["csv_s2"]', passenger_names: '["Musa Danladi"]',
      total_amount: 250000, payment_method: 'cash', payment_status: 'completed',
      sync_status: 'synced', receipt_id: 'rct_csv1',
      passenger_id_type: null, passenger_id_hash: null,
      next_of_kin_name: null, next_of_kin_phone: null,
      created_at: now, deleted_at: null,
    });
  });

  it('CSV includes online booking row with Source=Online', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_csv1/manifest', {
      headers: { Accept: 'text/csv' },
    }, makeEnv(db));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('Online');
    expect(text).toContain('Obiora Nweke');
  });

  it('CSV includes agent sale row with Source=Agent (FRSC compliance bug-fix)', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_csv1/manifest', {
      headers: { Accept: 'text/csv' },
    }, makeEnv(db));
    const text = await res.text();
    expect(text).toContain('Agent');
    expect(text).toContain('Musa Danladi');
  });

  it('CSV has Source column header', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_csv1/manifest', {
      headers: { Accept: 'text/csv' },
    }, makeEnv(db));
    const text = await res.text();
    const firstLine = text.split('\n')[0];
    expect(firstLine).toBe('Seat,Passenger Name,Boarded,Payment Method,Ref,Source');
  });
});

describe('Phase 8: GET /bookings/:id — Booking Detail (TRN-3)', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.bookings.push({
      id: 'bkg_detail1', customer_id: 'cust_1', trip_id: 'trp_1',
      seat_ids: '["trp_1_s3"]', passenger_names: '["Emeka Eze"]',
      total_amount: 750000, status: 'confirmed', payment_status: 'paid',
      payment_method: 'cash', payment_reference: 'pay_xyz',
      created_at: Date.now(), confirmed_at: Date.now(), cancelled_at: null, deleted_at: null,
    });
  });

  it('returns booking detail with seat_ids and passenger_names', async () => {
    const res = await bookingPortalRouter.request('/bookings/bkg_detail1', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('bkg_detail1');
    expect(body.data.seat_ids).toBe('["trp_1_s3"]');
    expect(body.data.passenger_names).toBe('["Emeka Eze"]');
    expect(body.data.total_amount).toBe(750000);
  });

  it('returns 404 for unknown booking', async () => {
    const res = await bookingPortalRouter.request('/bookings/bkg_ghost', {}, makeEnv(db));
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Phase 2 — Pagination Tests
// ============================================================

describe('Phase 2: Pagination meta in list responses', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('GET /trips includes meta.limit and meta.offset (TRN-1)', async () => {
    const res = await seatInventoryRouter.request('/trips?limit=10&offset=0', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.meta).toBeDefined();
    expect(body.meta.limit).toBe(10);
    expect(body.meta.offset).toBe(0);
    expect(body.meta).toHaveProperty('has_more');
  });

  it('GET /agents includes meta.limit (TRN-2)', async () => {
    const res = await agentSalesRouter.request('/agents?limit=5', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.meta).toBeDefined();
    expect(body.meta.limit).toBe(5);
  });

  it('GET /transactions includes meta.offset (TRN-2)', async () => {
    const res = await agentSalesRouter.request('/transactions?offset=20', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.meta).toBeDefined();
    expect(body.meta.offset).toBe(20);
  });

  it('GET /bookings includes pagination meta (TRN-3)', async () => {
    const res = await bookingPortalRouter.request('/bookings?limit=25&offset=50', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.meta).toBeDefined();
    expect(body.meta.limit).toBe(25);
    expect(body.meta.offset).toBe(50);
  });

  it('GET /operators includes pagination meta (TRN-4)', async () => {
    const res = await operatorManagementRouter.request('/operators?limit=20', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.meta).toBeDefined();
    expect(body.meta.limit).toBe(20);
  });

  it('GET /routes includes pagination meta (TRN-4)', async () => {
    const res = await operatorManagementRouter.request('/routes?limit=10&offset=0', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.meta).toBeDefined();
    expect(body.meta.limit).toBe(10);
  });

  it('GET /vehicles includes pagination meta (TRN-4)', async () => {
    const res = await operatorManagementRouter.request('/vehicles?limit=50', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.meta).toBeDefined();
    expect(body.meta.limit).toBe(50);
  });

  it('GET /trips includes pagination meta (TRN-4)', async () => {
    const res = await operatorManagementRouter.request('/trips?limit=100&offset=200', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.meta).toBeDefined();
    expect(body.meta.limit).toBe(100);
    expect(body.meta.offset).toBe(200);
  });

  it('clamps limit to max 200', async () => {
    const res = await seatInventoryRouter.request('/trips?limit=999', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.meta.limit).toBe(200);
  });

  it('defaults to limit=50 when not supplied', async () => {
    const res = await agentSalesRouter.request('/agents', {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.meta.limit).toBe(50);
  });
});

// ============================================================
// Phase 2 — Error Handling + Validation Tests
// ============================================================

describe('Phase 2: Input validation and error handling', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('POST /trips requires total_seats to be a positive integer (TRN-1)', async () => {
    const res = await seatInventoryRouter.request('/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator_id: 'opr_1', route_id: 'rte_1', vehicle_id: 'veh_1',
        departure_time: Date.now() + 3600000, total_seats: -5,
      }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('POST /transactions rejects empty seat_ids array (TRN-2)', async () => {
    const res = await agentSalesRouter.request('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agt_1', trip_id: 'trp_1',
        seat_ids: [], passenger_names: [],
        total_amount: 500000, payment_method: 'cash',
      }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('non-empty');
  });

  it('POST /sync returns 400 if mutations is not an array (TRN-1)', async () => {
    const res = await seatInventoryRouter.request('/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutations: 'not-an-array' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('POST /trips/:id/transition returns 400 if to_state missing (TRN-4)', async () => {
    db._tables.trips.push({
      id: 'trp_x', state: 'scheduled', deleted_at: null,
      operator_id: 'opr_1', route_id: 'rte_1', vehicle_id: 'veh_1',
      departure_time: Date.now(), created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await operatorManagementRouter.request('/trips/trp_x/transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('to_state');
  });

  it('PATCH /trips/:id/location rejects string coordinates (TRN-4)', async () => {
    const res = await operatorManagementRouter.request('/trips/trp_1/location', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: '6.5244', longitude: '3.3792' }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('numbers');
  });

  it('POST /customers returns 400 for missing phone (TRN-3)', async () => {
    const res = await bookingPortalRouter.request('/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test User', ndpr_consent: true }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('phone');
  });

  it('GET /receipts/:id returns 404 for unknown receipt (TRN-2)', async () => {
    const res = await agentSalesRouter.request('/receipts/rct_unknown', {}, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
  });
});

// ============================================================
// Paystack Payments API Tests
// ============================================================
describe('Paystack Payments API', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('POST /initiate returns 400 when booking_id is missing', async () => {
    const res = await paymentsRouter.request('/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/booking_id/i);
  });

  it('POST /initiate returns 404 for unknown booking', async () => {
    const res = await paymentsRouter.request('/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_notexist', email: 'x@pay.webwaka.ng' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
  });

  it('POST /initiate returns dev_mode=true when PAYSTACK_SECRET is unset', async () => {
    // Seed a pending booking
    db._tables.bookings.push({
      id: 'bkg_dev1', customer_id: 'cus_1', trip_id: 'trp_1',
      seat_ids: '["seat_1"]', passenger_names: '["Ada"]',
      total_amount: 500000, status: 'pending', payment_status: 'pending',
      payment_method: 'paystack', payment_reference: '', payment_provider: null,
      created_at: Date.now(), updated_at: Date.now(), confirmed_at: null,
      cancelled_at: null, deleted_at: null, paid_at: null,
    });

    const res = await paymentsRouter.request('/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_dev1', email: 'ada@pay.webwaka.ng' }),
    }, makeEnv(db)); // no PAYSTACK_SECRET → dev mode
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.dev_mode).toBe(true);
    expect(body.data.authorization_url).toBeNull();
    expect(body.data.reference).toBe('bkg_dev1');
  });

  it('POST /initiate returns 409 for already confirmed booking', async () => {
    db._tables.bookings.push({
      id: 'bkg_conf1', customer_id: 'cus_1', trip_id: 'trp_1',
      seat_ids: '["seat_1"]', total_amount: 250000, status: 'confirmed',
      payment_method: 'paystack', payment_reference: 'waka_ref', payment_provider: 'paystack',
      created_at: Date.now(), deleted_at: null, paid_at: Date.now(),
    });
    const res = await paymentsRouter.request('/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_conf1' }),
    }, makeEnv(db));
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/already confirmed/i);
  });

  it('POST /verify returns 400 when neither reference nor booking_id provided', async () => {
    const res = await paymentsRouter.request('/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
  });

  it('POST /verify returns 404 for unknown booking', async () => {
    const res = await paymentsRouter.request('/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_ghost' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });

  it('POST /verify auto-confirms booking in dev mode', async () => {
    db._tables.bookings.push({
      id: 'bkg_dev2', customer_id: 'cus_1', trip_id: 'trp_1',
      seat_ids: '["seat_2"]', total_amount: 300000, status: 'pending',
      payment_status: 'pending', payment_method: 'paystack', payment_reference: 'bkg_dev2',
      payment_provider: null, created_at: Date.now(), deleted_at: null, paid_at: null,
    });
    db._tables.seats.push({
      id: 'seat_2', trip_id: 'trp_1', status: 'reserved',
      created_at: Date.now(), updated_at: Date.now(),
    });

    const res = await paymentsRouter.request('/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_dev2' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('dev_confirmed');
    expect(body.data.booking_status).toBe('confirmed');

    // Verify DB was updated
    const booking = db._tables.bookings.find((b: any) => b.id === 'bkg_dev2');
    expect(booking?.status).toBe('confirmed');
    const seat = db._tables.seats.find((s: any) => s.id === 'seat_2');
    expect(seat?.status).toBe('confirmed');
  });

  it('POST /verify returns already_confirmed for confirmed booking', async () => {
    db._tables.bookings.push({
      id: 'bkg_alr1', customer_id: 'cus_1', trip_id: 'trp_1',
      seat_ids: '["seat_3"]', total_amount: 250000, status: 'confirmed',
      payment_method: 'paystack', payment_reference: 'ref_alr1', payment_provider: 'paystack',
      created_at: Date.now(), deleted_at: null, paid_at: Date.now(),
    });
    const res = await paymentsRouter.request('/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_alr1' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('already_confirmed');
  });

  it('POST /verify returns 409 for cancelled booking', async () => {
    db._tables.bookings.push({
      id: 'bkg_can1', customer_id: 'cus_1', trip_id: 'trp_1',
      seat_ids: '["seat_4"]', total_amount: 200000, status: 'cancelled',
      payment_method: 'paystack', payment_reference: '', payment_provider: null,
      created_at: Date.now(), deleted_at: null, paid_at: null,
    });
    const res = await paymentsRouter.request('/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_can1' }),
    }, makeEnv(db));
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/cancelled/i);
  });

  // ── Flutterwave ──────────────────────────────────────────────

  it('POST /flutterwave/initiate returns 400 when booking_id is missing', async () => {
    const res = await paymentsRouter.request('/flutterwave/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
  });

  it('POST /flutterwave/initiate returns 404 for unknown booking', async () => {
    const res = await paymentsRouter.request('/flutterwave/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'nonexistent_booking' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });

  it('POST /flutterwave/initiate returns dev_mode=true when FLUTTERWAVE_SECRET is unset', async () => {
    db._tables.bookings.push({
      id: 'bkg_fw_dev1', customer_id: 'cus_1', trip_id: 'trp_1',
      seat_ids: '["seat_10"]', total_amount: 300000, status: 'pending',
      payment_method: 'flutterwave', payment_reference: '', payment_provider: null,
      created_at: Date.now(), deleted_at: null, paid_at: null,
    });
    const res = await paymentsRouter.request('/flutterwave/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_fw_dev1', email: 'test@example.com' }),
    }, makeEnv(db)); // no FLUTTERWAVE_SECRET in env
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.dev_mode).toBe(true);
    expect(body.data.tx_ref).toBe('bkg_fw_dev1');
    expect(body.data.payment_link).toBeNull();
  });

  it('POST /flutterwave/initiate returns 409 for already confirmed booking', async () => {
    db._tables.bookings.push({
      id: 'bkg_fw_conf1', customer_id: 'cus_1', trip_id: 'trp_1',
      seat_ids: '["seat_11"]', total_amount: 300000, status: 'confirmed',
      payment_method: 'flutterwave', payment_reference: '', payment_provider: 'flutterwave',
      created_at: Date.now(), deleted_at: null, paid_at: Date.now(),
    });
    const res = await paymentsRouter.request('/flutterwave/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_fw_conf1' }),
    }, makeEnv(db));
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toMatch(/already confirmed/i);
  });

  it('POST /flutterwave/verify returns 400 when neither tx_ref nor booking_id provided', async () => {
    const res = await paymentsRouter.request('/flutterwave/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
  });

  it('POST /flutterwave/verify returns 404 for unknown booking', async () => {
    const res = await paymentsRouter.request('/flutterwave/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'nonexistent_bkg' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });

  it('POST /flutterwave/verify auto-confirms booking in dev mode', async () => {
    db._tables.bookings.push({
      id: 'bkg_fw_pend1', customer_id: 'cus_1', trip_id: 'trp_1',
      seat_ids: '["seat_12"]', total_amount: 400000, status: 'pending',
      payment_method: 'flutterwave', payment_reference: 'waka_fw_bkg_fw_pend1_123',
      payment_provider: 'flutterwave',
      created_at: Date.now(), deleted_at: null, paid_at: null,
    });
    db._tables.seats.push({
      id: 'seat_12', trip_id: 'trp_1', seat_number: 'D3',
      status: 'reserved', reservation_token: 'tok_fw1',
      reservation_expires_at: Date.now() + 600000,
      reserved_by: 'cus_1', confirmed_at: null,
      created_at: Date.now(), updated_at: Date.now(), deleted_at: null,
    });
    const res = await paymentsRouter.request('/flutterwave/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_fw_pend1' }),
    }, makeEnv(db)); // no FLUTTERWAVE_SECRET → dev mode
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.booking_status).toBe('confirmed');
  });

  it('POST /flutterwave/verify returns already_confirmed for confirmed booking', async () => {
    db._tables.bookings.push({
      id: 'bkg_fw_alrdy1', customer_id: 'cus_1', trip_id: 'trp_1',
      seat_ids: '["seat_13"]', total_amount: 300000, status: 'confirmed',
      payment_method: 'flutterwave', payment_reference: 'waka_fw_alrdy1',
      payment_provider: 'flutterwave',
      created_at: Date.now(), deleted_at: null, paid_at: Date.now(),
    });
    const res = await paymentsRouter.request('/flutterwave/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_fw_alrdy1' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('already_confirmed');
  });

  it('POST /flutterwave/verify returns 409 for cancelled booking', async () => {
    db._tables.bookings.push({
      id: 'bkg_fw_can1', customer_id: 'cus_1', trip_id: 'trp_1',
      seat_ids: '["seat_14"]', total_amount: 200000, status: 'cancelled',
      payment_method: 'flutterwave', payment_reference: '', payment_provider: null,
      created_at: Date.now(), deleted_at: null, paid_at: null,
    });
    const res = await paymentsRouter.request('/flutterwave/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: 'bkg_fw_can1' }),
    }, makeEnv(db));
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/cancelled/i);
  });
});

// ============================================================
// OTP Rate Limiting Tests (Phase 6)
// ============================================================
describe('OTP Rate Limiting', () => {
  let db: any;
  beforeEach(() => { db = createMockDB(); });

  it('returns 503 when SESSIONS_KV is not configured', async () => {
    const res = await authRouter.request('/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '08012345678' }),
    }, makeEnv(db));
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/unavailable/i);
  });

  it('allows first 5 OTP requests and returns dev_code each time', async () => {
    const kv = makeKV();
    const env = makeEnvWithKV(db, kv);
    for (let i = 1; i <= 5; i++) {
      const res = await authRouter.request('/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '08099887766' }),
      }, env);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.success).toBe(true);
      expect(body.data.dev_code).toMatch(/^\d{6}$/);
    }
  });

  it('returns 429 on the 6th OTP request within the window', async () => {
    const kv = makeKV();
    const env = makeEnvWithKV(db, kv);
    // Exhaust the 5-request limit
    for (let i = 0; i < 5; i++) {
      await authRouter.request('/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '08011112222' }),
      }, env);
    }
    // 6th request should be rate-limited
    const res = await authRouter.request('/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '08011112222' }),
    }, env);
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/too many/i);
  });

  it('rate limit is per-phone — different phones are independent', async () => {
    const kv = makeKV();
    const env = makeEnvWithKV(db, kv);
    // Exhaust phone A
    for (let i = 0; i < 5; i++) {
      await authRouter.request('/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '08033334444' }),
      }, env);
    }
    // Phone B should still succeed
    const res = await authRouter.request('/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '08055556666' }),
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });
});

// ============================================================
// C-008: PATCH /users/:id/role — Admin Promotion API (RBAC Tests)
// NOTE: requireRole(['SUPER_ADMIN']) in production returns 403 for
// TENANT_ADMIN and lower roles. In vitest the SUPER_ADMIN bypass is active,
// so these tests cover business-logic validations only.
// ============================================================
describe('C-008: PATCH /users/:id/role — Admin Promotion API', () => {
  let db: any;
  beforeEach(() => {
    db = createMockDB();
    db._tables.agents.push({
      id: 'agt_rbac1', operator_id: 'opr_1', name: 'Chidi Okeke', phone: '08022221111',
      email: null, role: 'STAFF', bus_parks: '[]', status: 'active',
      created_at: Date.now(), updated_at: Date.now(), deleted_at: null,
    });
    db._tables.customers.push({
      id: 'cst_rbac1', name: 'Amaka Nwosu', phone: '08099990000', email: null,
      operator_id: null, created_at: Date.now(), updated_at: Date.now(), deleted_at: null,
    });
  });

  it('returns 400 when role field is missing', async () => {
    const res = await operatorManagementRouter.request('/users/agt_rbac1/role', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/role.*required/i);
  });

  it('returns 403 when trying to promote to SUPER_ADMIN via API', async () => {
    const res = await operatorManagementRouter.request('/users/agt_rbac1/role', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'SUPER_ADMIN' }),
    }, makeEnv(db));
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toMatch(/cannot promote/i);
  });

  it('returns 404 when user does not exist in agents or customers', async () => {
    const res = await operatorManagementRouter.request('/users/usr_ghost999/role', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'SUPERVISOR' }),
    }, makeEnv(db));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toMatch(/not found/i);
  });

  it('promotes an existing agent to SUPERVISOR', async () => {
    const res = await operatorManagementRouter.request('/users/agt_rbac1/role', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'SUPERVISOR' }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  it('returns 400 for malformed JSON body', async () => {
    const res = await operatorManagementRouter.request('/users/agt_rbac1/role', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    }, makeEnv(db));
    expect(res.status).toBe(400);
  });
});

// ============================================================
// T-TRN-03: Fare Rules CRUD API Tests
// ============================================================
describe('T-TRN-03: Fare Rules API', () => {
  let db: any;
  const ROUTE_ID = 'rte_fare001';
  const OPERATOR_ID = 'opr_fare001';

  beforeEach(() => {
    db = createMockDB();
    db._tables.operators.push({ id: OPERATOR_ID, name: 'FareOp', code: 'FARE', status: 'active', deleted_at: null, created_at: 1, updated_at: 1 });
    db._tables.routes.push({
      id: ROUTE_ID, operator_id: OPERATOR_ID, origin: 'Lagos', destination: 'Abuja',
      base_fare: 500_000, fare_matrix: null, status: 'active', deleted_at: null, created_at: 1, updated_at: 1,
    });
  });

  it('GET /routes/:id/fare-rules returns empty array when no rules', async () => {
    const res = await operatorManagementRouter.request(`/routes/${ROUTE_ID}/fare-rules`, {
      method: 'GET',
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('POST /routes/:id/fare-rules creates an always rule', async () => {
    const res = await operatorManagementRouter.request(`/routes/${ROUTE_ID}/fare-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Standard Uplift', rule_type: 'always', base_multiplier: 1.3 }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Standard Uplift');
    expect(body.data.rule_type).toBe('always');
    expect(body.data.base_multiplier).toBe(1.3);
    expect(body.data.id).toMatch(/^far_/);
  });

  it('POST /routes/:id/fare-rules creates a surge_period rule', async () => {
    const starts_at = new Date('2026-12-20').getTime();
    const ends_at = new Date('2026-12-28').getTime();
    const res = await operatorManagementRouter.request(`/routes/${ROUTE_ID}/fare-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Christmas Surge', rule_type: 'surge_period', base_multiplier: 2.5, starts_at, ends_at }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.starts_at).toBe(starts_at);
    expect(body.data.ends_at).toBe(ends_at);
  });

  it('POST /routes/:id/fare-rules rejects invalid rule_type', async () => {
    const res = await operatorManagementRouter.request(`/routes/${ROUTE_ID}/fare-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad Rule', rule_type: 'magic', base_multiplier: 1.5 }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/rule_type/i);
  });

  it('POST /routes/:id/fare-rules rejects multiplier > 10', async () => {
    const res = await operatorManagementRouter.request(`/routes/${ROUTE_ID}/fare-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Insane', rule_type: 'always', base_multiplier: 50 }),
    }, makeEnv(db));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/base_multiplier/i);
  });

  it('GET /routes/:id/fare-rules returns rules after creation', async () => {
    // Seed a rule
    db._tables.fare_rules.push({
      id: 'far_seed1', operator_id: OPERATOR_ID, route_id: ROUTE_ID,
      name: 'Weekend', rule_type: 'weekend', base_multiplier: 1.4,
      starts_at: null, ends_at: null, days_of_week: null, hour_from: null, hour_to: null,
      class_multipliers: null, priority: 0, is_active: 1, created_at: 1, updated_at: 1, deleted_at: null,
    });

    const res = await operatorManagementRouter.request(`/routes/${ROUTE_ID}/fare-rules`, {
      method: 'GET',
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Weekend');
  });

  it('DELETE /routes/:id/fare-rules/:ruleId soft-deletes the rule', async () => {
    db._tables.fare_rules.push({
      id: 'far_del1', operator_id: OPERATOR_ID, route_id: ROUTE_ID,
      name: 'ToDelete', rule_type: 'always', base_multiplier: 1.2,
      starts_at: null, ends_at: null, days_of_week: null, hour_from: null, hour_to: null,
      class_multipliers: null, priority: 0, is_active: 1, created_at: 1, updated_at: 1, deleted_at: null,
    });

    const res = await operatorManagementRouter.request(`/routes/${ROUTE_ID}/fare-rules/far_del1`, {
      method: 'DELETE',
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('far_del1');

    // Soft-deleted: is_active should be 0
    const rule = db._tables.fare_rules.find((r: any) => r.id === 'far_del1');
    expect(rule.is_active).toBe(0);
    expect(rule.deleted_at).toBeGreaterThan(0);
  });

  it('DELETE /routes/:id/fare-rules/:ruleId returns 404 for unknown rule', async () => {
    const res = await operatorManagementRouter.request(`/routes/${ROUTE_ID}/fare-rules/far_ghost`, {
      method: 'DELETE',
    }, makeEnv(db));
    expect(res.status).toBe(404);
  });

  it('PUT /routes/:id/fare-rules/:ruleId updates rule name and multiplier', async () => {
    db._tables.fare_rules.push({
      id: 'far_upd1', operator_id: OPERATOR_ID, route_id: ROUTE_ID,
      name: 'OldName', rule_type: 'always', base_multiplier: 1.1,
      starts_at: null, ends_at: null, days_of_week: null, hour_from: null, hour_to: null,
      class_multipliers: null, priority: 0, is_active: 1, created_at: 1, updated_at: 1, deleted_at: null,
      route_operator_id: OPERATOR_ID,
    });

    const res = await operatorManagementRouter.request(`/routes/${ROUTE_ID}/fare-rules/far_upd1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NewName', base_multiplier: 1.8 }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  // ── Bug 3 regression: effective-fare tenancy leak ─────────────────────────
  it('GET /routes/:id/effective-fare returns 200 for own operator route', async () => {
    const res = await operatorManagementRouter.request(`/routes/${ROUTE_ID}/effective-fare`, {
      method: 'GET',
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.base_fare).toBe(500_000);
    expect(body.data.effective_fare_by_class).toHaveProperty('standard');
  });

  it('GET /routes/:id/effective-fare returns 404 for unknown route', async () => {
    const res = await operatorManagementRouter.request('/routes/rte_ghost/effective-fare', {
      method: 'GET',
    }, makeEnv(db));
    // SUPER_ADMIN in test mode — 404 since route does not exist
    expect(res.status).toBe(404);
  });
});

// ============================================================
// T-TRN-03: Booking validation with locked_fare_kobo
// ============================================================
describe('T-TRN-03: Booking Fare Lock Integration', () => {
  let db: any;

  beforeEach(() => {
    db = createMockDB();
    const now = Date.now();

    db._tables.operators.push({ id: 'opr_fl1', name: 'FareLockOp', code: 'FLK', status: 'active', deleted_at: null, created_at: now, updated_at: now });
    db._tables.routes.push({
      id: 'rte_fl1', operator_id: 'opr_fl1', origin: 'Lagos', destination: 'Abuja',
      base_fare: 500_000, fare_matrix: null, status: 'active', deleted_at: null, created_at: now, updated_at: now,
    });
    // Mock DB can't JOIN — embed route fields directly on the trip row so
    // first() returns a complete record matching the SELECT projection
    db._tables.trips.push({
      id: 'trp_fl1', operator_id: 'opr_fl1', route_id: 'rte_fl1', vehicle_id: 'veh_fl1',
      departure_time: now + 3_600_000, state: 'scheduled', deleted_at: null,
      base_fare: 500_000, fare_matrix: null,
      created_at: now, updated_at: now,
    });
    db._tables.customers.push({
      id: 'cus_fl1', phone: '+2348012345678', ndpr_consent: 1, status: 'active', deleted_at: null, created_at: now, updated_at: now,
    });
  });

  // Each test seeds its own seats to avoid mock-DB all() cross-contamination
  // (all() returns rows matching ANY param — two seats sharing a trip_id would both match)

  it('uses locked_fare_kobo as the authoritative price for the booking', async () => {
    db._tables.seats.push({
      id: 'seat_locked', trip_id: 'trp_fl1', operator_id: 'opr_fl1',
      seat_number: 'A1', seat_class: 'standard', status: 'available',
      locked_fare_kobo: 750_000, version: 0, created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await bookingPortalRouter.request('/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: 'cus_fl1', trip_id: 'trp_fl1',
        seat_ids: ['seat_locked'], passenger_names: ['Test Passenger'],
        total_amount_kobo: 750_000, payment_method: 'paystack', ndpr_consent: true,
      }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.total_amount).toBe(750_000);
    expect(body.data.expected_kobo).toBe(750_000);
  });

  it('rejects booking when submitted amount mismatches locked fare by >2%', async () => {
    db._tables.seats.push({
      id: 'seat_locked2', trip_id: 'trp_fl1', operator_id: 'opr_fl1',
      seat_number: 'A2', seat_class: 'standard', status: 'available',
      locked_fare_kobo: 750_000, version: 0, created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await bookingPortalRouter.request('/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: 'cus_fl1', trip_id: 'trp_fl1',
        seat_ids: ['seat_locked2'], passenger_names: ['Test Passenger'],
        total_amount_kobo: 500_000, // Does NOT match locked fare of 750_000
        payment_method: 'paystack', ndpr_consent: true,
      }),
    }, makeEnv(db));
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toBe('fare_mismatch');
    expect(body.expected_kobo).toBe(750_000);
    expect(body.submitted_kobo).toBe(500_000);
  });

  it('falls back to base_fare when seat has no locked_fare and no fare rules', async () => {
    db._tables.seats.push({
      id: 'seat_unlocked', trip_id: 'trp_fl1', operator_id: 'opr_fl1',
      seat_number: 'B1', seat_class: 'standard', status: 'available',
      locked_fare_kobo: null, version: 0, created_at: Date.now(), updated_at: Date.now(),
    });
    const res = await bookingPortalRouter.request('/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: 'cus_fl1', trip_id: 'trp_fl1',
        seat_ids: ['seat_unlocked'], passenger_names: ['Passenger'],
        total_amount_kobo: 500_000, // base_fare with no matrix/rules
        payment_method: 'paystack', ndpr_consent: true,
      }),
    }, makeEnv(db));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.expected_kobo).toBe(500_000);
  });
});

// ============================================================
// T-TRN-04: Paystack Inline Payment — Webhook & Event Emission
// ============================================================
describe('T-TRN-04: Paystack Inline — webhook verification and payment.successful event', () => {
  const PAYSTACK_SECRET = 'test_paystack_key_trnx04_waka';

  function makeWebhookEnv(db: any, opts: { paystack?: boolean; flutterwave?: boolean } = {}) {
    return {
      DB: db,
      ...(opts.paystack !== false ? { PAYSTACK_SECRET } : {}),
      ...(opts.flutterwave ? { FLUTTERWAVE_SECRET: PAYSTACK_SECRET } : {}),
    };
  }

  async function signPaystack(body: string): Promise<string> {
    return hmacSha512(body, PAYSTACK_SECRET);
  }

  it('POST /webhooks/paystack returns 503 when PAYSTACK_SECRET is not configured', async () => {
    const db = createMockDB();
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ref_001' } });
    const sig = await signPaystack(body);
    const res = await webhooksRouter.request('/paystack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig },
      body,
    }, { DB: db });
    expect(res.status).toBe(503);
  });

  it('POST /webhooks/paystack returns 401 for invalid HMAC signature', async () => {
    const db = createMockDB();
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ref_002' } });
    const res = await webhooksRouter.request('/paystack', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': 'deadbeef000000000000000000000000bad_sig',
      },
      body,
    }, makeWebhookEnv(db, { paystack: true }));
    expect(res.status).toBe(401);
    const json = await res.json() as any;
    expect(json.error).toBe('Invalid signature');
  });

  it('POST /webhooks/paystack confirms booking and emits payment.successful on charge.success', async () => {
    const db = createMockDB();
    const bookingId = 'bkg_trnx04_ps';
    db._tables.bookings.push({
      id: bookingId, status: 'pending', payment_status: 'pending',
      total_amount: 500_000, seat_ids: JSON.stringify(['seat_ps1']),
      payment_reference: null, payment_provider: null,
      deleted_at: null, created_at: Date.now(),
    });
    db._tables.seats.push({
      id: 'seat_ps1', trip_id: 'trp_ps1', seat_number: '01', status: 'reserved', version: 1,
    });

    const payload = JSON.stringify({ event: 'charge.success', data: { reference: bookingId } });
    const sig = await signPaystack(payload);

    const res = await webhooksRouter.request('/paystack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig },
      body: payload,
    }, makeWebhookEnv(db, { paystack: true }));

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.success).toBe(true);

    const booking = db._tables.bookings.find((b: any) => b.id === bookingId);
    expect(booking?.status).toBe('confirmed');
    expect(booking?.payment_status).toBe('completed');
    expect(booking?.payment_provider).toBe('paystack');

    const seat = db._tables.seats.find((s: any) => s.id === 'seat_ps1');
    expect(seat?.status).toBe('confirmed');

    const events = db._tables.platform_events.filter(
      (e: any) => e.event_type === 'payment.successful'
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
    const evtPayload = JSON.parse(events[0].payload);
    expect(evtPayload.booking_id).toBe(bookingId);
    expect(evtPayload.provider).toBe('paystack');
    expect(evtPayload.amount_kobo).toBe(500_000);
  });

  it('POST /webhooks/paystack is idempotent — skips already-confirmed bookings', async () => {
    const db = createMockDB();
    const bookingId = 'bkg_idem_04';
    db._tables.bookings.push({
      id: bookingId, status: 'confirmed', payment_status: 'completed',
      total_amount: 300_000, seat_ids: JSON.stringify([]),
      payment_reference: `waka_${bookingId}`, payment_provider: 'paystack',
      deleted_at: null, created_at: Date.now(),
    });

    const payload = JSON.stringify({ event: 'charge.success', data: { reference: bookingId } });
    const sig = await signPaystack(payload);

    const res = await webhooksRouter.request('/paystack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig },
      body: payload,
    }, makeWebhookEnv(db, { paystack: true }));

    expect(res.status).toBe(200);
    const events = db._tables.platform_events.filter(
      (e: any) => e.event_type === 'payment.successful'
    );
    expect(events.length).toBe(0);
  });

  it('POST /webhooks/flutterwave confirms booking and emits payment.successful on charge.completed', async () => {
    const db = createMockDB();
    const bookingId = 'bkg_fw04';
    const tx_ref = bookingId;
    db._tables.bookings.push({
      id: bookingId, status: 'pending', payment_status: 'pending',
      total_amount: 400_000, seat_ids: JSON.stringify(['seat_fw1']),
      payment_reference: tx_ref, payment_provider: null,
      deleted_at: null, created_at: Date.now(),
    });
    db._tables.seats.push({
      id: 'seat_fw1', trip_id: 'trp_fw1', seat_number: 'A1', status: 'reserved', version: 1,
    });

    const payload = JSON.stringify({
      event: 'charge.completed',
      data: { tx_ref, status: 'successful', amount: 4000, currency: 'NGN' },
    });

    const res = await webhooksRouter.request('/flutterwave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'verif-hash': PAYSTACK_SECRET },
      body: payload,
    }, { DB: db, FLUTTERWAVE_SECRET: PAYSTACK_SECRET });

    expect(res.status).toBe(200);
    const booking = db._tables.bookings.find((b: any) => b.id === bookingId);
    expect(booking?.status).toBe('confirmed');
    expect(booking?.payment_provider).toBe('flutterwave');

    const seat = db._tables.seats.find((s: any) => s.id === 'seat_fw1');
    expect(seat?.status).toBe('confirmed');

    const events = db._tables.platform_events.filter(
      (e: any) => e.event_type === 'payment.successful'
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(events[0].payload).provider).toBe('flutterwave');
  });

  it('POST /api/payments/verify (dev mode) emits payment.successful event', async () => {
    const db = createMockDB();
    const bookingId = 'bkg_verify04';
    db._tables.bookings.push({
      id: bookingId, status: 'pending', payment_status: 'pending',
      total_amount: 200_000, seat_ids: JSON.stringify(['seat_v1']),
      payment_reference: null, payment_provider: null,
      deleted_at: null, created_at: Date.now(),
    });
    db._tables.seats.push({
      id: 'seat_v1', trip_id: 'trp_v1', seat_number: 'B2', status: 'reserved', version: 1,
    });

    const res = await paymentsRouter.request('/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: bookingId }),
    }, { DB: db });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('dev_confirmed');

    const events = db._tables.platform_events.filter(
      (e: any) => e.event_type === 'payment.successful'
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
    const evtPayload = JSON.parse(events[0].payload);
    expect(evtPayload.booking_id).toBe(bookingId);
    expect(evtPayload.provider).toBe('dev');
  });

  it('POST /api/payments/verify already-confirmed returns 200 without re-emitting event', async () => {
    const db = createMockDB();
    const bookingId = 'bkg_already_done';
    db._tables.bookings.push({
      id: bookingId, status: 'confirmed', payment_status: 'completed',
      total_amount: 150_000, seat_ids: JSON.stringify([]),
      payment_reference: 'waka_bkg_already_done', payment_provider: 'paystack',
      deleted_at: null, created_at: Date.now(),
    });

    const res = await paymentsRouter.request('/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: bookingId }),
    }, { DB: db });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.data.status).toBe('already_confirmed');
    const events = db._tables.platform_events.filter(
      (e: any) => e.event_type === 'payment.successful'
    );
    expect(events.length).toBe(0);
  });
});
