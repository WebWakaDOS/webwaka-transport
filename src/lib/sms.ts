/**
 * WebWaka SMS Abstraction Layer
 * Supports Termii (Nigeria primary) and Africa's Talking (fallback).
 *
 * SMS_API_KEY format:
 *   termii:<api_key>          — Termii (recommended for Nigeria)
 *   at:<username>:<api_key>   — Africa's Talking
 *   <unset>                   — Dev mode: logs to console only
 *
 * Usage:
 *   const sms = buildSmsProvider(env);
 *   await sms.send('2348012345678', 'Your OTP is: 123456');
 *
 * Failure policy:
 *   SMS send failures are always non-fatal for OTP flow.
 *   The caller must handle errors explicitly.
 */

export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

// ============================================================
// Termii Provider — https://developers.termii.com
// ============================================================

class TermiiProvider implements SmsProvider {
  constructor(private readonly apiKey: string) {}

  async send(phone: string, message: string): Promise<void> {
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        to: phone,
        from: 'WebWaka',
        sms: message,
        type: 'plain',
        channel: 'generic',
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`Termii SMS failed: ${err}`);
    }

    const data = await res.json() as { message_id?: string; message?: string };
    if (!data.message_id) {
      throw new Error(`Termii SMS rejected: ${data.message ?? 'no message_id'}`);
    }
  }
}

// ============================================================
// Africa's Talking Provider — https://africastalking.com/sms
// ============================================================

class AfricasTalkingProvider implements SmsProvider {
  constructor(
    private readonly username: string,
    private readonly apiKey: string
  ) {}

  async send(phone: string, message: string): Promise<void> {
    const body = new URLSearchParams({
      username: this.username,
      to: phone,
      message,
    });

    const res = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'apiKey': this.apiKey,
        'Accept': 'application/json',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`Africa's Talking SMS failed: ${err}`);
    }

    const data = await res.json() as {
      SMSMessageData?: { Recipients?: Array<{ status: string; statusCode: number }> }
    };
    const recipients = data.SMSMessageData?.Recipients ?? [];
    const failed = recipients.filter(r => r.statusCode !== 101);
    if (failed.length > 0) {
      throw new Error(`Africa's Talking SMS failed for ${failed.length} recipients`);
    }
  }
}

// ============================================================
// Dev-mode provider (no API key configured)
// ============================================================

class DevSmsProvider implements SmsProvider {
  async send(phone: string, message: string): Promise<void> {
    console.warn(`[SMS/dev] Message queued (DEVELOPMENT MODE — no SMS provider configured). Length=${message.length}`);
  }
}

// ============================================================
// Factory
// ============================================================

export function buildSmsProvider(env: { SMS_API_KEY?: string; TERMII_API_KEY?: string }): SmsProvider {
  const key = env.SMS_API_KEY;

  if (key?.startsWith('termii:')) {
    return new TermiiProvider(key.slice(7));
  }

  // Accept bare TERMII_API_KEY as fallback (env.TERMII_API_KEY without prefix)
  if (!key && env.TERMII_API_KEY) {
    return new TermiiProvider(env.TERMII_API_KEY);
  }

  if (key?.startsWith('at:')) {
    // Format: at:<username>:<api_key>
    const rest = key.slice(3);
    const colonIdx = rest.indexOf(':');
    if (colonIdx > 0) {
      const username = rest.slice(0, colonIdx);
      const apiKey = rest.slice(colonIdx + 1);
      return new AfricasTalkingProvider(username, apiKey);
    }
  }

  // Unrecognised or missing key — dev/test mode
  return new DevSmsProvider();
}

// ============================================================
// sendSms — convenience wrapper (non-fatal by design)
// Callers must NOT propagate this error; SMS failures must
// never block the user booking journey.
// ============================================================

export async function sendSms(
  to: string,
  message: string,
  env: { SMS_API_KEY?: string; TERMII_API_KEY?: string },
): Promise<void> {
  if (!to) {
    console.warn('[sms] sendSms called with empty phone — skipping');
    return;
  }
  const provider = buildSmsProvider(env);
  try {
    await provider.send(to, message);
  } catch (err) {
    console.error('[sms] Send failed:', err instanceof Error ? err.message : err);
  }
}
