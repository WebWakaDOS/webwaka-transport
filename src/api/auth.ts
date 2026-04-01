/**
 * WebWaka Auth API — OTP-based phone authentication
 * Public routes: POST /api/auth/otp/request, POST /api/auth/otp/verify
 * These are exempted from jwtAuthMiddleware in middleware/auth.ts
 *
 * OTP Flow:
 *   1. Client sends { phone } → server generates 6-digit code, stores in SESSIONS_KV (5-min TTL)
 *   2. Client sends { request_id, code } → server verifies, find/create Customer row,
 *      issues JWT (24h), returns { token, user }
 *
 * Dev note: when SMS_API_KEY is absent, the code is echoed in the response
 *           for easy local testing. Never expose this in production.
 */
import { Hono } from 'hono';
import { generateJWT } from '@webwaka/core';
import type { AppContext } from './types';
import { genId, requireFields } from './types';

export const authRouter = new Hono<AppContext>();

// ============================================================
// POST /api/auth/otp/request
// Body: { phone: string }
// ============================================================
authRouter.post('/otp/request', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const fieldError = requireFields(body, ['phone']);
  if (fieldError) return c.json({ success: false, error: fieldError }, 400);

  const phone = String(body['phone']).replace(/\D/g, '');
  if (phone.length < 10 || phone.length > 15) {
    return c.json({ success: false, error: 'Invalid phone number format' }, 400);
  }

  if (!c.env.SESSIONS_KV) {
    return c.json({ success: false, error: 'OTP service unavailable' }, 503);
  }

  // Rate limiting: max 5 OTP requests per phone per 10-minute sliding window
  const rateKey = `rate:${phone}`;
  try {
    const rateRaw = await c.env.SESSIONS_KV.get(rateKey);
    const rateCount = rateRaw ? parseInt(rateRaw, 10) : 0;
    if (rateCount >= 5) {
      return c.json({ success: false, error: 'Too many OTP requests. Please wait 10 minutes and try again.' }, 429);
    }
    await c.env.SESSIONS_KV.put(rateKey, String(rateCount + 1), { expirationTtl: 600 });
  } catch {
    // Non-fatal — allow through if KV rate-check fails
  }

  const code = String(Math.floor(100_000 + Math.random() * 900_000));
  const requestId = genId('otp');
  const expiresAt = Date.now() + 5 * 60 * 1000;

  try {
    await c.env.SESSIONS_KV.put(
      `otp:${requestId}`,
      JSON.stringify({ phone, code, expires_at: expiresAt }),
      { expirationTtl: 300 }
    );
  } catch (err: unknown) {
    console.error('[auth/otp/request] KV error:', err);
    return c.json({ success: false, error: 'Failed to store OTP session' }, 500);
  }

  const hasSms = Boolean(c.env.SMS_API_KEY);
  if (hasSms) {
    try {
      const { buildSmsProvider } = await import('../lib/sms.js');
      await buildSmsProvider(c.env).send(
        phone,
        `Your WebWaka OTP is: ${code}. Valid for 5 minutes. Do not share this code.`
      );
    } catch (smsErr: unknown) {
      const errMsg = smsErr instanceof Error ? smsErr.message : String(smsErr);
      console.error(`[auth/otp/request] SMS send failed for ${phone}: ${errMsg}`);
      // Non-fatal: OTP is stored in KV; dev_code returned if SMS is not configured
    }
  } else {
    console.warn(`[auth/otp] SMS not configured — dev_otp returned in response (DEVELOPMENT MODE ONLY)`);
  }

  return c.json({
    success: true,
    data: {
      request_id: requestId,
      expires_in: 300,
      phone_hint: `${phone.slice(0, 3)}****${phone.slice(-3)}`,
      // Echo code only when SMS service is not configured (dev/test environments)
      ...(hasSms ? {} : { dev_code: code }),
    },
  });
});

