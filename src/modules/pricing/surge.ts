/**
 * WebWaka Transport — Dynamic Surge Pricing Engine
 *
 * Calculates surge multipliers based on:
 *   1. Real-time demand: ratio of active_riders to available_drivers in a zone.
 *   2. AI context: weather, time of day, local events via webwaka-ai-platform (vendor-neutral gateway).
 *   3. Configurable surge caps to prevent price gouging (Nigeria Consumer Protection).
 *
 * Design:
 *   - Pure async function: accepts db + env, returns multiplier + metadata.
 *   - AI call is non-fatal: falls back to demand-only multiplier on failure.
 *   - Snapshots are persisted to `surge_snapshots` for analytics + audit.
 *
 * Integration points:
 *   - Called by seat-inventory API before fare display.
 *   - Called by ride-hailing API before fare estimation.
 *   - Multiplier applied to base_fare (not stacked with FareRule engine for ride-hailing).
 *
 * Invariants: Nigeria-First, Non-Fatal AI, Audit-Ready
 */

import { getAICompletion, type AiEnv } from '../../lib/ai.js';

// QA-TRA-2: getAICompletion() is the certified AI completion function.
// callOpenRouter alias: routes all AI calls through webwaka-ai-platform. No direct provider calls.
const callOpenRouter = getAICompletion;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SurgeContext {
  zone_id: string;
  operator_id?: string;
  latitude?: number;
  longitude?: number;
}

export interface SurgeResult {
  zone_id: string;
  active_riders: number;
  available_drivers: number;
  demand_ratio: number;
  surge_multiplier: number;
  ai_context: AiSurgeContext | null;
  calculated_at: number;
}

export interface AiSurgeContext {
  time_of_day: string;
  day_of_week: string;
  weather_signal: string;
  rationale: string;
  recommended_multiplier: number;
}

export interface SurgeDb {
  prepare: (q: string) => {
    bind: (...args: unknown[]) => {
      first: <T>() => Promise<T | null>;
      run: () => Promise<unknown>;
    };
  };
}

// ── Surge configuration ───────────────────────────────────────────────────────

const SURGE_CONFIG = {
  minMultiplier: 1.0,
  maxMultiplier: 3.5,    // 3.5× cap — Nigeria Consumer Protection Commission compliance
  demandThresholds: [
    { ratio: 3.0, multiplier: 2.5 },
    { ratio: 2.0, multiplier: 2.0 },
    { ratio: 1.5, multiplier: 1.5 },
    { ratio: 1.2, multiplier: 1.25 },
    { ratio: 1.0, multiplier: 1.0 },
  ],
  aiWeightFactor: 0.3,   // blend: 70% demand ratio + 30% AI recommendation
} as const;

// ── Demand-based surge ────────────────────────────────────────────────────────

/**
 * Compute base surge multiplier from demand/supply ratio.
 * ratio = active_riders / available_drivers
 */
export function computeDemandSurge(activeRiders: number, availableDrivers: number): number {
  if (availableDrivers === 0) {
    // No drivers available: apply maximum surge to signal unavailability
    return availableDrivers === 0 && activeRiders > 0
      ? SURGE_CONFIG.maxMultiplier
      : SURGE_CONFIG.minMultiplier;
  }

  const ratio = activeRiders / availableDrivers;

  for (const threshold of SURGE_CONFIG.demandThresholds) {
    if (ratio >= threshold.ratio) {
      return threshold.multiplier;
    }
  }

  return SURGE_CONFIG.minMultiplier;
}

// ── AI-enhanced surge ─────────────────────────────────────────────────────────

/**
 * Call OpenRouter to factor in external variables:
 *   - Time of day (rush hour, late night, weekend)
 *   - Weather signals (rainy season → higher demand)
 *   - Nigerian public holidays & local events
 *
 * Returns null if AI is unavailable (non-fatal fallback).
 */
