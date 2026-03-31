/**
 * Operator Runtime Configuration
 * Stored in TENANT_CONFIG_KV keyed by operator_id.
 * Defaults applied for any missing field.
 */

export interface OperatorConfig {
  reservation_ttl_ms: number;
  online_reservation_ttl_ms: number;
  abandonment_window_ms: number;
  surge_multiplier_cap: number;
  boarding_window_minutes: number;
  parcel_acceptance_enabled: boolean;
  cancellation_policy: {
    free_before_hours: number;
    half_refund_before_hours: number;
  };
  emergency_contact_phone: string;
  sos_escalation_email: string;
  inspection_required_before_boarding: boolean;
}

const DEFAULT_CONFIG: OperatorConfig = {
  reservation_ttl_ms: 30_000,
  online_reservation_ttl_ms: 180_000,
  abandonment_window_ms: 1_800_000,
  surge_multiplier_cap: 2.0,
  boarding_window_minutes: 30,
  parcel_acceptance_enabled: false,
  cancellation_policy: { free_before_hours: 24, half_refund_before_hours: 12 },
  emergency_contact_phone: '',
  sos_escalation_email: '',
  inspection_required_before_boarding: false,
};

export async function getOperatorConfig(
  env: { TENANT_CONFIG_KV?: KVNamespace },
  operatorId: string,
): Promise<OperatorConfig> {
  if (!env.TENANT_CONFIG_KV) return { ...DEFAULT_CONFIG };
  try {
    const raw = await env.TENANT_CONFIG_KV.get(operatorId);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<OperatorConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      cancellation_policy: {
        ...DEFAULT_CONFIG.cancellation_policy,
        ...(parsed.cancellation_policy ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function validateOperatorConfig(body: Record<string, unknown>): string | null {
  const required: Array<[keyof OperatorConfig, string]> = [
    ['reservation_ttl_ms', 'number'],
    ['online_reservation_ttl_ms', 'number'],
    ['abandonment_window_ms', 'number'],
    ['surge_multiplier_cap', 'number'],
    ['boarding_window_minutes', 'number'],
    ['parcel_acceptance_enabled', 'boolean'],
    ['emergency_contact_phone', 'string'],
    ['sos_escalation_email', 'string'],
    ['inspection_required_before_boarding', 'boolean'],
  ];

  for (const [field, type] of required) {
    if (typeof body[field] !== type) {
      return `Field '${field}' must be a ${type}`;
    }
  }

  // Range validation — reject zero, negative, and unreasonably large values
  const ttl = body['reservation_ttl_ms'] as number;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    return `reservation_ttl_ms must be a positive integer (ms), got ${ttl}`;
  }
  if (ttl > 30 * 60 * 1000) {
    return `reservation_ttl_ms cannot exceed 30 minutes (1800000 ms)`;
  }

  const onlineTtl = body['online_reservation_ttl_ms'] as number;
  if (!Number.isInteger(onlineTtl) || onlineTtl <= 0) {
    return `online_reservation_ttl_ms must be a positive integer (ms), got ${onlineTtl}`;
  }
  if (onlineTtl > 60 * 60 * 1000) {
    return `online_reservation_ttl_ms cannot exceed 60 minutes (3600000 ms)`;
  }

  const abandonMs = body['abandonment_window_ms'] as number;
  if (!Number.isInteger(abandonMs) || abandonMs <= 0) {
    return `abandonment_window_ms must be a positive integer (ms), got ${abandonMs}`;
  }

  const surge = body['surge_multiplier_cap'] as number;
  if (typeof surge !== 'number' || surge <= 0) {
    return `surge_multiplier_cap must be a positive number, got ${surge}`;
  }
  if (surge > 5.0) {
    return `surge_multiplier_cap cannot exceed 5.0 (got ${surge}) — prevents runaway pricing`;
  }

  const boarding = body['boarding_window_minutes'] as number;
  if (!Number.isInteger(boarding) || boarding <= 0 || boarding > 240) {
    return `boarding_window_minutes must be a positive integer between 1 and 240`;
  }

  const policy = body['cancellation_policy'] as Record<string, unknown> | undefined;
  if (!policy || typeof policy !== 'object') {
    return `Field 'cancellation_policy' must be an object`;
  }
  if (typeof policy['free_before_hours'] !== 'number') {
    return `Field 'cancellation_policy.free_before_hours' must be a number`;
  }
  if (typeof policy['half_refund_before_hours'] !== 'number') {
    return `Field 'cancellation_policy.half_refund_before_hours' must be a number`;
  }

  return null;
}

export { DEFAULT_CONFIG };
