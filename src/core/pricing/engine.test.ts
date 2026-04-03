/**
 * T-TRN-03: Unit tests for the Dynamic Fare Matrix Engine
 * Tests are pure: no I/O, no mocking of DB — only the computeEffectiveFare function.
 */
import { describe, it, expect } from 'vitest';
import { computeEffectiveFare, computeEffectiveFareByClass, validateFareRule } from './engine';
import type { FareRule } from './engine';

// ── Test helpers ───────────────────────────────────────────────────────────────

const BASE_FARE = 500_000; // ₦5,000 in kobo

function makeRule(overrides: Partial<FareRule>): FareRule {
  return {
    id: 'far_test',
    operator_id: 'opr_1',
    route_id: 'rte_1',
    name: 'Test Rule',
    rule_type: 'always',
    starts_at: null,
    ends_at: null,
    days_of_week: null,
    hour_from: null,
    hour_to: null,
    class_multipliers: null,
    base_multiplier: 1.0,
    priority: 0,
    is_active: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
    deleted_at: null,
    ...overrides,
  };
}

// A known Friday at 17:00 UTC (peak travel hour + weekend-adjacent)
// 2026-04-10 (Friday) 17:00 UTC → day=5
const FRIDAY_5PM_UTC = new Date('2026-04-10T17:00:00Z').getTime();

// A known Saturday at 10:00 UTC
const SATURDAY_10AM_UTC = new Date('2026-04-11T10:00:00Z').getTime();

// A quiet Tuesday at 08:00 UTC
const TUESDAY_8AM_UTC = new Date('2026-04-07T08:00:00Z').getTime();

// ── T001: No rules → base fare returned ──────────────────────────────────────

describe('computeEffectiveFare — no rules', () => {
  it('returns base fare when rule list is empty', () => {
    expect(computeEffectiveFare(BASE_FARE, 'standard', [], FRIDAY_5PM_UTC)).toBe(BASE_FARE);
  });

  it('returns base fare when all rules are inactive', () => {
    const inactiveRule = makeRule({ base_multiplier: 2.0, is_active: 0 });
    expect(computeEffectiveFare(BASE_FARE, 'standard', [inactiveRule], FRIDAY_5PM_UTC)).toBe(BASE_FARE);
  });

  it('returns base fare when all rules are soft-deleted', () => {
    const deletedRule = makeRule({ base_multiplier: 2.0, deleted_at: Date.now() });
    expect(computeEffectiveFare(BASE_FARE, 'standard', [deletedRule], FRIDAY_5PM_UTC)).toBe(BASE_FARE);
  });
});

// ── T002: Always rule ─────────────────────────────────────────────────────────