async function getAiSurgeContext(
  zone_id: string,
  baseMultiplier: number,
  env: AiEnv,
): Promise<AiSurgeContext | null> {
  const now = new Date();
  const hour = now.getUTCHours() + 1; // WAT = UTC+1
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOfWeek = dayNames[now.getUTCDay()] ?? 'Unknown';
  const timeOfDay =
    hour >= 6 && hour < 10 ? 'morning_rush' :
    hour >= 10 && hour < 16 ? 'midday' :
    hour >= 16 && hour < 20 ? 'evening_rush' :
    hour >= 20 && hour < 23 ? 'evening' : 'late_night';

  const month = now.getUTCMonth() + 1;
  const isRainySeason = month >= 4 && month <= 10;

  const prompt = `You are a surge pricing AI for WebWaka, a Nigerian transport platform.
Current context:
- Zone: ${zone_id}
- Time of day: ${timeOfDay} (WAT hour ${hour})
- Day: ${dayOfWeek}
- Season: ${isRainySeason ? 'rainy season (April-October)' : 'dry season'}
- Demand-based multiplier: ${baseMultiplier}x

Consider Nigerian-specific factors:
- Morning rush in Lagos/Abuja (6-9am) is extremely high demand
- Friday evenings have above-average demand (TGIF travel)
- Rainy season significantly increases ride demand (people avoid walking/okadas)
- Public holidays shift demand patterns dramatically
- Market days (Monday, Thursday in many cities) increase inter-city travel

Respond with JSON only:
{
  "time_of_day": "${timeOfDay}",
  "day_of_week": "${dayOfWeek}",
  "weather_signal": "dry|light_rain|heavy_rain|unknown",
  "rationale": "brief explanation in 1 sentence",
  "recommended_multiplier": <number between 1.0 and 3.5>
}`;

  try {
    const response = await callOpenRouter(prompt, env);
    const clean = response.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(clean) as Record<string, unknown>;

    const mult = Number(parsed['recommended_multiplier']);
    if (!Number.isFinite(mult) || mult < 1.0 || mult > SURGE_CONFIG.maxMultiplier) {
      throw new Error(`Invalid AI multiplier: ${mult}`);
    }

    return {
      time_of_day: String(parsed['time_of_day'] ?? timeOfDay),
      day_of_week: String(parsed['day_of_week'] ?? dayOfWeek),
      weather_signal: String(parsed['weather_signal'] ?? 'unknown'),
      rationale: String(parsed['rationale'] ?? ''),
      recommended_multiplier: mult,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[surge] AI context failed (non-fatal): ${msg}`);
    return null;
  }
}

// ── Main public function ──────────────────────────────────────────────────────

/**
 * Calculate effective surge multiplier for a zone.
 *
 * @param db      D1Database interface
 * @param env     Worker env (needs AI_PLATFORM_URL + AI_PLATFORM_TOKEN for AI features)
 * @param context Zone + optional operator scope
 * @returns       SurgeResult with multiplier and diagnostic metadata
 */
export async function calculateSurge(
  db: SurgeDb,
  env: AiEnv,
  context: SurgeContext,
): Promise<SurgeResult> {
  const now = Date.now();

  // 1. Count active riders (pending/matched ride requests in zone, last 10 min)
  const riderCutoff = now - 10 * 60 * 1000;
  let riderRow: { cnt: number } | null = null;
  try {
    riderRow = await db
      .prepare(`
        SELECT COUNT(*) as cnt FROM ride_requests
        WHERE status IN ('pending','matched')
          AND created_at >= ?
          ${context.operator_id ? 'AND operator_id = ?' : ''}
      `)
      .bind(...(context.operator_id ? [riderCutoff, context.operator_id] : [riderCutoff]))
      .first<{ cnt: number }>();
  } catch { /* table may not exist in all environments */ }

  const activeRiders = riderRow?.cnt ?? 0;

  // 2. Count available drivers in zone
  let driverRow: { cnt: number } | null = null;
  try {
    driverRow = await db
      .prepare(`
        SELECT COUNT(*) as cnt FROM active_drivers
        WHERE status = 'available'
          AND last_seen_at >= ?
          ${context.operator_id ? 'AND operator_id = ?' : ''}
      `)
      .bind(...(context.operator_id ? [now - 5 * 60 * 1000, context.operator_id] : [now - 5 * 60 * 1000]))
      .first<{ cnt: number }>();
  } catch { /* table may not exist */ }

  const availableDrivers = driverRow?.cnt ?? 0;

  // 3. Demand-based multiplier
  const demandMultiplier = computeDemandSurge(activeRiders, availableDrivers);
  const demandRatio = availableDrivers > 0 ? activeRiders / availableDrivers : activeRiders;

  // 4. AI-enhanced context (non-fatal)
  const aiContext = await getAiSurgeContext(context.zone_id, demandMultiplier, env);

  // 5. Blend: 70% demand + 30% AI (or 100% demand if AI failed)
  let finalMultiplier = demandMultiplier;
  if (aiContext) {
    finalMultiplier =
      demandMultiplier * (1 - SURGE_CONFIG.aiWeightFactor) +
      aiContext.recommended_multiplier * SURGE_CONFIG.aiWeightFactor;
  }

  // 6. Clamp to [min, max]
  finalMultiplier = Math.max(
    SURGE_CONFIG.minMultiplier,
    Math.min(SURGE_CONFIG.maxMultiplier, finalMultiplier),
  );
  finalMultiplier = Math.round(finalMultiplier * 10) / 10; // round to 1 decimal

  const result: SurgeResult = {
    zone_id: context.zone_id,
    active_riders: activeRiders,
    available_drivers: availableDrivers,
    demand_ratio: Math.round(demandRatio * 100) / 100,
    surge_multiplier: finalMultiplier,
    ai_context: aiContext,
    calculated_at: now,
  };

  // 7. Persist snapshot for analytics (non-fatal)
  try {
    const snapshotId = `surge_${now}_${Math.random().toString(36).slice(2, 7)}`;
    await db
      .prepare(`
        INSERT INTO surge_snapshots
          (id, zone_id, operator_id, active_riders, available_drivers, demand_ratio, surge_multiplier, ai_context, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        snapshotId,
        context.zone_id,
        context.operator_id ?? null,
        activeRiders,
        availableDrivers,
        result.demand_ratio,
        finalMultiplier,
        aiContext ? JSON.stringify(aiContext) : null,
        now,
      )
      .run();
  } catch { /* non-fatal — analytics should never block pricing */ }

  return result;
}

/**
 * Apply surge multiplier to a base fare (kobo).
 * Returns integer kobo value.
 */
export function applySurge(baseFareKobo: number, surgeMultiplier: number): number {
  return Math.round(baseFareKobo * surgeMultiplier);
}
