/**
 * WebWaka AI — Trip Search via webwaka-ai-platform
 *
 * Extracts structured trip search params from freeform Nigerian-English queries.
 * All AI calls route through webwaka-ai-platform (vendor-neutral gateway).
 * Env vars:
 *   AI_PLATFORM_URL   — https://webwaka-ai-platform.workers.dev
 *   AI_PLATFORM_TOKEN — service-to-service bearer token
 *
 * Failure policy: non-fatal — caller falls back to standard search on null.
 *
 * DO NOT call OpenRouter or any LLM provider directly from verticals.
 */

export interface AiTripSearchParams {
  origin?: string;
  destination?: string;
  date?: string;
  preference?: "cheapest" | "earliest" | "latest" | "any";
}

export interface AiEnv {
  AI_PLATFORM_URL?: string;
  AI_PLATFORM_TOKEN?: string;
}

export async function extractTripSearchParams(
  query: string,
  env: AiEnv
): Promise<AiTripSearchParams | null> {
  if (!env.AI_PLATFORM_URL || !env.AI_PLATFORM_TOKEN) {
    console.warn("[ai] AI_PLATFORM_URL/TOKEN not configured — AI search unavailable");
    return null;
  }

  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];

  const systemPrompt = `You are a trip search assistant for WebWaka, a Nigerian bus transport platform.
Extract trip search parameters from user queries. Always respond with valid JSON only — no explanation.
Today is ${today}.

Nigerian cities include: Lagos, Abuja, Port Harcourt, Kano, Ibadan, Enugu, Owerri, Benin City, Kaduna, Jos, Ilorin, Warri, Onitsha, Aba, Calabar.

Respond with JSON in this exact format:
{
  "origin": "city name or null",
  "destination": "city name or null",
  "date": "YYYY-MM-DD or null",
  "preference": "cheapest | earliest | latest | any"
}

If "tomorrow" is mentioned use ${tomorrow}. If no date, use null. If no preference, use "any".`;

  try {
    const response = await fetch(`${env.AI_PLATFORM_URL}/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.AI_PLATFORM_TOKEN}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query },
        ],
        max_tokens: 200,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) throw new Error(`AI platform HTTP ${response.status}`);

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const params: AiTripSearchParams = {};

    if (typeof parsed["origin"] === "string") params.origin = parsed["origin"];
    if (typeof parsed["destination"] === "string") params.destination = parsed["destination"];
    if (typeof parsed["date"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed["date"])) {
      params.date = parsed["date"];
    }
    const pref = parsed["preference"];
    if (pref === "cheapest" || pref === "earliest" || pref === "latest" || pref === "any") {
      params.preference = pref;
    }
    return params;
  } catch (err) {
    console.error(`[ai] extractTripSearchParams failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** General-purpose AI completion via webwaka-ai-platform. */
export async function callAIPlatform(
  env: AiEnv,
  prompt: string,
  systemPrompt?: string,
  maxTokens = 512
): Promise<string | null> {
  if (!env.AI_PLATFORM_URL || !env.AI_PLATFORM_TOKEN) return null;

  try {
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const res = await fetch(`${env.AI_PLATFORM_URL}/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.AI_PLATFORM_TOKEN}`,
      },
      body: JSON.stringify({ messages, max_tokens: maxTokens, temperature: 0.3 }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

