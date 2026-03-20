/**
 * Transport API Unit Tests — TRN-1 through TRN-4
 * Tests all Hono API routes using in-memory mock D1
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { seatInventoryRouter } from './seat-inventory';
import { agentSalesRouter } from './agent-sales';
import { bookingPortalRouter } from './booking-portal';
import { operatorManagementRouter } from './operator-management';

// ============================================================
// Mock D1 Database
// ============================================================
function createMockDB() {
  const tables: Record<string, any[]> = {
    trips: [], seats: [], operators: [], routes: [], vehicles: [],
    agents: [], sales_transactions: [], receipts: [], customers: [],
    bookings: [], trip_state_transitions: [], sync_mutations: [],
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
        const [col, _] = cond.split(/!=|<>/);
        const val = params[paramIdx++];
        return row[col.trim().split('.').pop()!] !== val;
      }
      if (cond.includes('=')) {
        const [col, _] = cond.split('=');
        const val = params[paramIdx++];
        const colName = col.trim().split('.').pop()!;
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
              const tbl = m[1].toLowerCase();
              if (!tables[tbl]) tables[tbl] = [];
              // Only insert if id doesn't exist
              const idIdx = this._sql.match(/\(([^)]+)\)/)?.[1].split(',').findIndex((c: string) => c.trim() === 'id') ?? 0;
              const id = this._params[idIdx];
              if (!tables[tbl].find((r: any) => r.id === id)) {
                const cols = this._sql.match(/\(([^)]+)\)/)?.[1].split(',').map((c: string) => c.trim()) ?? [];
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
              const tbl = m[1].toLowerCase();
              if (!tables[tbl]) tables[tbl] = [];
              const cols = this._sql.match(/\(([^)]+)\)/)?.[1].split(',').map((c: string) => c.trim()) ?? [];
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
              const tbl = m[1].toLowerCase();
              if (!tables[tbl]) tables[tbl] = [];
              const cols = this._sql.match(/\(([^)]+)\)/)?.[1].split(',').map((c: string) => c.trim()) ?? [];
              const row: any = {};
              cols.forEach((col: string, i: number) => { row[col] = this._params[i]; });
              tables[tbl].push(row);
            }
            return { success: true };
          }
          if (sql.startsWith('UPDATE')) {
            const m = this._sql.match(/UPDATE\s+(\w+)/i);
            if (m) {
              const tbl = m[1].toLowerCase();
              if (tables[tbl]) {
                const idParam = this._params[this._params.length - 1];
                tables[tbl] = tables[tbl].map((r: any) => {
                  if (r.id === idParam) {
                    const setClause = this._sql.match(/SET\s+(.+?)\s+WHERE/is)?.[1] ?? '';
                    const setParts = setClause.split(',');
                    let paramIdx = 0;
                    setParts.forEach((part: string) => {
                      const [col, _] = part.split('=');
                      const colName = col.trim().split('.').pop()!;
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
          const tbl = m[1].toLowerCase();
          if (!tables[tbl]) return null;
          const idParam = this._params[this._params.length - 1];
          return tables[tbl].find((r: any) => r.id === idParam) ?? null;
        },
        async all() {
          const m = this._sql.match(/FROM\s+(\w+)(?:\s+\w+)?/i);
          if (!m) return { results: [] };
          const tbl = m[1].toLowerCase();
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
    // Pre-populate seats
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
