/**
 * WebWaka Transport Suite — Shared API Types
 * D1 row interfaces, Hono context, tenant enforcement, pagination helpers
 * Invariants: Multi-tenancy, Nigeria-First (kobo), Strict TypeScript
 */
import type { Context } from 'hono';
import type { WakaUser } from '@webwaka/core';

// ============================================================
// Hono Env + Context
// ============================================================

export interface Env {
  DB: D1Database;
  SESSIONS_KV?: KVNamespace;
  TENANT_CONFIG_KV?: KVNamespace;
  SEAT_CACHE_KV?: KVNamespace;
  IDEMPOTENCY_KV?: KVNamespace;
  JWT_SECRET?: string;
  MIGRATION_SECRET?: string;
  PAYSTACK_SECRET?: string;
  FLUTTERWAVE_SECRET?: string;
  SMS_API_KEY?: string;
  TERMII_API_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AI_PLATFORM_URL?: string;
  AI_PLATFORM_TOKEN?: string;
  SENDGRID_API_KEY?: string;
  TRIP_SEAT_DO?: DurableObjectNamespace;
  ASSETS_R2?: R2Bucket;
  CENTRAL_MGMT_URL?: string;
  INTER_SERVICE_SECRET?: string;
}

export type HonoVariables = {
  user: WakaUser | undefined;
};

export type AppContext = { Bindings: Env; Variables: HonoVariables };

export type HonoCtx = Context<AppContext>;

// ============================================================
// D1 Row Interfaces — typed results from db.prepare().first()/.all()
// ============================================================

export interface DbOperator {
  id: string;
  name: string;
  code: string;
  phone: string | null;
  email: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface DbRoute {
  id: string;
  operator_id: string;
  origin: string;
  destination: string;
  distance_km: number | null;
  duration_minutes: number | null;
  base_fare: number;
  status: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface DbVehicle {
  id: string;
  operator_id: string;
  plate_number: string;
  vehicle_type: string;
  model: string | null;
  total_seats: number;
  status: string;
  seat_template: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface DbTrip {
  id: string;
  operator_id: string;
  route_id: string;
  vehicle_id: string;
  driver_id: string | null;
  departure_time: number;
  state: string;
  current_latitude: number | null;
  current_longitude: number | null;
  location_updated_at: number | null;
  sos_active: number;
  sos_triggered_at: number | null;
  sos_triggered_by: string | null;
  sos_cleared_at: number | null;
  sos_cleared_by: string | null;
  inspection_completed_at: number | null;
  delay_reason_code: string | null;
  delay_reported_at: number | null;
  estimated_departure_ms: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface DbDriver {
  id: string;
  operator_id: string;
  name: string;
  phone: string;
  license_number: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface DbSeat {
  id: string;
  trip_id: string;
  seat_number: string;
  seat_class: string;
  status: string;
  reserved_by: string | null;
  reservation_token: string | null;
  reservation_expires_at: number | null;
  confirmed_by: string | null;
  confirmed_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface DbBooking {
  id: string;
  customer_id: string;
  trip_id: string;
  seat_ids: string;
  passenger_names: string;
  total_amount: number;
  status: string;
  payment_status: string;
  payment_method: string;
  payment_reference: string;
  created_at: number;
  confirmed_at: number | null;
  cancelled_at: number | null;
  deleted_at: number | null;
  payment_provider: string | null;
  paid_at: number | null;
  refund_reference: string | null;
  refund_amount_kobo: number | null;
  manual_refund_required: number | null;
  group_booking_id: string | null;
}

export interface DbCustomer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  ndpr_consent: number;
  status: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface DbAgent {
  id: string;
  operator_id: string;
  name: string;
  phone: string;
  email: string | null;
  role: string;
  bus_parks: string;
  status: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface DbSalesTransaction {
  id: string;
  agent_id: string;
  trip_id: string;
  seat_ids: string;
  passenger_names: string;
  total_amount: number;
  payment_method: string;
  payment_status: string;
  sync_status: string;
  receipt_id: string;
  passenger_id_type: string | null;
  passenger_id_hash: string | null;
  created_at: number;
  synced_at: number | null;
  deleted_at: number | null;
}

export interface DbReceipt {
  id: string;
  transaction_id: string;
  agent_id: string;
  trip_id: string;
  passenger_names: string;
  seat_numbers: string;
  total_amount: number;
  payment_method: string;
  qr_code: string | null;
  issued_at: number;
}

// ============================================================
// Multi-Tenant Enforcement
// ============================================================

/**
 * Returns the operator_id that all D1 queries MUST be scoped to.
 * Returns null for SUPER_ADMIN (can see all operators) and for
 * unauthenticated routes (tests / public endpoints).
 */
export function getOperatorScope(c: HonoCtx): string | null {
  const user = c.get('user');
  if (!user) return null;
  if (user.role === 'SUPER_ADMIN') return null;
  return user.operatorId ?? null;
}

/**
 * Appends ` AND <alias>operator_id = ?` to a SQL query and param list
 * when the current user is tenant-scoped. No-op for SUPER_ADMIN.
 */
export function applyTenantScope(
  c: HonoCtx,
  query: string,
  params: unknown[],
  alias = ''
): { query: string; params: unknown[] } {
  const scope = getOperatorScope(c);
  if (scope === null) return { query, params };
  return {
    query: query + ` AND ${alias}operator_id = ?`,
    params: [...params, scope],
  };
}

// ============================================================
// Pagination
// ============================================================

export interface PaginationParams {
  limit: number;
  offset: number;
}

export function parsePagination(q: Record<string, string>): PaginationParams {
  const rawLimit = parseInt(q['limit'] ?? '50', 10);
  const rawOffset = parseInt(q['offset'] ?? '0', 10);
  return {
    limit: isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200),
    offset: isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0),
  };
}

export function metaResponse(count: number, limit: number, offset: number) {
  return { count, limit, offset, has_more: count === limit };
}

// ============================================================
// Input Validation
// ============================================================

export function requireFields(
  body: Record<string, unknown>,
  fields: string[]
): string | null {
  const missing = fields.filter(f => {
    const v = body[f];
    return v === undefined || v === null || v === '';
  });
  return missing.length ? `Required: ${missing.join(', ')}` : null;
}

// ============================================================
// ID Generation
// ============================================================

export function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
