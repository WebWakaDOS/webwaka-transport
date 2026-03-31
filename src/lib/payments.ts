/**
 * P08-T3: Payment utilities — Paystack refund initiation
 * All monetary values in kobo (integer). Non-fatal by design when called from cancel.
 */

import type { Env } from '../api/types';

/**
 * Initiate a Paystack refund for a completed transaction.
 * @param paymentReference  The original waka_* payment reference
 * @param amountKobo        Amount to refund in kobo (partial or full)
 * @param env               Worker environment (PAYSTACK_SECRET_KEY)
 * @returns refund reference string from Paystack
 * @throws on non-200 response or missing secret
 */
export async function initiatePaystackRefund(
  paymentReference: string,
  amountKobo: number,
  env: Env,
): Promise<string> {
  const secret = env.PAYSTACK_SECRET;
  if (!secret) throw new Error('PAYSTACK_SECRET not configured');

  const body: Record<string, unknown> = { transaction: paymentReference };
  if (amountKobo > 0) body.amount = amountKobo;

  const res = await fetch('https://api.paystack.co/refund', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.status.toString());
    throw new Error(`Paystack refund failed (${res.status}): ${errText}`);
  }

  const json = await res.json() as { data?: { reference?: string } };
  const ref = json?.data?.reference;
  if (!ref) throw new Error('Paystack refund response missing reference');
  return ref;
}
