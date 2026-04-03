/**
 * T-TRN-04: PaystackInlineCheckout — Paystack Inline Popup Component
 * Eliminates redirect-to-external-page drop-off on Nigerian mobile networks.
 *
 * Flow:
 *  1. User taps "Pay with Paystack"
 *  2. Component calls POST /api/payments/initiate → gets access_code
 *  3. In dev mode (no PAYSTACK_SECRET on server) → calls /verify directly (no popup)
 *  4. In prod mode → loads Paystack inline script → opens PaystackPop modal
 *  5. On popup success callback → calls POST /api/payments/verify
 *  6. Calls onSuccess(bookingId) so parent can refresh booking state
 *
 * Invariants:
 *  - Nigeria-First: Paystack is the primary gateway; dev-mode always available
 *  - Offline-First: fails gracefully with clear error messages; no silent fallbacks
 *  - NDPR: no PII logged; no tokens persisted beyond the component lifecycle
 */
import React, { useState, useCallback } from 'react';
import { api, ApiError } from '../api/client';

declare global {
  interface Window {
    PaystackPop?: {
      setup(config: PaystackSetupConfig): { openIframe(): void };
    };
  }
}

interface PaystackSetupConfig {
  key: string;
  email: string;
  amount: number;
  access_code?: string;
  onClose(): void;
  callback(response: { reference: string; status: string }): void;
}

export interface PaystackInlineCheckoutProps {
  bookingId: string;
  email?: string;
  amountKobo: number;
  onSuccess(bookingId: string): void;
  onCancel?(): void;
}

function loadPaystackScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') { reject(new Error('Not a browser environment')); return; }
    if (window.PaystackPop) { resolve(); return; }

    // Timeout safety — covers the case where the script element exists but its `load`
    // event already fired (ad blocker, partial load) and new listeners will never fire,
    // leaving the Promise permanently pending.
    const timer = setTimeout(() => {
      reject(new Error('Payment provider took too long to load. Please refresh and try again.'));
    }, 10_000);
    const done = (fn: () => void) => { clearTimeout(timer); fn(); };

    const existing = document.getElementById('paystack-inline-js');
    if (existing) {
      existing.addEventListener('load', () => done(resolve));
      existing.addEventListener('error', () => done(() => reject(new Error('Paystack script failed to load'))));
      return;
    }
    const script = document.createElement('script');
    script.id = 'paystack-inline-js';
    script.src = 'https://js.paystack.co/v1/inline.js';
    script.async = true;
    script.onload = () => done(resolve);
    script.onerror = () => done(() => reject(new Error('Failed to load Paystack. Check your connection.')));
    document.head.appendChild(script);
  });
}

export function PaystackInlineCheckout({
  bookingId,
  email,
  amountKobo,
  onSuccess,
  onCancel,
}: PaystackInlineCheckoutProps) {
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');

  const handlePay = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const customerEmail = email ?? `${bookingId}@pay.webwaka.ng`;
      const initData = await api.initiatePayment(bookingId, customerEmail);

      if (initData.dev_mode) {
        setLoading(false);
        setVerifying(true);
        const verifyData = await api.verifyPayment({ booking_id: bookingId });
        onSuccess(verifyData.booking_id);
        return;
      }

      if (!initData.access_code) {
        setError('Payment session could not be created. Please try again.');
        return;
      }

      await loadPaystackScript();

      if (!window.PaystackPop) {
        setError('Payment provider is unavailable. Please refresh the page and try again.');
        return;
      }

      const publicKey = (typeof import.meta !== 'undefined'
        ? (import.meta as { env?: Record<string, string> }).env?.['VITE_PAYSTACK_PUBLIC_KEY']
        : undefined) ?? 'pk_test_placeholder';

      setLoading(false);

      const handler = window.PaystackPop.setup({
        key: publicKey,
        email: customerEmail,
        amount: amountKobo,
        access_code: initData.access_code,
        onClose: () => {
          onCancel?.();
        },
        callback: (response) => {
          if (response.status !== 'success') {
            setError('Payment was not completed. You can try again.');
            return;
          }
          setVerifying(true);
          api.verifyPayment({ reference: response.reference, booking_id: bookingId })
            .then((verifyData) => { onSuccess(verifyData.booking_id); })
            .catch((e: unknown) => {
              const msg = e instanceof ApiError ? e.message : 'Verification failed. Contact support with your reference.';
              setError(msg);
              setVerifying(false);
            });
        },
      });

      handler.openIframe();
    } catch (e: unknown) {
      const msg = e instanceof ApiError ? e.message : (e instanceof Error ? e.message : 'Failed to open payment. Please try again.');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [bookingId, email, amountKobo, onSuccess, onCancel]);

  const isDisabled = loading || verifying;

  return (
    <div style={{ marginTop: 12 }}>
      {error && (
        <div style={{
          padding: '8px 12px',
          background: '#fee2e2',
          color: '#b91c1c',
          borderRadius: 8,
          fontSize: 13,
          marginBottom: 10,
          lineHeight: 1.4,
        }}>
          {error}
        </div>
      )}
      <button
        onClick={() => { void handlePay(); }}
        disabled={isDisabled}
        style={{
          width: '100%',
          padding: '12px 0',
          borderRadius: 10,
          border: 'none',
          background: isDisabled ? '#94a3b8' : '#0ea5e9',
          color: '#fff',
          fontWeight: 700,
          fontSize: 15,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          letterSpacing: 0.3,
          transition: 'background 0.15s',
        }}
      >
        {verifying ? 'Confirming payment…' : loading ? 'Opening payment…' : 'Pay with Paystack'}
      </button>
    </div>
  );
}
