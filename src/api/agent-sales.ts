/**
 * TRN-2: Agent Sales API (Offline-First Bus Park POS)
 * Invariants: Offline-First (sync queue), Nigeria-First (kobo/cash), Multi-tenancy
 * Security: JWT auth via global middleware in worker.ts; per-route RBAC via requireRole
 */
import { Hono } from 'hono';
import { requireRole, publishEvent } from '@webwaka/core';
import type { AppContext, DbAgent, DbSalesTransaction, DbReceipt } from './types';
import { genId, parsePagination, metaResponse, requireFields, applyTenantScope } from './types';

// ---- Fare helpers (copied from booking-portal; keep in sync) ----
interface GrpFareMatrix {
  standard?: number; window?: number; vip?: number; front?: number;
  time_multipliers?: { before_hours: number; multiplier: number }[];
}
function grpComputeFareByClass(baseFare: number, matrix: GrpFareMatrix | null, departureTime: number): Record<string, number> {
  const classes = ['standard', 'window', 'vip', 'front'] as const;
  let timeMultiplier = 1.0;
  if (matrix?.time_multipliers) {
    const hoursUntil = (departureTime - Date.now()) / 3_600_000;
    for (const tm of matrix.time_multipliers) {
      if (hoursUntil <= tm.before_hours) { timeMultiplier = Math.min(5.0, Math.max(1.0, tm.multiplier)); break; }
    }
  }
  const result: Record<string, number> = {};
  for (const cls of classes) {
    const classRate = matrix?.[cls] ?? 1.0;
    result[cls] = Math.round(baseFare * classRate * timeMultiplier);
  }
  return result;
}

export const agentSalesRouter = new Hono<AppContext>();

// ============================================================
// GET /agents — list agents
// ============================================================
agentSalesRouter.get('/agents', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'SUPERVISOR']), async (c) => {
  const q = c.req.query();
  const { status } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  let query = `SELECT * FROM agents WHERE deleted_at IS NULL`;
  const params: unknown[] = [];

  const scoped = applyTenantScope(c, query, params);
  query = scoped.query;
  params.splice(0, params.length, ...scoped.params);

  if (status) { query += ` AND status = ?`; params.push(status); }
  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...params).all<DbAgent>();
    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch agents' }, 500);
  }
});

// ============================================================
// POST /agents — register an agent (SUPER_ADMIN or TENANT_ADMIN)
// ============================================================
agentSalesRouter.post('/agents', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['operator_id', 'name', 'phone']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { operator_id, name, phone, email, role, bus_parks } = body as {
    operator_id: string; name: string; phone: string;
    email?: string; role?: string; bus_parks?: string[];
  };

  const db = c.env.DB;
  const id = genId('agt');
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT INTO agents (id, operator_id, name, phone, email, role, bus_parks, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(id, operator_id, name, phone, email ?? null, role ?? 'agent', JSON.stringify(bus_parks ?? []), now, now).run();

    return c.json({ success: true, data: { id, operator_id, name, phone, role: role ?? 'agent', status: 'active' } }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('UNIQUE')) return c.json({ success: false, error: 'Agent phone already registered' }, 409);
    return c.json({ success: false, error: 'Failed to register agent' }, 500);
  }
});

