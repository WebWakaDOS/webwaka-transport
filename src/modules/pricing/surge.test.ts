/**
 * Unit tests — Dynamic Surge Pricing Engine
 *
 * QA-TRA-2: getAICompletion() calculates surge multiplier based on
 * rider-to-driver ratio and external factors.
 *
 * Covers:
 *  - computeDemandSurge() at all demand thresholds
 *  - No-driver edge case (max surge)
 *  - AI-blend weighting (70% demand + 30% AI)
 *  - Surge cap enforcement (≤ maxMultiplier, QA-SEC-3 price gouging guard)
 *  - Surge floor enforcement (≥ 1.0)
 *  - Rounding to 1 decimal place
 *  - calculateSurge() happy path (mocked DB)
 *  - calculateSurge() fallback when AI unavailable
 *  - applySurge() kobo arithmetic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeDemandSurge, applySurge, calculateSurge, type SurgeDb } from './surge';
import type { AiEnv } from '../../lib/ai';

// ── computeDemandSurge ────────────────────────────────────────────────────────

describe('computeDemandSurge', () => {
  it('returns 1.0 when riders equal drivers (ratio = 1.0)', () => {
    expect(computeDemandSurge(5, 5)).toBe(1.0);
  });

  it('returns 1.0 when supply exceeds demand', () => {
    expect(computeDemandSurge(2, 10)).toBe(1.0);
  });

  it('returns 1.25 when ratio ≥ 1.2', () => {
    expect(computeDemandSurge(6, 5)).toBe(1.25); // ratio = 1.2
  });

  it('returns 1.5 when ratio ≥ 1.5', () => {
    expect(computeDemandSurge(9, 6)).toBe(1.5); // ratio = 1.5
  });

  it('returns 2.0 when ratio ≥ 2.0', () => {
    expect(computeDemandSurge(10, 5)).toBe(2.0); // ratio = 2.0
  });

  it('returns 2.5 when ratio ≥ 3.0', () => {
    expect(computeDemandSurge(15, 5)).toBe(2.5); // ratio = 3.0
  });

  it('applies maximum surge when 0 drivers available but riders present', () => {
    const result = computeDemandSurge(10, 0);
    expect(result).toBe(3.5); // maxMultiplier
  });

  it('returns 1.0 when both riders and drivers are 0', () => {
    const result = computeDemandSurge(0, 0);
    expect(result).toBe(1.0);
  });
});

// ── applySurge ────────────────────────────────────────────────────────────────

describe('applySurge', () => {
  it('returns base fare unchanged at 1.0 multiplier', () => {
    expect(applySurge(100_000, 1.0)).toBe(100_000);
  });

  it('doubles fare at 2.0 multiplier', () => {
    expect(applySurge(50_000, 2.0)).toBe(100_000);
  });

  it('correctly rounds fractional kobo results', () => {
    const result = applySurge(10_000, 1.25);
    expect(result).toBe(12_500);
  });

  it('never exceeds 3.5× the base fare (surge cap QA-SEC-3)', () => {
    const base = 100_000;
    // Even if called with 3.5× it should not produce more than 350_000
    expect(applySurge(base, 3.5)).toBeLessThanOrEqual(350_000);
  });

  it('works with kobo fractions (rounds to integer)', () => {
    const result = applySurge(10_001, 1.5);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ── calculateSurge ────────────────────────────────────────────────────────────

function makeSurgeDb(riderCount: number, driverCount: number): SurgeDb {
  return {
    prepare: (q: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async <T>() => {
          if (q.includes('ride_requests')) return { cnt: riderCount } as T;
          if (q.includes('active_drivers')) return { cnt: driverCount } as T;
          return null;
        },
        run: async () => undefined,
      }),
    }),
  };
}

const mockEnvNoAI = {} as AiEnv;
const mockEnvWithAI: AiEnv = {
  AI_PLATFORM_URL: 'https://ai.webwaka.test',
  AI_PLATFORM_TOKEN: 'test-bearer-token',
};

describe('calculateSurge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns multiplier of 1.0 when demand equals supply and no AI', async () => {
    const db = makeSurgeDb(5, 5);
    const result = await calculateSurge(db, mockEnvNoAI, { zone_id: 'lagos_island' });
    expect(result.surge_multiplier).toBe(1.0);
    expect(result.active_riders).toBe(5);
    expect(result.available_drivers).toBe(5);
  });

  it('returns multiplier > 1.0 when demand exceeds supply', async () => {
    const db = makeSurgeDb(15, 3); // ratio = 5.0
    const result = await calculateSurge(db, mockEnvNoAI, { zone_id: 'lekki' });
    expect(result.surge_multiplier).toBeGreaterThan(1.0);
  });

  it('never exceeds the 3.5× cap (QA-SEC-3 price gouging guard)', async () => {
    const db = makeSurgeDb(1000, 1); // extreme demand
    const result = await calculateSurge(db, mockEnvNoAI, { zone_id: 'vi' });
    expect(result.surge_multiplier).toBeLessThanOrEqual(3.5);
  });

  it('always returns multiplier ≥ 1.0 (floor)', async () => {
    const db = makeSurgeDb(0, 100); // no demand
    const result = await calculateSurge(db, mockEnvNoAI, { zone_id: 'apapa' });
    expect(result.surge_multiplier).toBeGreaterThanOrEqual(1.0);
  });

  it('multiplier is rounded to 1 decimal place', async () => {
    const db = makeSurgeDb(9, 6); // ratio = 1.5 → demand multiplier 1.5
    const result = await calculateSurge(db, mockEnvNoAI, { zone_id: 'surulere' });
    const asStr = String(result.surge_multiplier);
    const decimals = asStr.includes('.') ? asStr.split('.')[1]!.length : 0;
    expect(decimals).toBeLessThanOrEqual(1);
  });

  it('blends AI recommendation when AI succeeds (70/30 blend)', async () => {
    const db = makeSurgeDb(10, 5); // demand ratio = 2.0 → demand multiplier = 2.0
    const aiMult = 3.0;

    // Mock fetch to return a valid AI response
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              time_of_day: 'morning_rush',
              day_of_week: 'Monday',
              weather_signal: 'heavy_rain',
              rationale: 'Lagos Monday morning rush with heavy rain',
              recommended_multiplier: aiMult,
            }),
          },
        }],
      }),
    }));

    const result = await calculateSurge(db, mockEnvWithAI, { zone_id: 'lagos_mainland' });

    // Expected: 2.0 * 0.7 + 3.0 * 0.3 = 1.4 + 0.9 = 2.3
    // Rounded to 1dp → 2.3
    const expected = Math.round((2.0 * 0.7 + aiMult * 0.3) * 10) / 10;
    expect(result.surge_multiplier).toBe(expected);
    expect(result.ai_context).not.toBeNull();
    expect(result.ai_context?.recommended_multiplier).toBe(aiMult);
  });

  it('falls back to demand-only multiplier when AI fails (non-fatal)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const db = makeSurgeDb(10, 5); // demand multiplier = 2.0
    const result = await calculateSurge(db, mockEnvWithAI, { zone_id: 'oshodi' });

    expect(result.surge_multiplier).toBe(2.0);
    expect(result.ai_context).toBeNull();
  });

  it('falls back gracefully when AI returns invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
    }));

    const db = makeSurgeDb(9, 6);
    const result = await calculateSurge(db, mockEnvWithAI, { zone_id: 'ikeja' });

    expect(result.surge_multiplier).toBeGreaterThanOrEqual(1.0);
    expect(result.ai_context).toBeNull();
  });

  it('includes demand_ratio in result', async () => {
    const db = makeSurgeDb(10, 4); // ratio = 2.5
    const result = await calculateSurge(db, mockEnvNoAI, { zone_id: 'victoria_island' });
    expect(result.demand_ratio).toBeCloseTo(2.5, 1);
  });

  it('includes zone_id and calculated_at in result', async () => {
    const before = Date.now();
    const db = makeSurgeDb(5, 5);
    const result = await calculateSurge(db, mockEnvNoAI, { zone_id: 'yaba' });
    expect(result.zone_id).toBe('yaba');
    expect(result.calculated_at).toBeGreaterThanOrEqual(before);
  });

  it('rejects AI recommended_multiplier outside valid range (too high)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ recommended_multiplier: 99.0, rationale: 'x', time_of_day: 'day', day_of_week: 'Mon', weather_signal: 'dry' }) } }],
      }),
    }));

    const db = makeSurgeDb(5, 5);
    const result = await calculateSurge(db, mockEnvWithAI, { zone_id: 'gbagada' });

    // AI rejected → fall back to demand-only
    expect(result.ai_context).toBeNull();
    expect(result.surge_multiplier).toBe(1.0);
  });
});
