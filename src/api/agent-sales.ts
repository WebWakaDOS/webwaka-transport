/**
 * TRN-2: Agent Sales API (Offline-First Bus Park POS)
 * Invariants: Offline-First (sync queue), Nigeria-First (kobo/cash), Multi-tenancy
 * Security: JWT auth via global middleware in worker.ts; per-route RBAC via requireRole
 */
import { Hono } from 'hono';
import { requireRole } from '@webwaka/core';
import type { AppContext, DbAgent, DbSalesTransaction, DbReceipt } from './types';
import { genId, parsePagination, metaResponse, requireFields, applyTenantScope } from './types';

export const agentSalesRouter = new Hono<AppContext>();

// ============================================================
// GET /agents — list agents
// ============================================================
agentSalesRouter.get('/agents', async (c) => {
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

  const { agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method } = body as {
    agent_id: string; trip_id: string; seat_ids: string[]; passenger_names: string[];
    total_amount: number; payment_method: string;
  };

  if (!Number.isInteger(total_amount) || total_amount <= 0) {
    return c.json({ success: false, error: 'total_amount must be a positive integer (kobo)' }, 400);
  }
  if (!Array.isArray(seat_ids) || seat_ids.length === 0) {
    return c.json({ success: false, error: 'seat_ids must be a non-empty array' }, 400);
  }

  const db = c.env.DB;
  const id = genId('txn');
  const receiptId = genId('rct');
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT INTO sales_transactions (id, agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method, payment_status, sync_status, receipt_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'synced', ?, ?)`
    ).bind(id, agent_id, trip_id, JSON.stringify(seat_ids), JSON.stringify(passenger_names), total_amount, payment_method, receiptId, now).run();

    await db.prepare(
      `INSERT INTO receipts (id, transaction_id, agent_id, trip_id, passenger_names, seat_numbers, total_amount, payment_method, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(receiptId, id, agent_id, trip_id, JSON.stringify(passenger_names), JSON.stringify(seat_ids), total_amount, payment_method, now).run();

    return c.json({
      success: true,
      data: { id, agent_id, trip_id, total_amount, payment_method, payment_status: 'completed', receipt_id: receiptId },
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
// GET /receipts/:id — get a receipt
// ============================================================
agentSalesRouter.get('/receipts/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  try {
    const receipt = await db.prepare(`SELECT * FROM receipts WHERE id = ?`).bind(id).first<DbReceipt>();
    if (!receipt) return c.json({ success: false, error: 'Receipt not found' }, 404);
    return c.json({ success: true, data: receipt });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch receipt' }, 500);
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
