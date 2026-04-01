/**
 * WebWaka Transport — Central Management Ledger Event Publisher
 *
 * Publishes booking payment events to the webwaka-central-mgmt service
 * for double-entry ledger recording.
 *
 * Event types published:
 *   - transport.booking.confirmed  → triggered on successful booking payment
 *   - transport.booking.refunded   → triggered on booking refund
 *
 * Authentication: Authorization: Bearer {INTER_SERVICE_SECRET}
 *
 * Blueprint Reference: Part 10.1 (Central Management & Economics)
 * Added: 2026-04-01 — Remediation Issue #8 (missing transport→central-mgmt hook)
 */

interface CentralMgmtEnv {
  CENTRAL_MGMT_URL?: string;
  INTER_SERVICE_SECRET?: string;
}

interface LedgerEventPayload {
  event_type: string;
  aggregate_id: string;
  tenant_id?: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/**
 * Publish a ledger event to the central-mgmt service.
 * Non-fatal: failures are logged but do not block the calling transaction.
 *
 * @param env         Cloudflare Worker environment bindings
 * @param event       The ledger event to publish
 */
async function publishToLedger(env: CentralMgmtEnv, event: LedgerEventPayload): Promise<void> {
  const url = env.CENTRAL_MGMT_URL;
  const secret = env.INTER_SERVICE_SECRET;

  if (!url || !secret) {
    console.warn('[transport→central-mgmt] CENTRAL_MGMT_URL or INTER_SERVICE_SECRET not configured — skipping ledger event', {
      event_type: event.event_type,
      aggregate_id: event.aggregate_id,
    });
    return;
  }

  try {
    const res = await fetch(`${url}/events/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`,
      },
      body: JSON.stringify(event),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[transport→central-mgmt] Ledger event rejected', {
        status: res.status,
        event_type: event.event_type,
        aggregate_id: event.aggregate_id,
        response: text.slice(0, 200),
      });
    }
  } catch (err) {
    console.error('[transport→central-mgmt] Network error publishing ledger event', {
      event_type: event.event_type,
      aggregate_id: event.aggregate_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Notify central-mgmt of a confirmed booking payment.
 * Called after successful Paystack charge.success webhook processing.
 *
 * @param env           Worker environment
 * @param bookingId     Internal booking ID
 * @param tenantId      Tenant scoping
 * @param totalKobo     Total fare paid in kobo (integer)
 * @param paymentRef    Paystack payment reference
 */
export async function notifyBookingConfirmed(
  env: CentralMgmtEnv,
  bookingId: string,
  tenantId: string,
  totalKobo: number,
  paymentRef: string,
): Promise<void> {
  if (!Number.isInteger(totalKobo) || totalKobo <= 0) {
    console.warn('[transport→central-mgmt] Invalid totalKobo for booking.confirmed', { bookingId, totalKobo });
    return;
  }
  await publishToLedger(env, {
    event_type: 'transport.booking.confirmed',
    aggregate_id: bookingId,
    tenant_id: tenantId,
    payload: {
      booking_id: bookingId,
      tenant_id: tenantId,
      total_amount: totalKobo,
      payment_reference: paymentRef,
    },
    timestamp: Date.now(),
  });
}

/**
 * Notify central-mgmt of a booking refund.
 * Called after successful Paystack refund processing.
 *
 * @param env             Worker environment
 * @param bookingId       Internal booking ID
 * @param tenantId        Tenant scoping
 * @param refundKobo      Refund amount in kobo (integer)
 * @param paymentRef      Original Paystack payment reference
 */
export async function notifyBookingRefunded(
  env: CentralMgmtEnv,
  bookingId: string,
  tenantId: string,
  refundKobo: number,
  paymentRef: string,
): Promise<void> {
  if (!Number.isInteger(refundKobo) || refundKobo <= 0) {
    console.warn('[transport→central-mgmt] Invalid refundKobo for booking.refunded', { bookingId, refundKobo });
    return;
  }
  await publishToLedger(env, {
    event_type: 'transport.booking.refunded',
    aggregate_id: `ref_${bookingId}`,
    tenant_id: tenantId,
    payload: {
      booking_id: bookingId,
      tenant_id: tenantId,
      refund_amount_kobo: refundKobo,
      payment_reference: paymentRef,
    },
    timestamp: Date.now(),
  });
}