// ============================================================
// POST /transactions — record a sale (STAFF+)
// ============================================================
agentSalesRouter.post('/transactions', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['agent_id', 'trip_id', 'seat_ids', 'passenger_names', 'total_amount', 'payment_method']);
  if (err) return c.json({ success: false, error: err }, 400);

  const {
    agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method,
    passenger_id_type, passenger_id_number, park_id,
  } = body as {
    agent_id: string; trip_id: string; seat_ids: string[]; passenger_names: string[];
    total_amount: number; payment_method: string;
    passenger_id_type?: string | null; passenger_id_number?: string | null;
    park_id?: string | null;
  };

  if (!Number.isInteger(total_amount) || total_amount <= 0) {
    return c.json({ success: false, error: 'total_amount must be a positive integer (kobo)' }, 400);
  }
  if (!Array.isArray(seat_ids) || seat_ids.length === 0) {
    return c.json({ success: false, error: 'seat_ids must be a non-empty array' }, 400);
  }

  // T5-7: Both passenger_id fields must be provided together or neither
  if (passenger_id_number && !passenger_id_type) {
    return c.json({ success: false, error: 'passenger_id_type is required when passenger_id_number is provided' }, 400);
  }
  if (passenger_id_type && !passenger_id_number) {
    return c.json({ success: false, error: 'passenger_id_number is required when passenger_id_type is provided' }, 400);
  }

  // Validate passenger ID type if provided
  const VALID_ID_TYPES = ['NIN', 'BVN', 'passport', 'drivers_license'];
  if (passenger_id_type && !VALID_ID_TYPES.includes(passenger_id_type)) {
    return c.json({ success: false, error: `passenger_id_type must be one of: ${VALID_ID_TYPES.join(', ')}` }, 400);
  }

  // Hash passenger ID number if provided (never store raw)
  let passenger_id_hash: string | null = null;
  if (passenger_id_number) {
    const encoder = new TextEncoder();
    const data = encoder.encode(passenger_id_number);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    passenger_id_hash = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const db = c.env.DB;
  const id = genId('txn');
  const receiptId = genId('rct');
  const now = Date.now();

  // Build QR code payload: bookingId:seatId1,seatId2,...
  const qrCode = `${id}:${seat_ids.join(',')}`;

  // Verify all seats are still available before recording sale
  try {
    const seatChecks = await Promise.all(
      seat_ids.map(seatId =>
        db.prepare(`SELECT id, status, trip_id FROM seats WHERE id = ?`)
          .bind(seatId).first<{ id: string; status: string; trip_id: string }>()
      )
    );
    for (const seat of seatChecks) {
      if (!seat || seat.trip_id !== trip_id) return c.json({ success: false, error: 'One or more seats not found for this trip' }, 404);
      if (seat.status === 'confirmed' || seat.status === 'blocked') {
        return c.json({ success: false, error: `Seat ${seat.id} is ${seat.status} and cannot be sold` }, 409);
      }
    }
  } catch {
    return c.json({ success: false, error: 'Failed to verify seat availability' }, 500);
  }

  // Fetch seat numbers for receipt
  const seatRows = await db.prepare(
    `SELECT id, seat_number FROM seats WHERE id IN (${seat_ids.map(() => '?').join(',')})`,
  ).bind(...seat_ids).all<{ id: string; seat_number: string }>().catch(() => ({ results: [] as { id: string; seat_number: string }[] }));
  const seatNumbers = seatRows.results.map(s => s.seat_number);

  try {
    await db.batch([
      db.prepare(
        `INSERT INTO sales_transactions (id, agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method, payment_status, sync_status, receipt_id, passenger_id_type, passenger_id_hash, park_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'synced', ?, ?, ?, ?, ?)`
      ).bind(id, agent_id, trip_id, JSON.stringify(seat_ids), JSON.stringify(passenger_names), total_amount, payment_method, receiptId, passenger_id_type ?? null, passenger_id_hash, park_id ?? null, now),
      db.prepare(
        `INSERT INTO receipts (id, transaction_id, agent_id, trip_id, passenger_names, seat_numbers, total_amount, payment_method, qr_code, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(receiptId, id, agent_id, trip_id, JSON.stringify(passenger_names), JSON.stringify(seatNumbers), total_amount, payment_method, qrCode, now),
      ...seat_ids.map(seatId =>
        db.prepare(
          `UPDATE seats SET status = ?, confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`
        ).bind('confirmed', id, now, now, seatId)
      ),
    ]);

    try {
      await publishEvent(db, {
        event_type: 'agent.sale.completed',
        aggregate_id: id,
        aggregate_type: 'sales_transaction',
        payload: { transaction_id: id, agent_id, trip_id, total_amount, payment_method, receipt_id: receiptId },
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    return c.json({
      success: true,
      data: {
        id, agent_id, trip_id, total_amount, payment_method,
        payment_status: 'completed', receipt_id: receiptId,
        qr_code: qrCode, seat_numbers: seatNumbers,
      },
    }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to record transaction' }, 500);
  }
});

// ============================================================
// GET /transactions — list transactions
// ============================================================
agentSalesRouter.get('/transactions', async (c) => {
  const q = c.req.query();
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  // T5-6: Explicitly exclude passenger_id_hash — never return it in API responses
  let query = `SELECT st.id, st.agent_id, st.trip_id, st.seat_ids, st.passenger_names,
    st.total_amount, st.payment_method, st.payment_status, st.sync_status, st.receipt_id,
    st.passenger_id_type, st.park_id, st.created_at, st.synced_at, st.deleted_at
    FROM sales_transactions st
    JOIN agents a ON st.agent_id = a.id
    WHERE st.deleted_at IS NULL`;
  const params: unknown[] = [];

  const scoped = applyTenantScope(c, query, params, 'a.');
  query = scoped.query;
  params.splice(0, params.length, ...scoped.params);

  const { agent_id, trip_id, sync_status, park_id } = q;
  if (agent_id) { query += ` AND st.agent_id = ?`; params.push(agent_id); }
  if (trip_id) { query += ` AND st.trip_id = ?`; params.push(trip_id); }
  if (sync_status) { query += ` AND st.sync_status = ?`; params.push(sync_status); }
  if (park_id) { query += ` AND st.park_id = ?`; params.push(park_id); }
  query += ` ORDER BY st.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...params).all<DbSalesTransaction>();
    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch transactions' }, 500);
  }
});

// ============================================================
// GET /receipts/:id — get a receipt (tenant-scoped)
// ============================================================
agentSalesRouter.get('/receipts/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'SUPERVISOR']), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const jwtUser = c.get('user');
  const isSuperAdmin = jwtUser?.role === 'SUPER_ADMIN';

  try {
    const receipt = await db.prepare(`SELECT * FROM receipts WHERE id = ?`).bind(id).first<DbReceipt>();
    if (!receipt) return c.json({ success: false, error: 'Receipt not found' }, 404);

    // Enforce tenant scope for non-SUPER_ADMIN callers
    if (!isSuperAdmin && jwtUser?.operatorId) {
      const agent = await db.prepare(
        `SELECT operator_id FROM agents WHERE id = ?`
      ).bind(receipt.agent_id).first<{ operator_id: string }>();
      if (!agent || agent.operator_id !== jwtUser.operatorId) {
        return c.json({ success: false, error: 'Receipt not found' }, 404);
      }
    }

    return c.json({ success: true, data: receipt });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch receipt' }, 500);
  }
});