// ============================================================
// POST /api/auth/otp/verify
// Body: { request_id: string, code: string }
// ============================================================
authRouter.post('/otp/verify', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const fieldError = requireFields(body, ['request_id', 'code']);
  if (fieldError) return c.json({ success: false, error: fieldError }, 400);

  if (!c.env.SESSIONS_KV) {
    return c.json({ success: false, error: 'OTP service unavailable' }, 503);
  }

  const requestId = String(body['request_id']);
  const submittedCode = String(body['code']).trim();

  type OtpSession = { phone: string; code: string; expires_at: number; used?: boolean };
  let session: OtpSession | null = null;
  try {
    const rawSession = await c.env.SESSIONS_KV.get(`otp:${requestId}`);
    if (!rawSession) {
      return c.json({ success: false, error: 'OTP expired or not found. Request a new one.' }, 400);
    }
    session = JSON.parse(rawSession) as OtpSession;
  } catch (err: unknown) {
    console.error('[auth/otp/verify] KV error:', err);
    return c.json({ success: false, error: 'Session lookup failed' }, 500);
  }

  if (!session) {
    return c.json({ success: false, error: 'Invalid OTP session' }, 400);
  }

  // Reject replayed OTP — already consumed by a prior successful verify
  if (session.used === true) {
    return c.json({ success: false, error: 'OTP already used. Request a new one.' }, 400);
  }

  const otpSession: OtpSession = session;

  if (Date.now() > otpSession.expires_at) {
    return c.json({ success: false, error: 'OTP has expired. Request a new one.' }, 400);
  }

  if (submittedCode !== otpSession.code) {
    return c.json({ success: false, error: 'Incorrect OTP code. Check the SMS and try again.' }, 400);
  }

  // Mark OTP as used BEFORE issuing JWT — prevents reuse even if JWT issuance fails
  try {
    await c.env.SESSIONS_KV.put(
      `otp:${requestId}`,
      JSON.stringify({ ...otpSession, used: true }),
      { expirationTtl: 300 }
    );
  } catch (err: unknown) {
    console.error('[auth/otp/verify] Failed to mark OTP used:', err);
    return c.json({ success: false, error: 'Failed to consume OTP session' }, 500);
  }

  const phone = otpSession.phone;

  // Find or create customer by phone
  let userId: string;
  let userName: string | null = null;
  let userRole: 'CUSTOMER' | 'STAFF' | 'SUPERVISOR' | 'TENANT_ADMIN' | 'SUPER_ADMIN' = 'CUSTOMER';
  let operatorId: string | null = null;

  try {
    // Check customers table first
    const existingCustomer = await c.env.DB.prepare(
      'SELECT id, name FROM customers WHERE phone = ? LIMIT 1'
    ).bind(phone).first<{ id: string; name: string | null }>();

    if (existingCustomer) {
      userId = existingCustomer.id;
      userName = existingCustomer.name;
    } else {
      // Check agents table (agents may log in via phone too)
      const existingAgent = await c.env.DB.prepare(
        'SELECT id, name, operator_id, status FROM agents WHERE phone = ? LIMIT 1'
      ).bind(phone).first<{ id: string; name: string; operator_id: string; status: string }>();

      if (existingAgent) {
        userId = existingAgent.id;
        userName = existingAgent.name;
        userRole = 'STAFF';
        operatorId = existingAgent.operator_id;
      } else {
        // New customer — create record
        const newId = genId('cus');
        const nowMs = Date.now();
        await c.env.DB.prepare(
          'INSERT INTO customers (id, name, phone, ndpr_consent, created_at, updated_at) VALUES (?, NULL, ?, 0, ?, ?)'
        ).bind(newId, phone, nowMs, nowMs).run();
        userId = newId;
      }
    }
  } catch (err: unknown) {
    console.error('[auth/otp/verify] DB error:', err);
    return c.json({ success: false, error: 'Failed to load user account' }, 500);
  }

  if (!c.env.JWT_SECRET) {
    console.error('[auth/otp/verify] JWT_SECRET is not configured');
    return c.json({ success: false, error: 'Authentication service misconfigured' }, 503);
  }
  const secret = c.env.JWT_SECRET;
  let token: string;
  try {
    token = await generateJWT(
      {
        id: userId,
        role: userRole,
        phone,
        ...(operatorId ? { operatorId } : {}),
      },
      secret,
      24 * 60 * 60 // 24 hours
    );
  } catch (err: unknown) {
    console.error('[auth/otp/verify] JWT error:', err);
    return c.json({ success: false, error: 'Failed to issue session token' }, 500);
  }

  return c.json({
    success: true,
    data: {
      token,
      user: {
        id: userId,
        name: userName,
        phone,
        role: userRole,
        ...(operatorId ? { operator_id: operatorId } : {}),
      },
    },
  });
});
