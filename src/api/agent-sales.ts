/**
 * TRN-2: Agent Sales API (Offline-First Bus Park POS)
 * Invariants: Offline-First (sync queue), Nigeria-First (kobo/cash), Multi-tenancy
 */
import { Hono } from 'hono';
import type { Env } from './seat-inventory';

export const agentSalesRouter = new Hono<{ Bindings: Env }>();

// GET /agents — list agents
agentSalesRouter.get('/agents', async (c) => {
  const { operator_id, status } = c.req.query();
  const db = c.env.DB;

  let query = `SELECT * FROM agents WHERE deleted_at IS NULL`;
  const params: unknown[] = [];
  if (operator_id) { query += ` AND operator_id = ?`; params.push(operator_id); }
  if (status) { query += ` AND status = ?`; params.push(status); }
  query += ` ORDER BY created_at DESC`;

  const result = await db.prepare(query).bind(...params).all();
  return c.json({ success: true, data: result.results });
});

// POST /agents — register an agent
agentSalesRouter.post('/agents', async (c) => {
  const body = await c.req.json() as any;
  const { operator_id, name, phone, email, role, bus_parks } = body;

  if (!operator_id || !name || !phone) {
    return c.json({ success: false, error: 'operator_id, name, phone required' }, 400);
  }

  const db = c.env.DB;
  const id = `agt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();

  await db.prepare(
    `INSERT INTO agents (id, operator_id, name, phone, email, role, bus_parks, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).bind(id, operator_id, name, phone, email ?? null, role ?? 'agent', JSON.stringify(bus_parks ?? []), now, now).run();

  return c.json({ success: true, data: { id, operator_id, name, phone, role: role ?? 'agent', status: 'active' } }, 201);
});

// POST /transactions — record a sale (online or offline sync)
agentSalesRouter.post('/transactions', async (c) => {
  const body = await c.req.json() as any;
  const { agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method } = body;

  if (!agent_id || !trip_id || !seat_ids || !passenger_names || !total_amount || !payment_method) {
    return c.json({ success: false, error: 'agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method required' }, 400);
  }

  if (!Number.isInteger(total_amount) || total_amount <= 0) {
    return c.json({ success: false, error: 'total_amount must be a positive integer (kobo)' }, 400);
  }

  const db = c.env.DB;
  const id = `txn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const receiptId = `rct_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();

  await db.prepare(
    `INSERT INTO sales_transactions (id, agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method, payment_status, sync_status, receipt_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'synced', ?, ?)`
  ).bind(id, agent_id, trip_id, JSON.stringify(seat_ids), JSON.stringify(passenger_names), total_amount, payment_method, receiptId, now).run();

  // Generate receipt
  await db.prepare(
    `INSERT INTO receipts (id, transaction_id, agent_id, trip_id, passenger_names, seat_numbers, total_amount, payment_method, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(receiptId, id, agent_id, trip_id, JSON.stringify(passenger_names), JSON.stringify(seat_ids), total_amount, payment_method, now).run();

  return c.json({
    success: true,
    data: {
      id, agent_id, trip_id, total_amount, payment_method,
      payment_status: 'completed', receipt_id: receiptId,
    },
  }, 201);
});

// GET /transactions — list transactions for an agent
agentSalesRouter.get('/transactions', async (c) => {
  const { agent_id, trip_id, sync_status } = c.req.query();
  const db = c.env.DB;

  let query = `SELECT * FROM sales_transactions WHERE deleted_at IS NULL`;
  const params: unknown[] = [];
  if (agent_id) { query += ` AND agent_id = ?`; params.push(agent_id); }
  if (trip_id) { query += ` AND trip_id = ?`; params.push(trip_id); }
  if (sync_status) { query += ` AND sync_status = ?`; params.push(sync_status); }
  query += ` ORDER BY created_at DESC LIMIT 100`;

  const result = await db.prepare(query).bind(...params).all();
  return c.json({ success: true, data: result.results });
});

// GET /receipts/:id — get a receipt
agentSalesRouter.get('/receipts/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const receipt = await db.prepare(`SELECT * FROM receipts WHERE id = ?`).bind(id).first();
  if (!receipt) return c.json({ success: false, error: 'Receipt not found' }, 404);
  return c.json({ success: true, data: receipt });
});

// POST /sync — offline-first batch sync for agent transactions
agentSalesRouter.post('/sync', async (c) => {
  const body = await c.req.json() as any;
  const { agent_id, transactions } = body;

  if (!agent_id || !Array.isArray(transactions)) {
    return c.json({ success: false, error: 'agent_id and transactions array required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const applied: string[] = [];
  const failed: string[] = [];

  for (const txn of transactions) {
    try {
      const id = txn.id ?? `txn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      await db.prepare(
        `INSERT OR IGNORE INTO sales_transactions
         (id, agent_id, trip_id, seat_ids, passenger_names, total_amount, payment_method, payment_status, sync_status, created_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'synced', ?, ?)`
      ).bind(
        id, agent_id, txn.trip_id,
        JSON.stringify(txn.seat_ids ?? []),
        JSON.stringify(txn.passenger_names ?? []),
        txn.total_amount, txn.payment_method,
        txn.created_at ?? now, now
      ).run();
      applied.push(id);
    } catch {
      failed.push(txn.id ?? 'unknown');
    }
  }

  return c.json({ success: true, data: { applied, failed, synced_at: now } });
});

// GET /dashboard — agent sales summary
agentSalesRouter.get('/dashboard', async (c) => {
  const { agent_id } = c.req.query();
  const db = c.env.DB;
  const todayStart = new Date().setHours(0, 0, 0, 0);

  let statsQuery = `SELECT COUNT(*) as txn_count, COALESCE(SUM(total_amount), 0) as total_revenue
    FROM sales_transactions WHERE deleted_at IS NULL AND created_at >= ?`;
  const params: unknown[] = [todayStart];
  if (agent_id) { statsQuery += ` AND agent_id = ?`; params.push(agent_id); }

  const stats = await db.prepare(statsQuery).bind(...params).first() as any;

  return c.json({
    success: true,
    data: {
      today_transactions: stats?.txn_count ?? 0,
      today_revenue_kobo: stats?.total_revenue ?? 0,
    },
  });
});
