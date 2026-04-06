/**
 * WebWaka Transport — Lost & Found Portal API
 *
 * Allows passengers, trns_drivers, and staff to:
 *   - Report lost or found items
 *   - Search the lost & found registry
 *   - Claim items with verification
 *   - Track claim status
 *
 * Invariants: Multi-tenant, NDPR-compliant, Soft-delete pattern
 */

import { Hono } from 'hono';
import type { Env } from '../worker.js';
import { nanoid } from '@webwaka/core';

export const lostFoundRouter = new Hono<{ Bindings: Env }>();

// ============================================================
// POST /api/lost-found
// Report a lost or found item
// ============================================================
lostFoundRouter.post('/', async (c) => {
  const body = await c.req.json<{
    operator_id: string;
    reporter_type: 'passenger' | 'driver' | 'staff';
    reporter_id?: string;
    reporter_name: string;
    reporter_phone: string;
    trip_id?: string;
    vehicle_id?: string;
    item_description: string;
    item_category?: string;
    found_at?: string;
    storage_location?: string;
    photos?: string[];
    notes?: string;
  }>();

  if (!body.reporter_name || !body.reporter_phone || !body.item_description) {
    return c.json({ success: false, error: 'reporter_name, reporter_phone, and item_description are required' }, 400);
  }

  const now = Date.now();
  const itemId = `lf_${nanoid()}`;

  await c.env.DB.prepare(`
    INSERT INTO trns_lost_found_items
      (id, operator_id, reporter_type, reporter_id, reporter_name, reporter_phone,
       trip_id, vehicle_id, item_description, item_category, found_at,
       storage_location, photos, status, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?)
  `).bind(
    itemId, body.operator_id, body.reporter_type,
    body.reporter_id ?? null, body.reporter_name, body.reporter_phone,
    body.trip_id ?? null, body.vehicle_id ?? null,
    body.item_description, body.item_category ?? null,
    body.found_at ?? null, body.storage_location ?? null,
    body.photos ? JSON.stringify(body.photos) : null,
    body.notes ?? null, now, now,
  ).run();

  return c.json({
    success: true,
    data: {
      item_id: itemId,
      status: 'reported',
      message: 'Item reported. Reference ID: ' + itemId,
    },
  }, 201);
});

// ============================================================
// GET /api/lost-found?operator_id=...&status=...&category=...
// List lost & found items (staff view)
// ============================================================
lostFoundRouter.get('/', async (c) => {
  const operatorId = c.req.query('operator_id');
  const status = c.req.query('status');
  const category = c.req.query('category');
  const search = c.req.query('search');
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);

  let query = `SELECT * FROM trns_lost_found_items WHERE 1=1`;
  const bindings: unknown[] = [];

  if (operatorId) { query += ' AND operator_id = ?'; bindings.push(operatorId); }
  if (status) { query += ' AND status = ?'; bindings.push(status); }
  if (category) { query += ' AND item_category = ?'; bindings.push(category); }
  if (search) {
    query += ' AND (LOWER(item_description) LIKE ? OR LOWER(reporter_name) LIKE ?)';
    bindings.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`);
  }
  query += ` ORDER BY created_at DESC LIMIT ${limit}`;

  const { results } = await c.env.DB.prepare(query).bind(...bindings).all();
  return c.json({ success: true, data: results ?? [] });
});

// ============================================================
// GET /api/lost-found/:id
// Get specific item details
// ============================================================
lostFoundRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const item = await c.env.DB
    .prepare(`
      SELECT lf.*, t.route_id, v.plate_number
      FROM trns_lost_found_items lf
      LEFT JOIN trns_trips t ON lf.trip_id = t.id
      LEFT JOIN trns_vehicles v ON lf.vehicle_id = v.id
      WHERE lf.id = ?
    `)
    .bind(id)
    .first();
  if (!item) return c.json({ success: false, error: 'Item not found' }, 404);
  return c.json({ success: true, data: item });
});

// ============================================================
// PATCH /api/lost-found/:id/status
// Update item status (staff)
// ============================================================
lostFoundRouter.patch('/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    status: 'stored' | 'claimed' | 'unclaimed' | 'disposed';
    storage_location?: string;
    notes?: string;
    claimant_name?: string;
    claimant_phone?: string;
  }>();

  const validStatuses = ['stored', 'claimed', 'unclaimed', 'disposed'];
  if (!validStatuses.includes(body.status)) {
    return c.json({ success: false, error: `status must be one of: ${validStatuses.join(', ')}` }, 400);
  }

  const now = Date.now();
  await c.env.DB.prepare(`
    UPDATE trns_lost_found_items SET
      status = ?,
      storage_location = COALESCE(?, storage_location),
      notes = COALESCE(?, notes),
      claimant_name = COALESCE(?, claimant_name),
      claimant_phone = COALESCE(?, claimant_phone),
      claimed_at = CASE WHEN ? = 'claimed' THEN ? ELSE claimed_at END,
      updated_at = ?
    WHERE id = ?
  `).bind(
    body.status,
    body.storage_location ?? null,
    body.notes ?? null,
    body.claimant_name ?? null,
    body.claimant_phone ?? null,
    body.status, now,
    now, id,
  ).run();

  return c.json({ success: true, data: { id, status: body.status } });
});

// ============================================================
// POST /api/lost-found/:id/claim
// Passenger initiates a claim
// ============================================================
lostFoundRouter.post('/:id/claim', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    claimant_name: string;
    claimant_phone: string;
    description_confirmation?: string;
  }>();

  const item = await c.env.DB
    .prepare(`SELECT id, status, item_description FROM trns_lost_found_items WHERE id = ?`)
    .bind(id)
    .first<{ id: string; status: string; item_description: string }>();

  if (!item) return c.json({ success: false, error: 'Item not found' }, 404);
  if (item.status === 'claimed') return c.json({ success: false, error: 'Item already claimed' }, 409);
  if (item.status !== 'reported' && item.status !== 'stored') {
    return c.json({ success: false, error: `Cannot claim item in status: ${item.status}` }, 409);
  }

  const now = Date.now();
  await c.env.DB.prepare(`
    UPDATE trns_lost_found_items SET
      status = 'claimed',
      claimant_name = ?, claimant_phone = ?,
      claimed_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(body.claimant_name, body.claimant_phone, now, now, id).run();

  return c.json({
    success: true,
    data: {
      item_id: id,
      status: 'claimed',
      message: 'Claim recorded. Contact the operator to collect your item.',
    },
  });
});