// ============================================================
// PATCH /agents/:id — update agent profile / status
// ============================================================
agentSalesRouter.patch('/agents/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const db = c.env.DB;
  const now = Date.now();

  try {
    const agent = await db.prepare(
      `SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<DbAgent>();
    if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404);

    const { name, phone, email, role, status, bus_parks } = body as {
      name?: string; phone?: string; email?: string;
      role?: string; status?: string; bus_parks?: string[];
    };

    await db.prepare(
      `UPDATE agents
       SET name = COALESCE(?, name),
           phone = COALESCE(?, phone),
           email = COALESCE(?, email),
           role = COALESCE(?, role),
           status = COALESCE(?, status),
           bus_parks = COALESCE(?, bus_parks),
           updated_at = ?
       WHERE id = ?`
    ).bind(
      name ?? null, phone ?? null, email ?? null, role ?? null, status ?? null,
      bus_parks != null ? JSON.stringify(bus_parks) : null,
      now, id
    ).run();

    return c.json({ success: true, data: { id, updated_at: now } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('UNIQUE')) return c.json({ success: false, error: 'Phone already in use' }, 409);
    return c.json({ success: false, error: 'Failed to update agent' }, 500);
  }
});

// ============================================================
// POST /sync — offline-first batch sync (STAFF+)
// ============================================================
agentSalesRouter.post('/sync', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const { agent_id, transactions } = body as { agent_id?: string; transactions?: unknown[] };

  if (!agent_id || !Array.isArray(transactions)) {
    return c.json({ success: false, error: 'agent_id and transactions array required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const applied: string[] = [];
  const failed: string[] = [];

  for (const txn of transactions as Array<Record<string, unknown>>) {
    try {
      const id = (txn['id'] as string | undefined) ?? genId('txn');
      await db.prepare(
        `INSERT OR IGNORE INTO sales_transactions
         (id, agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method, payment_status, sync_status, created_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'synced', ?, ?)`
      ).bind(
        id, agent_id, txn['trip_id'],
        JSON.stringify(txn['seat_ids'] ?? []),
        JSON.stringify(txn['passenger_names'] ?? []),
        txn['total_amount'], txn['payment_method'],
        txn['created_at'] ?? now, now
      ).run();
      applied.push(id);
    } catch {
      failed.push(String(txn['id'] ?? 'unknown'));
    }
  }

  return c.json({ success: true, data: { applied, failed, synced_at: now } });
});

// ============================================================
// GET /dashboard — agent sales summary (STAFF+)
// ============================================================
agentSalesRouter.get('/dashboard', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const { agent_id } = c.req.query();
  const db = c.env.DB;
  const todayStart = new Date().setHours(0, 0, 0, 0);

  let statsQuery = `SELECT COUNT(*) as txn_count, COALESCE(SUM(total_amount), 0) as total_revenue
    FROM sales_transactions WHERE deleted_at IS NULL AND created_at >= ?`;
  const params: unknown[] = [todayStart];
  if (agent_id) { statsQuery += ` AND agent_id = ?`; params.push(agent_id); }

  try {
    const stats = await db.prepare(statsQuery).bind(...params).first<{ txn_count: number; total_revenue: number }>();
    return c.json({
      success: true,
      data: {
        today_transactions: stats?.txn_count ?? 0,
        today_revenue_kobo: stats?.total_revenue ?? 0,
      },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch dashboard' }, 500);
  }
});

// ============================================================
// P07-T4: GET /parks — list bus parks for operator (STAFF+)
// ============================================================
agentSalesRouter.get('/parks', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'SUPERVISOR']), async (c) => {
  const db = c.env.DB;
  const jwtUser = c.get('user');
  const isSuperAdmin = jwtUser?.role === 'SUPER_ADMIN';

  let query = `SELECT * FROM bus_parks WHERE deleted_at IS NULL`;
  const params: unknown[] = [];
  if (!isSuperAdmin && jwtUser?.operatorId) {
    query += ` AND operator_id = ?`;
    params.push(jwtUser.operatorId);
  }
  query += ` ORDER BY name ASC`;

  try {
    const result = await db.prepare(query).bind(...params).all<{
      id: string; operator_id: string; name: string; city: string; state: string;
      latitude: number | null; longitude: number | null; created_at: number;
    }>();
    return c.json({ success: true, data: result.results });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch bus parks' }, 500);
  }
});

// ============================================================
// P07-T4: POST /parks — create a bus park (TENANT_ADMIN+)
// ============================================================
agentSalesRouter.post('/parks', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['operator_id', 'name', 'city', 'state']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { operator_id, name, city, state, latitude, longitude } = body as {
    operator_id: string; name: string; city: string; state: string;
    latitude?: number | null; longitude?: number | null;
  };

  const db = c.env.DB;
  const id = genId('prk');
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT INTO bus_parks (id, operator_id, name, city, state, latitude, longitude, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, operator_id, name, city, state, latitude ?? null, longitude ?? null, now).run();

    return c.json({
      success: true,
      data: { id, operator_id, name, city, state, latitude: latitude ?? null, longitude: longitude ?? null, created_at: now },
    }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('UNIQUE')) return c.json({ success: false, error: 'Park already exists' }, 409);
    return c.json({ success: false, error: 'Failed to create bus park' }, 500);
  }
});

// ============================================================
// P07-T4: POST /parks/:id/agents — assign agent to park (SUPERVISOR+)
// ============================================================
agentSalesRouter.post('/parks/:id/agents', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR']), async (c) => {
  const parkId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['agent_id']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { agent_id } = body as { agent_id: string };
  const db = c.env.DB;

  try {
    // T4-7: Fetch park and agent together to validate cross-operator assignment
    const [park, agent] = await Promise.all([
      db.prepare(`SELECT id, operator_id FROM bus_parks WHERE id = ? AND deleted_at IS NULL`).bind(parkId).first<{ id: string; operator_id: string }>(),
      db.prepare(`SELECT id, operator_id FROM agents WHERE id = ? AND deleted_at IS NULL`).bind(agent_id).first<{ id: string; operator_id: string }>(),
    ]);
    if (!park) return c.json({ success: false, error: 'Bus park not found' }, 404);
    if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404);

    // T4-7: Agent and park must belong to the same operator
    if (agent.operator_id !== park.operator_id) {
      return c.json({ success: false, error: 'Agent and bus park must belong to the same operator' }, 403);
    }

    await db.prepare(
      `INSERT OR IGNORE INTO agent_bus_parks (agent_id, park_id) VALUES (?, ?)`
    ).bind(agent_id, parkId).run();

    return c.json({ success: true, data: { agent_id, park_id: parkId } }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to assign agent to park' }, 500);
  }
});

// ============================================================
// P07-T4: DELETE /parks/:id/agents/:agentId — unassign agent (SUPERVISOR+)
// ============================================================
agentSalesRouter.delete('/parks/:id/agents/:agentId', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR']), async (c) => {
  const parkId = c.req.param('id');
  const agentId = c.req.param('agentId');
  const db = c.env.DB;

  try {
    await db.prepare(
      `DELETE FROM agent_bus_parks WHERE agent_id = ? AND park_id = ?`
    ).bind(agentId, parkId).run();
    return c.json({ success: true, data: { agent_id: agentId, park_id: parkId, removed: true } });
  } catch {
    return c.json({ success: false, error: 'Failed to remove agent from park' }, 500);
  }
});

// ============================================================
// P07-T1: POST /reconciliation — submit end-of-day float (STAFF+)
// ============================================================
agentSalesRouter.post('/reconciliation', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['agent_id', 'operator_id', 'period_date', 'submitted_kobo']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { agent_id, operator_id, period_date, submitted_kobo, notes } = body as {
    agent_id: string; operator_id: string; period_date: string;
    submitted_kobo: number; notes?: string;
  };

  if (!Number.isInteger(submitted_kobo) || submitted_kobo < 0) {
    return c.json({ success: false, error: 'submitted_kobo must be a non-negative integer' }, 400);
  }

  // Validate ISO date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period_date)) {
    return c.json({ success: false, error: 'period_date must be YYYY-MM-DD' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  // Prevent duplicate reconciliation for same agent+date
  const existing = await db.prepare(
    `SELECT id FROM float_reconciliation WHERE agent_id = ? AND period_date = ?`
  ).bind(agent_id, period_date).first<{ id: string }>();
  if (existing) {
    return c.json({ success: false, error: 'Reconciliation already submitted for this date' }, 409);
  }

  // Calculate expected: sum all completed transactions for agent on period_date
  const dateStart = new Date(`${period_date}T00:00:00.000Z`).getTime();
  const dateEnd = new Date(`${period_date}T23:59:59.999Z`).getTime();
  const expectedRow = await db.prepare(
    `SELECT COALESCE(SUM(total_amount), 0) AS expected FROM sales_transactions
     WHERE agent_id = ? AND payment_status = 'completed' AND payment_method = 'cash'
       AND created_at >= ? AND created_at <= ? AND deleted_at IS NULL`
  ).bind(agent_id, dateStart, dateEnd).first<{ expected: number }>();

  const expected_kobo = expectedRow?.expected ?? 0;
  // discrepancy = expected - submitted:
  //   positive  → agent submitted LESS cash than expected (shortage)
  //   negative  → agent submitted MORE cash than expected (overage)
  const discrepancy_kobo = expected_kobo - submitted_kobo;

  const id = genId('rec');
  try {
    await db.prepare(
      `INSERT INTO float_reconciliation
       (id, agent_id, operator_id, period_date, expected_kobo, submitted_kobo, discrepancy_kobo, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(id, agent_id, operator_id, period_date, expected_kobo, submitted_kobo, discrepancy_kobo, notes ?? null, now).run();

    // T1-6: Publish reconciliation event (non-fatal)
    try {
      await publishEvent(db, {
        event_type: 'agent.reconciliation.filed',
        aggregate_id: id,
        aggregate_type: 'float_reconciliation',
        payload: { reconciliation_id: id, agent_id, operator_id, period_date, expected_kobo, submitted_kobo, discrepancy_kobo },
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    return c.json({
      success: true,
      data: { id, agent_id, operator_id, period_date, expected_kobo, submitted_kobo, discrepancy_kobo, status: 'pending' },
    }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to submit reconciliation' }, 500);
  }
});

// ============================================================
// P07-T1: GET /reconciliation — list float reconciliations
// STAFF (agents) see only their own; SUPERVISOR+ see all for operator
// ============================================================
agentSalesRouter.get('/reconciliation', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR', 'STAFF']), async (c) => {
  const q = c.req.query();
  const { agent_id, status, period_date } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;
  const jwtUser = c.get('user');
  const isSuperAdmin = jwtUser?.role === 'SUPER_ADMIN';
  const isAgent = jwtUser?.role === 'STAFF';

  let query = `SELECT * FROM float_reconciliation WHERE 1=1`;
  const params: unknown[] = [];

  // Tenant scope: non-SUPER_ADMIN scoped to operator
  if (!isSuperAdmin && jwtUser?.operatorId) { query += ` AND operator_id = ?`; params.push(jwtUser.operatorId); }

  // Agent (STAFF) role: force-scope to their own records only
  if (isAgent) {
    query += ` AND agent_id = ?`;
    params.push(jwtUser?.id ?? '');
  } else if (agent_id) {
    // Supervisors can filter by a specific agent
    query += ` AND agent_id = ?`;
    params.push(agent_id);
  }

  if (status) { query += ` AND status = ?`; params.push(status); }
  if (period_date) { query += ` AND period_date = ?`; params.push(period_date); }
  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...params).all<{
      id: string; agent_id: string; operator_id: string; period_date: string;
      expected_kobo: number; submitted_kobo: number; discrepancy_kobo: number;
      status: string; reviewed_by: string | null; reviewed_at: number | null; notes: string | null; created_at: number;
    }>();
    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch reconciliations' }, 500);
  }
});

// ============================================================
// P07-T1: PATCH /reconciliation/:id — approve / reject (SUPERVISOR+)
// ============================================================
agentSalesRouter.patch('/reconciliation/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const { status, notes } = body as { status?: string; notes?: string };

  if (!status || !['approved', 'disputed'].includes(status)) {
    return c.json({ success: false, error: 'status must be approved or disputed' }, 400);
  }

  const db = c.env.DB;
  const jwtUser = c.get('user');
  const now = Date.now();

  try {
    const rec = await db.prepare(`SELECT * FROM float_reconciliation WHERE id = ?`).bind(id).first<{ id: string; status: string; operator_id: string }>();
    if (!rec) return c.json({ success: false, error: 'Reconciliation not found' }, 404);
    if (rec.status !== 'pending') return c.json({ success: false, error: `Cannot update reconciliation with status '${rec.status}'` }, 409);
    if (jwtUser?.role !== 'SUPER_ADMIN' && jwtUser?.operatorId && rec.operator_id !== jwtUser.operatorId) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    await db.prepare(
      `UPDATE float_reconciliation SET status = ?, reviewed_by = ?, reviewed_at = ?, notes = COALESCE(?, notes) WHERE id = ?`
    ).bind(status, jwtUser?.id ?? 'system', now, notes ?? null, id).run();

    return c.json({ success: true, data: { id, status, reviewed_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to update reconciliation' }, 500);
  }
});

// ============================================================
// P08-T5: POST /group-bookings — create a group booking (STAFF+)
// Creates booking + group_bookings + sales_transaction + receipt atomically.
// seat_ids.length must be in [2, 50]; returns 422 if insufficient seats available.
// ============================================================
agentSalesRouter.post('/group-bookings', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const missing = requireFields(body, ['trip_id', 'agent_id', 'group_name', 'leader_name', 'leader_phone', 'seat_ids', 'passenger_names', 'payment_method']);
  if (missing) return c.json({ success: false, error: missing }, 400);

  const {
    trip_id, agent_id, group_name, leader_name, leader_phone,
    seat_ids, passenger_names, seat_class, payment_method, total_amount_kobo,
  } = body as {
    trip_id: string; agent_id: string; group_name: string;
    leader_name: string; leader_phone: string;
    seat_ids: string[]; passenger_names: string[];
    seat_class?: string; payment_method: string; total_amount_kobo?: number;
  };

  if (!Array.isArray(seat_ids) || seat_ids.length < 2 || seat_ids.length > 50) {
    return c.json({ success: false, error: 'seat_ids must be an array of 2–50 seats' }, 400);
  }
  if (!Array.isArray(passenger_names) || passenger_names.length !== seat_ids.length) {
    return c.json({ success: false, error: 'passenger_names must have one entry per seat_id' }, 400);
  }
  const VALID_CLASSES = ['standard', 'window', 'vip', 'front'];
  const effectiveSeatClass = seat_class ?? 'standard';
  if (!VALID_CLASSES.includes(effectiveSeatClass)) {
    return c.json({ success: false, error: `seat_class must be one of: ${VALID_CLASSES.join(', ')}` }, 400);
  }

  const db = c.env.DB;
  const jwtUser = c.get('user');
  const now = Date.now();

  try {
    const trip = await db.prepare(
      `SELECT t.id, t.state, t.operator_id, t.departure_time, r.base_fare, r.fare_matrix
       FROM trips t JOIN routes r ON t.route_id = r.id WHERE t.id = ? AND t.deleted_at IS NULL`
    ).bind(trip_id).first<{ id: string; state: string; operator_id: string; departure_time: number; base_fare: number; fare_matrix: string | null }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);
    if (!['scheduled', 'boarding'].includes(trip.state)) {
      return c.json({ success: false, error: `Cannot book on a trip in '${trip.state}' state` }, 409);
    }

    // Verify all requested seats exist, belong to this trip, and are available
    const placeholders = seat_ids.map(() => '?').join(',');
    const seatRows = await db.prepare(
      `SELECT id, seat_number, seat_class, status FROM seats WHERE id IN (${placeholders}) AND trip_id = ?`
    ).bind(...seat_ids, trip_id).all<{ id: string; seat_number: string; seat_class: string; status: string }>();

    const availableSeats = seatRows.results.filter(s => s.status === 'available');
    if (availableSeats.length < seat_ids.length) {
      return c.json({
        success: false,
        error: 'One or more requested seats are not available',
        available_count: availableSeats.length,
        requested_count: seat_ids.length,
      }, 422);
    }

    // Compute expected fare and validate submitted amount within ±2%
    const fareMatrix: GrpFareMatrix | null = trip.fare_matrix ? JSON.parse(trip.fare_matrix) as GrpFareMatrix : null;
    const fareByClass = grpComputeFareByClass(trip.base_fare, fareMatrix, trip.departure_time);
    const perSeatFare = fareByClass[effectiveSeatClass] ?? trip.base_fare;
    const expected_kobo = perSeatFare * seat_ids.length;

    if (total_amount_kobo !== undefined) {
      const tolerance = Math.round(expected_kobo * 0.02);
      if (Math.abs(total_amount_kobo - expected_kobo) > tolerance) {
        return c.json({ success: false, error: 'fare_mismatch', expected_kobo, submitted_kobo: total_amount_kobo }, 422);
      }
    }
    const total_amount = total_amount_kobo ?? expected_kobo;

    const booking_id = genId('bkg');
    const group_id = genId('grp');
    const txn_id = genId('txn');
    const receipt_id = genId('rct');
    const payment_reference = `waka_grp_${txn_id.slice(-12)}`;
    const qrCode = `${txn_id}:${seat_ids.join(',')}`;
    const seatNumbers = seatRows.results.map(s => s.seat_number);

    await db.batch([
      // 1. Master booking record
      db.prepare(
        `INSERT INTO bookings (id, customer_id, trip_id, seat_ids, passenger_names, total_amount, status, payment_status, payment_method, payment_reference, group_booking_id, is_guest, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, 'confirmed', 'completed', ?, ?, ?, 0, ?)`
      ).bind(booking_id, trip_id, JSON.stringify(seat_ids), JSON.stringify(passenger_names), total_amount, payment_method, payment_reference, group_id, now),

      // 2. Group booking metadata
      db.prepare(
        `INSERT INTO group_bookings (id, operator_id, agent_id, trip_id, booking_id, group_name, leader_name, leader_phone, seat_count, seat_class, total_amount_kobo, payment_method, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(group_id, trip.operator_id, agent_id ?? jwtUser?.id ?? 'unknown', trip_id, booking_id, group_name, leader_name, leader_phone, seat_ids.length, effectiveSeatClass, total_amount, payment_method, now),

      // 3. Sales transaction (POS record)
      db.prepare(
        `INSERT INTO sales_transactions (id, agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method, payment_status, sync_status, receipt_id, passenger_id_type, passenger_id_hash, park_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'synced', ?, NULL, NULL, NULL, ?)`
      ).bind(txn_id, agent_id ?? jwtUser?.id ?? 'unknown', trip_id, JSON.stringify(seat_ids), JSON.stringify(passenger_names), total_amount, payment_method, receipt_id, now),

      // 4. Receipt with QR code
      db.prepare(
        `INSERT INTO receipts (id, transaction_id, agent_id, trip_id, passenger_names, seat_numbers, total_amount, payment_method, qr_code, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(receipt_id, txn_id, agent_id ?? jwtUser?.id ?? 'unknown', trip_id, JSON.stringify(passenger_names), JSON.stringify(seatNumbers), total_amount, payment_method, qrCode, now),

      // 5. Confirm all seats atomically
      ...seat_ids.map(seatId =>
        db.prepare(
          `UPDATE seats SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`
        ).bind(booking_id, now, now, seatId)
      ),
    ]);

    try {
      await publishEvent(db, {
        event_type: 'agent.group_booking.completed',
        aggregate_id: group_id,
        aggregate_type: 'group_bookings',
        payload: { group_id, booking_id, txn_id, receipt_id, trip_id, seat_count: seat_ids.length, total_amount, payment_method },
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    return c.json({
      success: true,
      data: {
        group_booking_id: group_id,
        booking_id,
        transaction_id: txn_id,
        receipt_id,
        trip_id,
        seat_count: seat_ids.length,
        seat_numbers: seatNumbers,
        total_amount,
        per_seat_fare: perSeatFare,
        payment_method,
        payment_reference,
        qr_code: qrCode,
      },
    }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to create group booking' }, 500);
  }
});

// ============================================================
// P08-T5: GET /group-bookings/:id — fetch group booking details (STAFF+)
// ============================================================
agentSalesRouter.get('/group-bookings/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  try {
    const group = await db.prepare(
      `SELECT gb.*, b.status AS booking_status, b.seat_ids, b.passenger_names,
              b.payment_status, b.payment_reference, b.total_amount,
              r.id AS receipt_id, r.qr_code, r.seat_numbers, r.issued_at
       FROM group_bookings gb
       JOIN bookings b ON gb.booking_id = b.id
       LEFT JOIN receipts r ON r.transaction_id = (
         SELECT id FROM sales_transactions WHERE trip_id = gb.trip_id AND seat_ids = b.seat_ids LIMIT 1
       )
       WHERE gb.id = ?`
    ).bind(id).first();
    if (!group) return c.json({ success: false, error: 'Group booking not found' }, 404);
    return c.json({ success: true, data: group });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch group booking' }, 500);
  }
});
