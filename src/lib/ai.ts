/**
 * WebWaka AI — OpenRouter abstraction for natural language trip search
 *
 * Uses openai/gpt-4o-mini via OpenRouter for cost-effective inference.
 * Extracts structured trip search params from freeform Nigerian-English queries.
 *
 * Failure policy:
 *   All AI calls are non-fatal. If OpenRouter is down or returns garbage,
 *   the caller falls back to standard search. Never block the user's journey.
 *
 * Rate limiting: 5 AI calls / minute / IP enforced at the API handler level
 * via SESSIONS_KV (reuses the OTP rate-limiter pattern).
 *
 * OPENROUTER_API_KEY must be set as a Worker secret:
 *   wrangler secret put OPENROUTER_API_KEY --env production
 */

export interface AiTripSearchParams {
  origin?: string;
  destination?: string;
  date?: string;       // YYYY-MM-DD
  preference?: 'cheapest' | 'earliest' | 'latest' | 'any';
}

export interface AiEnv {
  OPENROUTER_API_KEY?: string;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';

// ============================================================
// Core: extract structured trip search params from freeform query
// ============================================================

export async function extractTripSearchParams(
  query: string,
  env: AiEnv
): Promise<AiTripSearchParams | null> {
  if (!env.OPENROUTER_API_KEY) {
    console.warn('[ai] OPENROUTER_API_KEY not configured — AI search unavailable');
    return null;
  }

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const systemPrompt = `You are a trip search assistant for WebWaka, a Nigerian bus transport platform.
Extract trip search parameters from user queries. Always respond with valid JSON only — no explanation.
Today's date is ${today}.

Nigerian cities include: Lagos, Abuja, Port Harcourt, Kano, Ibadan, Enugu, Owerri, Benin City, Kaduna, Jos, Ilorin, Warri, Onitsha, Aba, Calabar.

Respond with JSON in this exact format:
{
  "origin": "city name or null",
  "destination": "city name or null",
  "date": "YYYY-MM-DD or null",
  "preference": "cheapest | earliest | latest | any"
}

If the user mentions "tomorrow", use ${new Date(Date.now() + 86400000).toISOString().split('T')[0]}.
If no date is mentioned, use null.
If no preference is mentioned, use "any".`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://webwaka.ng',
        'X-Title': 'WebWaka Transport',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        temperature: 0,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => `HTTP ${response.status}`);
      throw new Error(`OpenRouter error: ${err}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';

    // Parse and validate the JSON response
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const params: AiTripSearchParams = {};

    if (typeof parsed['origin'] === 'string') params.origin = parsed['origin'];
    if (typeof parsed['destination'] === 'string') params.destination = parsed['destination'];
    if (typeof parsed['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed['date'])) {
      params.date = parsed['date'];
    }
    const pref = parsed['preference'];
    if (pref === 'cheapest' || pref === 'earliest' || pref === 'latest' || pref === 'any') {
      params.preference = pref;
    }

    return params;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ai] extractTripSearchParams failed: ${msg}`);
    return null;
  }
}

// ============================================================
// Public callOpenRouter utility (general purpose)
// ============================================================

export async function callOpenRouter(prompt: string, env: AiEnv): Promise<string> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://webwaka.ng',
      'X-Title': 'WebWaka Transport',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(`OpenRouter error: ${err}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
  };
  return data.choices?.[0]?.message?.content ?? '';
}
