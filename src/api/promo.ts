/**
 * WebWaka Transport — Promo Code Engine API
 *
 * Supports:
 *   - Percentage discount codes (e.g., 20% off)
 *   - Flat-rate discount codes (e.g., ₦500 off)
 *   - Usage limits, expiry, min fare requirements
 *   - Audit trail via trns_promo_code_uses table
 *
 * Invariants: Nigeria-First (kobo), Multi-tenant, Idempotent validation
 */

import { Hono } from 'hono';
import type { Env } from '../worker.js';
import { nanoid } from '@webwaka/core';

export const promoRouter = new Hono<{ Bindings: Env }>();

// ============================================================
// POST /api/promo/validate
// Validate a promo code and calculate discount (read-only, no usage increment)
// ============================================================
promoRouter.post('/validate', async (c) => {
  const body = await c.req.json<{
    code: string;
    fare_kobo: number;
    customer_id?: string;
    operator_id?: string;
  }>();

  if (!body.code || !body.fare_kobo) {
    return c.json({ success: false, error: 'code and fare_kobo required' }, 400);
  }

  const now = Date.now();
  const promo = await c.env.DB
    .prepare(`
      SELECT id, discount_type, discount_value, max_discount_kobo, min_fare_kobo, max_uses, used_count
      FROM trns_promo_codes
      WHERE code = ? AND is_active = 1
        AND valid_from <= ? AND valid_until >= ?
        AND deleted_at IS NULL
        AND (operator_id IS NULL OR operator_id = ?)
    `)
    .bind(body.code, now, now, body.operator_id ?? null)
    .first<{
      id: string;
      discount_type: 'percentage' | 'flat';
      discount_value: number;
      max_discount_kobo: number | null;
      min_fare_kobo: number;
      max_uses: number | null;
      used_count: number;
    }>();

  if (!promo) {
    return c.json({ success: false, error: 'Invalid, expired, or inactive promo code' }, 404);
  }

  if (promo.max_uses !== null && promo.used_count >= promo.max_uses) {
    return c.json({ success: false, error: 'Promo code has reached its usage limit' }, 409);
  }

  if (body.fare_kobo < promo.min_fare_kobo) {
    return c.json({
      success: false,
      error: `Minimum fare of ₦${Math.round(promo.min_fare_kobo / 100).toLocaleString('en-NG')} required for this promo`,
    }, 400);
  }

  // Calculate discount
  let discountKobo = 0;
  if (promo.discount_type === 'percentage') {
    discountKobo = Math.round(body.fare_kobo * promo.discount_value / 100);
  } else {
    discountKobo = promo.discount_value;
  }

  if (promo.max_discount_kobo !== null) {
    discountKobo = Math.min(discountKobo, promo.max_discount_kobo);
  }

  discountKobo = Math.min(discountKobo, body.fare_kobo); // can't discount more than the fare

  return c.json({
    success: true,
    data: {
      promo_code_id: promo.id,
      code: body.code,
      discount_type: promo.discount_type,
      discount_value: promo.discount_value,
      discount_kobo: discountKobo,
      final_fare_kobo: body.fare_kobo - discountKobo,
    },
  });
});

