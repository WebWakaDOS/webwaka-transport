/**
 * T-TRN-03: Dynamic Fare Matrix Engine — Core Pricing Engine
 *
 * Design principles:
 *   - Pure function: no I/O, no side effects, deterministic
 *   - Works identically in CF Workers, Node.js, and unit tests
 *   - Single source of truth for all fare calculations across booking-portal + seat-inventory
 *
 * Rule precedence: highest multiplier wins — no stacking to prevent compounding surges
 *
 * Rule types:
 *   surge_period  — date range: starts_at ≤ refTime ≤ ends_at
 *   peak_hours    — time-of-day: hour_from ≤ UTC hour < hour_to
 *   peak_days     — days of week: days_of_week JSON array (0=Sun…6=Sat)
 *   weekend       — shorthand for days_of_week=[0,6]
 *   always        — unconditional (useful for permanent class pricing)
 *
 * Multi-tenant invariant: route_id + operator_id scope enforced at the query layer.
 * This engine is stateless and only receives pre-fetched rows.
 */

// ── Shared FareRule row interface (matches fare_rules D1 table) ───────────────

export interface FareRule {
  id: string;
  operator_id: string;
  route_id: string;
  name: string;
  rule_type: 'surge_period' | 'peak_hours' | 'peak_days' | 'weekend' | 'always';
  starts_at: number | null;
  ends_at: number | null;
  days_of_week: string | null;   // JSON: number[] e.g. [5,6]
  hour_from: number | null;      // 0-23 UTC
  hour_to: number | null;        // 0-23 UTC (exclusive)
  class_multipliers: string | null; // JSON: Record<string,number> e.g. {"vip":1.5}
  base_multiplier: number;       // fallback multiplier for all classes
  priority: number;              // higher wins tie-break (not used for stacking)
  is_active: number;             // 1 = active, 0 = disabled
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute the effective fare (kobo) for a specific seat class, given active fare rules.
 *
 * @param baseFare     Route base_fare in kobo
 * @param seatClass    e.g. 'standard' | 'window' | 'vip' | 'front'
 * @param fareRules    All fare_rules rows for this route (active + inactive, function filters)
 * @param refTimeMs    Reference timestamp for rule matching (usually trip.departure_time)
 * @returns            Effective fare in kobo (integer, rounded)
 */
export function computeEffectiveFare(
  baseFare: number,
  seatClass: string,
  fareRules: FareRule[],
  refTimeMs: number,
): number {
  const activeRules = fareRules
    .filter(r => r.is_active !== 0 && r.deleted_at === null)
    .filter(r => isRuleApplicable(r, refTimeMs))
    .sort((a, b) => b.priority - a.priority);

  let bestMultiplier = 1.0;

  for (const rule of activeRules) {
    const classMultipliers: Record<string, number> = rule.class_multipliers
      ? (JSON.parse(rule.class_multipliers) as Record<string, number>)
      : {};
    const mult = classMultipliers[seatClass] ?? rule.base_multiplier;
    if (mult > bestMultiplier) {
      bestMultiplier = mult;
    }
  }

  return Math.round(baseFare * bestMultiplier);
}

/**
 * Compute effective fares for all standard seat classes at once.
 * Returns a Record<seatClass, kobo> suitable for trip search results.
 */
export function computeEffectiveFareByClass(
  baseFare: number,
  fareRules: FareRule[],
  refTimeMs: number,
): Record<string, number> {
  const CLASSES = ['standard', 'window', 'vip', 'front'];
  const result: Record<string, number> = {};
  for (const cls of CLASSES) {
    result[cls] = computeEffectiveFare(baseFare, cls, fareRules, refTimeMs);
  }
  return result;
}

// ── Rule matching logic ───────────────────────────────────────────────────────

function isRuleApplicable(rule: FareRule, refTimeMs: number): boolean {
  switch (rule.rule_type) {
    case 'surge_period':
      if (rule.starts_at === null || rule.ends_at === null) return false;
      return refTimeMs >= rule.starts_at && refTimeMs <= rule.ends_at;

    case 'peak_hours': {
      if (rule.hour_from === null || rule.hour_to === null) return false;
      const hour = new Date(refTimeMs).getUTCHours();
      // Wrap-around support: e.g. hour_from=22, hour_to=6 (overnight peak)
      if (rule.hour_from <= rule.hour_to) {
        return hour >= rule.hour_from && hour < rule.hour_to;
      }
      // Overnight: e.g. 22 → 6 means 22,23,0,1,2,3,4,5
      return hour >= rule.hour_from || hour < rule.hour_to;
    }

    case 'peak_days': {
      const day = new Date(refTimeMs).getUTCDay();
      if (!rule.days_of_week) return false;
      const days = JSON.parse(rule.days_of_week) as number[];
      return days.includes(day);
    }

    case 'weekend': {
      const day = new Date(refTimeMs).getUTCDay();
      return day === 0 || day === 6;
    }

    case 'always':
      return true;

    default:
      return false;
  }
}

// ── Validation helpers ────────────────────────────────────────────────────────

export const VALID_RULE_TYPES = ['surge_period', 'peak_hours', 'peak_days', 'weekend', 'always'] as const;
export type RuleType = typeof VALID_RULE_TYPES[number];

/**
 * Validate a fare rule payload before INSERT/UPDATE.
 * Returns an error string or null if valid.
 */
export function validateFareRule(body: Record<string, unknown>): string | null {
  const { rule_type, base_multiplier, starts_at, ends_at, hour_from, hour_to, days_of_week, class_multipliers } = body;

  if (!VALID_RULE_TYPES.includes(rule_type as RuleType)) {
    return `rule_type must be one of: ${VALID_RULE_TYPES.join(', ')}`;
  }

  const mult = Number(base_multiplier);
  if (!Number.isFinite(mult) || mult < 0.5 || mult > 10) {
    return 'base_multiplier must be a number between 0.5 and 10';
  }

  if (rule_type === 'surge_period') {
    if (typeof starts_at !== 'number' || typeof ends_at !== 'number') {
      return 'surge_period rules require starts_at and ends_at (Unix ms)';
    }
    if ((ends_at as number) <= (starts_at as number)) {
      return 'ends_at must be after starts_at';
    }
  }

  if (rule_type === 'peak_hours') {
    const from = Number(hour_from);
    const to = Number(hour_to);
    if (!Number.isInteger(from) || from < 0 || from > 23) return 'hour_from must be 0-23';
    if (!Number.isInteger(to) || to < 0 || to > 23) return 'hour_to must be 0-23';
    if (from === to) return 'hour_from and hour_to must differ';
  }

  if (rule_type === 'peak_days') {
    if (!Array.isArray(days_of_week) || (days_of_week as unknown[]).length === 0 || (days_of_week as unknown[]).some(d => typeof d !== 'number' || d < 0 || d > 6)) {
      return 'days_of_week must be an array of integers 0-6 (0=Sun)';
    }
  }

  if (class_multipliers !== undefined && class_multipliers !== null) {
    if (typeof class_multipliers !== 'object' || Array.isArray(class_multipliers)) {
      return 'class_multipliers must be an object { seatClass: multiplier }';
    }
    for (const [, v] of Object.entries(class_multipliers as Record<string, unknown>)) {
      if (typeof v !== 'number' || v < 0.5 || v > 10) {
        return 'each class_multiplier value must be a number between 0.5 and 10';
      }
    }
  }

  return null;
}
