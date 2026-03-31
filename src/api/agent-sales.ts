/**
 * TRN-2: Agent Sales API (Offline-First Bus Park POS)
 * Invariants: Offline-First (sync queue), Nigeria-First (kobo/cash), Multi-tenancy
 * Security: JWT auth via global middleware in worker.ts; per-route RBAC via requireRole
 */
import { Hono } from 'hono';
import { requireRole, publishEvent } from '@webwaka/core';
import type { AppContext, DbAgent, DbSalesTransaction, DbReceipt } from './types';
import { genId, parsePagination, metaResponse, requireFields, applyTenantScope } from './types';

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
    passenger_id_type, passenger_id_number,
  } = body as {
    agent_id: string; trip_id: string; seat_ids: string[]; passenger_names: string[];
    total_amount: number; payment_method: string;
    passenger_id_type?: string | null; passenger_id_number?: string | null;
  };

  if (!Number.isInteger(total_amount) || total_amount <= 0) {
    return c.json({ success: false, error: 'total_amount must be a positive integer (kobo)' }, 400);
  }
  if (!Array.isArray(seat_ids) || seat_ids.length === 0) {
    return c.json({ success: false, error: 'seat_ids must be a non-empty array' }, 400);
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
        `INSERT INTO sales_transactions (id, agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method, payment_status, sync_status, receipt_id, passenger_id_type, passenger_id_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'synced', ?, ?, ?, ?)`
      ).bind(id, agent_id, trip_id, JSON.stringify(seat_ids), JSON.stringify(passenger_names), total_amount, payment_method, receiptId, passenger_id_type ?? null, passenger_id_hash, now),
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
  const { agent_id, trip_id, sync_status } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  let query = `SELECT st.* FROM sales_transactions st
    JOIN agents a ON st.agent_id = a.id
    WHERE st.deleted_at IS NULL`;
  const params: unknown[] = [];

  const scoped = applyTenantScope(c, query, params, 'a.');
  query = scoped.query;
  params.splice(0, params.length, ...scoped.params);

  if (agent_id) { query += ` AND st.agent_id = ?`; params.push(agent_id); }
  if (trip_id) { query += ` AND st.trip_id = ?`; params.push(trip_id); }
  if (sync_status) { query += ` AND st.sync_status = ?`; params.push(sync_status); }
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
    const park = await db.prepare(`SELECT id FROM bus_parks WHERE id = ? AND deleted_at IS NULL`).bind(parkId).first<{ id: string }>();
    if (!park) return c.json({ success: false, error: 'Bus park not found' }, 404);

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
  const discrepancy_kobo = submitted_kobo - expected_kobo;

  const id = genId('rec');
  try {
    await db.prepare(
      `INSERT INTO float_reconciliation
       (id, agent_id, operator_id, period_date, expected_kobo, submitted_kobo, discrepancy_kobo, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(id, agent_id, operator_id, period_date, expected_kobo, submitted_kobo, discrepancy_kobo, notes ?? null, now).run();

    return c.json({
      success: true,
      data: { id, agent_id, operator_id, period_date, expected_kobo, submitted_kobo, discrepancy_kobo, status: 'pending' },
    }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to submit reconciliation' }, 500);
  }
});

// ============================================================
// P07-T1: GET /reconciliation — list float reconciliations (SUPERVISOR+)
// ============================================================
agentSalesRouter.get('/reconciliation', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR']), async (c) => {
  const q = c.req.query();
  const { agent_id, status, period_date } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;
  const jwtUser = c.get('user');
  const isSuperAdmin = jwtUser?.role === 'SUPER_ADMIN';

  let query = `SELECT * FROM float_reconciliation WHERE 1=1`;
  const params: unknown[] = [];
  if (!isSuperAdmin && jwtUser?.operatorId) { query += ` AND operator_id = ?`; params.push(jwtUser.operatorId); }
  if (agent_id) { query += ` AND agent_id = ?`; params.push(agent_id); }
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

  if (!status || !['approved', 'rejected'].includes(status)) {
    return c.json({ success: false, error: 'status must be approved or rejected' }, 400);
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