// ============================================================
// POST /api/promo/apply
// Apply a promo code (increments usage count)
// ============================================================
promoRouter.post('/apply', async (c) => {
  const body = await c.req.json<{
    code: string;
    fare_kobo: number;
    customer_id?: string;
    booking_id?: string;
    ride_request_id?: string;
    operator_id?: string;
  }>();

  const now = Date.now();

  // Re-validate before applying
  const promo = await c.env.DB
    .prepare(`
      SELECT id, discount_type, discount_value, max_discount_kobo, min_fare_kobo, max_uses, used_count
      FROM trns_promo_codes
      WHERE code = ? AND is_active = 1
        AND valid_from <= ? AND valid_until >= ?
        AND deleted_at IS NULL
        AND (operator_id IS NULL OR operator_id = ?)
    `)
    .bind(body.code, now, now, body.operator_id ?? null)
    .first<{
      id: string;
      discount_type: 'percentage' | 'flat';
      discount_value: number;
      max_discount_kobo: number | null;
      min_fare_kobo: number;
      max_uses: number | null;
      used_count: number;
    }>();

  if (!promo || (promo.max_uses !== null && promo.used_count >= promo.max_uses)) {
    return c.json({ success: false, error: 'Promo code is no longer valid' }, 409);
  }

  let discountKobo = 0;
  if (promo.discount_type === 'percentage') {
    discountKobo = Math.round(body.fare_kobo * promo.discount_value / 100);
  } else {
    discountKobo = promo.discount_value;
  }
  if (promo.max_discount_kobo !== null) discountKobo = Math.min(discountKobo, promo.max_discount_kobo);
  discountKobo = Math.min(discountKobo, body.fare_kobo);

  // Increment usage + record use
  const useId = `puse_${nanoid()}`;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE trns_promo_codes SET used_count = used_count + 1 WHERE id = ?`).bind(promo.id),
    c.env.DB.prepare(`
      INSERT INTO trns_promo_code_uses (id, promo_code_id, customer_id, booking_id, ride_request_id, discount_applied_kobo, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(useId, promo.id, body.customer_id ?? null, body.booking_id ?? null, body.ride_request_id ?? null, discountKobo, now),
  ]);

  return c.json({
    success: true,
    data: {
      use_id: useId,
      discount_kobo: discountKobo,
      final_fare_kobo: body.fare_kobo - discountKobo,
    },
  }, 201);
});

// ============================================================
// POST /api/promo/codes
// Create a new promo code (operator/admin)
// ============================================================
promoRouter.post('/codes', async (c) => {
  const body = await c.req.json<{
    code: string;
    description?: string;
    discount_type: 'percentage' | 'flat';
    discount_value: number;
    max_uses?: number;
    min_fare_kobo?: number;
    max_discount_kobo?: number;
    valid_from: number;
    valid_until: number;
    operator_id?: string;
    created_by: string;
  }>();

  if (!body.code || !body.discount_type || !body.discount_value || !body.valid_from || !body.valid_until) {
    return c.json({ success: false, error: 'code, discount_type, discount_value, valid_from, valid_until required' }, 400);
  }
  if (body.discount_type === 'percentage' && (body.discount_value <= 0 || body.discount_value > 100)) {
    return c.json({ success: false, error: 'Percentage discount must be between 1 and 100' }, 400);
  }
  if (body.valid_until <= body.valid_from) {
    return c.json({ success: false, error: 'valid_until must be after valid_from' }, 400);
  }

  const now = Date.now();
  const promoId = `promo_${nanoid()}`;

  try {
    await c.env.DB.prepare(`
      INSERT INTO trns_promo_codes (id, operator_id, code, description, discount_type, discount_value, max_uses, min_fare_kobo, max_discount_kobo, valid_from, valid_until, is_active, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      promoId, body.operator_id ?? null, body.code.toUpperCase(),
      body.description ?? null, body.discount_type, body.discount_value,
      body.max_uses ?? null, body.min_fare_kobo ?? 0,
      body.max_discount_kobo ?? null,
      body.valid_from, body.valid_until, body.created_by, now,
    ).run();
  } catch {
    return c.json({ success: false, error: 'Promo code already exists' }, 409);
  }

  return c.json({ success: true, data: { promo_code_id: promoId, code: body.code.toUpperCase() } }, 201);
});

// ============================================================
// GET /api/promo/codes?operator_id=...&active=true
// List promo codes (operator/admin)
// ============================================================
promoRouter.get('/codes', async (c) => {
  const operatorId = c.req.query('operator_id');
  const active = c.req.query('active');
  const now = Date.now();

  let query = `SELECT * FROM trns_promo_codes WHERE deleted_at IS NULL`;
  const bindings: unknown[] = [];

  if (operatorId) { query += ' AND (operator_id = ? OR operator_id IS NULL)'; bindings.push(operatorId); }
  if (active === 'true') { query += ' AND is_active = 1 AND valid_from <= ? AND valid_until >= ?'; bindings.push(now, now); }

  query += ' ORDER BY created_at DESC LIMIT 50';

  const { results } = await c.env.DB.prepare(query).bind(...bindings).all();
  return c.json({ success: true, data: results ?? [] });
});

// ============================================================
// PATCH /api/promo/codes/:id/deactivate
// Deactivate a promo code
// ============================================================
promoRouter.patch('/codes/:id/deactivate', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`UPDATE trns_promo_codes SET is_active = 0 WHERE id = ?`).bind(id).run();
  return c.json({ success: true, data: { id, is_active: false } });
});