describe('computeEffectiveFare — always rule', () => {
  it('applies always rule at any time', () => {
    const rule = makeRule({ rule_type: 'always', base_multiplier: 1.3 });
    // Expected: 500000 * 1.3 = 650000
    expect(computeEffectiveFare(BASE_FARE, 'standard', [rule], TUESDAY_8AM_UTC)).toBe(650_000);
    expect(computeEffectiveFare(BASE_FARE, 'standard', [rule], SATURDAY_10AM_UTC)).toBe(650_000);
  });

  it('rounds to nearest kobo (integer result)', () => {
    const rule = makeRule({ rule_type: 'always', base_multiplier: 1.333 });
    const result = computeEffectiveFare(BASE_FARE, 'standard', [rule], TUESDAY_8AM_UTC);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ── T003: Surge period rule ───────────────────────────────────────────────────

describe('computeEffectiveFare — surge_period', () => {
  const surgeRule = makeRule({
    rule_type: 'surge_period',
    base_multiplier: 2.5,
    starts_at: new Date('2026-04-10T00:00:00Z').getTime(),
    ends_at: new Date('2026-04-11T23:59:59Z').getTime(),
  });

  it('applies surge when departure time is within the surge window', () => {
    // Friday 5 PM is within the surge window
    expect(computeEffectiveFare(BASE_FARE, 'standard', [surgeRule], FRIDAY_5PM_UTC)).toBe(1_250_000);
  });

  it('does NOT apply surge when departure is outside the window', () => {
    const before = new Date('2026-04-09T23:59:00Z').getTime();
    expect(computeEffectiveFare(BASE_FARE, 'standard', [surgeRule], before)).toBe(BASE_FARE);
  });

  it('does NOT apply surge when starts_at is null', () => {
    const badRule = makeRule({ rule_type: 'surge_period', base_multiplier: 2.0, starts_at: null, ends_at: null });
    expect(computeEffectiveFare(BASE_FARE, 'standard', [badRule], FRIDAY_5PM_UTC)).toBe(BASE_FARE);
  });
});

// ── T004: Peak hours rule ─────────────────────────────────────────────────────

describe('computeEffectiveFare — peak_hours', () => {
  // Peak hours: 16:00–20:00 UTC (evening rush)
  const peakRule = makeRule({
    rule_type: 'peak_hours',
    base_multiplier: 1.5,
    hour_from: 16,
    hour_to: 20,
  });

  it('applies multiplier during peak hours (17:00 UTC)', () => {
    // 500000 * 1.5 = 750000
    expect(computeEffectiveFare(BASE_FARE, 'standard', [peakRule], FRIDAY_5PM_UTC)).toBe(750_000);
  });

  it('does NOT apply multiplier outside peak hours (8 AM)', () => {
    expect(computeEffectiveFare(BASE_FARE, 'standard', [peakRule], TUESDAY_8AM_UTC)).toBe(BASE_FARE);
  });

  it('handles overnight peak (e.g. 22:00 – 04:00)', () => {
    const overnightRule = makeRule({ rule_type: 'peak_hours', base_multiplier: 1.2, hour_from: 22, hour_to: 4 });
    const at23 = new Date('2026-04-10T23:00:00Z').getTime();
    const at2 = new Date('2026-04-11T02:00:00Z').getTime();
    const at10 = new Date('2026-04-11T10:00:00Z').getTime();
    expect(computeEffectiveFare(BASE_FARE, 'standard', [overnightRule], at23)).toBe(600_000);
    expect(computeEffectiveFare(BASE_FARE, 'standard', [overnightRule], at2)).toBe(600_000);
    expect(computeEffectiveFare(BASE_FARE, 'standard', [overnightRule], at10)).toBe(BASE_FARE);
  });
});

// ── T005: Weekend rule ────────────────────────────────────────────────────────

describe('computeEffectiveFare — weekend', () => {
  const weekendRule = makeRule({ rule_type: 'weekend', base_multiplier: 1.4 });

  it('applies weekend multiplier on Saturday', () => {
    expect(computeEffectiveFare(BASE_FARE, 'standard', [weekendRule], SATURDAY_10AM_UTC)).toBe(700_000);
  });

  it('does NOT apply weekend multiplier on Tuesday', () => {
    expect(computeEffectiveFare(BASE_FARE, 'standard', [weekendRule], TUESDAY_8AM_UTC)).toBe(BASE_FARE);
  });
});

// ── T006: Peak days rule ──────────────────────────────────────────────────────

describe('computeEffectiveFare — peak_days', () => {
  // Friday (5) and Saturday (6) are peak days
  const peakDaysRule = makeRule({
    rule_type: 'peak_days',
    base_multiplier: 1.6,
    days_of_week: JSON.stringify([5, 6]),
  });

  it('applies multiplier on peak days (Friday)', () => {
    expect(computeEffectiveFare(BASE_FARE, 'standard', [peakDaysRule], FRIDAY_5PM_UTC)).toBe(800_000);
  });

  it('does NOT apply multiplier on non-peak days (Tuesday)', () => {
    expect(computeEffectiveFare(BASE_FARE, 'standard', [peakDaysRule], TUESDAY_8AM_UTC)).toBe(BASE_FARE);
  });
});

// ── T007: Multi-rule priority — highest multiplier wins (no stacking) ─────────

describe('computeEffectiveFare — multi-rule priority', () => {
  it('selects the highest multiplier when multiple rules match', () => {
    const lowRule = makeRule({ rule_type: 'always', base_multiplier: 1.2, priority: 0 });
    const highRule = makeRule({ rule_type: 'weekend', base_multiplier: 1.8, priority: 10 });
    // On Saturday, both match. Highest multiplier (1.8) wins — no stacking
    const result = computeEffectiveFare(BASE_FARE, 'standard', [lowRule, highRule], SATURDAY_10AM_UTC);
    expect(result).toBe(900_000); // 500000 * 1.8
  });

  it('does NOT stack multipliers (no compounding surges)', () => {
    const rule1 = makeRule({ rule_type: 'always', base_multiplier: 1.5, priority: 5 });
    const rule2 = makeRule({ rule_type: 'weekend', base_multiplier: 1.3, priority: 0 });
    // On Saturday: MUST be 1.5 × base (not 1.5 × 1.3 × base)
    const result = computeEffectiveFare(BASE_FARE, 'standard', [rule1, rule2], SATURDAY_10AM_UTC);
    expect(result).toBe(750_000); // 500000 * 1.5
    expect(result).not.toBe(975_000); // NOT compounding
  });
});

// ── T008: Seat-class-specific multipliers ─────────────────────────────────────

describe('computeEffectiveFare — class_multipliers', () => {
  it('uses class-specific multiplier over base_multiplier for matching class', () => {
    const rule = makeRule({
      rule_type: 'always',
      base_multiplier: 1.2,
      class_multipliers: JSON.stringify({ vip: 2.0, front: 1.5 }),
    });
    // VIP gets its own multiplier (2.0), not base (1.2)
    expect(computeEffectiveFare(BASE_FARE, 'vip', [rule], TUESDAY_8AM_UTC)).toBe(1_000_000);
    // Front gets front multiplier (1.5)
    expect(computeEffectiveFare(BASE_FARE, 'front', [rule], TUESDAY_8AM_UTC)).toBe(750_000);
    // Standard falls back to base_multiplier (1.2)
    expect(computeEffectiveFare(BASE_FARE, 'standard', [rule], TUESDAY_8AM_UTC)).toBe(600_000);
  });
});

// ── T009: computeEffectiveFareByClass ─────────────────────────────────────────

describe('computeEffectiveFareByClass', () => {
  it('returns a fare for all 4 standard classes', () => {
    const rule = makeRule({ rule_type: 'always', base_multiplier: 1.5 });
    const result = computeEffectiveFareByClass(BASE_FARE, [rule], TUESDAY_8AM_UTC);
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['standard', 'window', 'vip', 'front']));
    expect(result['standard']).toBe(750_000);
    expect(result['vip']).toBe(750_000);
  });
});

// ── T010: validateFareRule ────────────────────────────────────────────────────

describe('validateFareRule', () => {
  it('returns null for a valid always rule', () => {
    expect(validateFareRule({ name: 'x', rule_type: 'always', base_multiplier: 1.5 })).toBeNull();
  });

  it('rejects invalid rule_type', () => {
    expect(validateFareRule({ name: 'x', rule_type: 'flying', base_multiplier: 1.5 })).toMatch(/rule_type/i);
  });

  it('rejects base_multiplier out of range', () => {
    expect(validateFareRule({ name: 'x', rule_type: 'always', base_multiplier: 0.1 })).toMatch(/0\.5/);
    expect(validateFareRule({ name: 'x', rule_type: 'always', base_multiplier: 15 })).toMatch(/10/);
  });

  it('rejects surge_period missing dates', () => {
    expect(validateFareRule({ name: 'x', rule_type: 'surge_period', base_multiplier: 1.5 })).toMatch(/starts_at/);
  });

  it('rejects surge_period where ends_at <= starts_at', () => {
    const now = Date.now();
    expect(validateFareRule({ name: 'x', rule_type: 'surge_period', base_multiplier: 1.5, starts_at: now + 1000, ends_at: now })).toMatch(/ends_at/);
  });

  it('rejects peak_hours missing range', () => {
    expect(validateFareRule({ name: 'x', rule_type: 'peak_hours', base_multiplier: 1.5 })).toMatch(/hour_from/);
  });

  it('rejects peak_days with empty days_of_week', () => {
    expect(validateFareRule({ name: 'x', rule_type: 'peak_days', base_multiplier: 1.5, days_of_week: [] })).toMatch(/days_of_week/i);
  });

  it('accepts valid class_multipliers', () => {
    expect(validateFareRule({ name: 'x', rule_type: 'always', base_multiplier: 1.0, class_multipliers: { vip: 2.0 } })).toBeNull();
  });
});
