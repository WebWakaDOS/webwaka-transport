/**
 * BookingFlow — TRN-3 Complete Booking Journey
 * Trip → SeatMap → Customer + NDPR → Payment → Ticket
 * Invariants: NDPR enforced, Nigeria-First (kobo), Offline-First (errors surfaced)
 */
import React, { useState, useCallback } from 'react';
import { SeatMap } from './seat-map';
import { api, ApiError } from '../api/client';
import type { TripSummary, Booking } from '../api/client';
import { formatKoboToNaira } from '../core/i18n/index';
import { useAuth } from '../core/auth/context';

type Step = 'seats' | 'customer' | 'confirm' | 'ticket';

const PAYMENT_METHODS = [
  { id: 'paystack', label: 'Card / Paystack', icon: '💳' },
  { id: 'mobile_money', label: 'Mobile Money', icon: '📱' },
  { id: 'bank_transfer', label: 'Bank Transfer', icon: '🏦' },
];

// ============================================================
// Step 2: Seat Selection
// ============================================================
function StepSeats({ trip, onNext, onBack }: {
  trip: TripSummary;
  onNext: (selectedSeats: string[]) => void;
  onBack: () => void;
}) {
  const [selectedSeats, setSelectedSeats] = useState<string[]>([]);

  const toggle = useCallback((seatId: string) => {
    setSelectedSeats(prev =>
      prev.includes(seatId) ? prev.filter(s => s !== seatId) : [...prev, seatId]
    );
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{trip.origin} → {trip.destination}</div>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            {new Date(trip.departure_time).toLocaleString('en-NG')} · {trip.operator_name}
          </div>
        </div>
        <div style={{ fontWeight: 800, color: '#16a34a', fontSize: 16 }}>
          {formatKoboToNaira(trip.base_fare)}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Choose your seat</h3>
        <SeatMap tripId={trip.id} selectedSeats={selectedSeats} onToggle={toggle} maxSelectable={4} />
      </div>

      {selectedSeats.length > 0 && (
        <div style={{ padding: '12px 16px', background: '#f8fafc', borderRadius: 10, marginBottom: 12, border: '1.5px solid #e2e8f0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b', fontSize: 13 }}>
              {selectedSeats.length} seat{selectedSeats.length > 1 ? 's' : ''}
            </span>
            <span style={{ fontWeight: 800, color: '#1e40af', fontSize: 15 }}>
              {formatKoboToNaira(trip.base_fare * selectedSeats.length)}
            </span>
          </div>
        </div>
      )}

      <button
        onClick={() => onNext(selectedSeats)}
        disabled={selectedSeats.length === 0}
        style={{ ...primaryBtnStyle, width: '100%', opacity: selectedSeats.length === 0 ? 0.4 : 1 }}
      >
        Continue ({selectedSeats.length} seat{selectedSeats.length !== 1 ? 's' : ''})
      </button>
    </div>
  );
}

// ============================================================
// Step 3: Customer details + NDPR consent
// ============================================================
function StepCustomer({ onNext, onBack }: {
  onNext: (customerId: string, passengerNames: string[]) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [ndprConsent, setNdprConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!name.trim() || !phone.trim()) { setError('Name and phone are required'); return; }
    if (!ndprConsent) { setError('You must accept the privacy policy to continue'); return; }
    const phoneClean = phone.replace(/\D/g, '');
    if (phoneClean.length < 10) { setError('Enter a valid Nigerian phone number'); return; }

    setSaving(true);
    setError('');
    try {
      const emailTrimmed = email.trim();
      const customer = await api.registerCustomer({
        name: name.trim(),
        phone: phoneClean,
        ndpr_consent: true,
        ...(emailTrimmed ? { email: emailTrimmed } : {}),
      });
      onNext(customer.id, [name.trim()]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Registration failed. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h3 style={{ margin: 0, fontSize: 16 }}>Your details</h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={labelStyle}>Full name *</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Emeka Okafor"
            style={inputStyle}
            autoComplete="name"
          />
        </div>
        <div>
          <label style={labelStyle}>Phone number *</label>
          <input
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="e.g. 08012345678"
            style={inputStyle}
            type="tel"
            autoComplete="tel"
          />
        </div>
        <div>
          <label style={labelStyle}>Email (optional)</label>
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={inputStyle}
            type="email"
            autoComplete="email"
          />
        </div>

        <div style={{
          padding: '12px 14px', background: '#fefce8', borderRadius: 10,
          border: '1.5px solid #fde68a', marginTop: 4,
        }}>
          <label style={{ display: 'flex', gap: 10, cursor: 'pointer', alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={ndprConsent}
              onChange={e => setNdprConsent(e.target.checked)}
              style={{ marginTop: 2, flexShrink: 0, accentColor: '#1e40af', width: 16, height: 16 }}
            />
            <span style={{ fontSize: 12, lineHeight: 1.5, color: '#78350f' }}>
              <strong>NDPR Consent Required.</strong> I consent to WebWaka collecting and
              processing my personal data (name, phone, email) for the purpose of transport
              booking services, in accordance with Nigeria's Data Protection Regulation (NDPR).
            </span>
          </label>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>
            {error}
          </div>
        )}

        <button
          onClick={() => void handleSubmit()}
          disabled={saving || !ndprConsent}
          style={{ ...primaryBtnStyle, width: '100%', opacity: saving || !ndprConsent ? 0.5 : 1 }}
        >
          {saving ? 'Registering…' : 'Continue to payment'}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Step 4: Payment method + booking confirmation
// Phase 1: Choose method + click Pay → createBooking → initiatePayment
//   • dev mode / non-paystack method: auto-verifies → ticket
//   • prod + paystack: opens authorization_url, shows "I've paid" button
// Phase 2: "I've completed payment" → verifyPayment → ticket
// ============================================================
type AwaitingPayment = { reference: string; bookingId: string; booking: Booking };

function StepConfirm({ trip, selectedSeats, customerId, passengerNames, onSuccess, onBack }: {
  trip: TripSummary;
  selectedSeats: string[];
  customerId: string;
  passengerNames: string[];
  onSuccess: (booking: Booking) => void;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const [paymentMethod, setPaymentMethod] = useState('paystack');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [awaiting, setAwaiting] = useState<AwaitingPayment | null>(null);

  const totalKobo = trip.base_fare * selectedSeats.length;

  // Derive a payment email from the user's phone (Paystack requires email)
  const payEmail = user?.phone
    ? `${user.phone.replace(/\D/g, '')}@pay.webwaka.ng`
    : `booking@pay.webwaka.ng`;

  /** Phase 1: create booking → initiate payment */
  const handlePay = async () => {
    setBusy(true);
    setError('');
    try {
      const booking = await api.createBooking({
        customer_id: customerId,
        trip_id: trip.id,
        seat_ids: selectedSeats,
        passenger_names: passengerNames,
        payment_method: paymentMethod,
        ndpr_consent: true,
      });

      const init = await api.initiatePayment(booking.id, payEmail);

      // Dev mode or non-Paystack method: skip redirect, auto-verify immediately
      if (init.dev_mode || paymentMethod !== 'paystack') {
        const verify = await api.verifyPayment({ booking_id: booking.id });
        if (verify.booking_status !== 'confirmed') {
          throw new Error('Payment verification failed — please try again.');
        }
        onSuccess({
          ...booking,
          status: 'confirmed',
          payment_status: 'completed',
          origin: trip.origin,
          destination: trip.destination,
          departure_time: trip.departure_time,
          operator_name: trip.operator_name,
        });
        return;
      }

      // Prod mode: open Paystack checkout in a new tab, show "I've paid" button
      if (init.authorization_url) {
        window.open(init.authorization_url, '_blank', 'noopener,noreferrer');
      }
      setAwaiting({ reference: init.reference, bookingId: booking.id, booking });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Booking failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  /** Phase 2: user returns from Paystack → verify + confirm */
  const handleVerify = async () => {
    if (!awaiting) return;
    setBusy(true);
    setError('');
    try {
      const verify = await api.verifyPayment({ reference: awaiting.reference });
      if (verify.booking_status !== 'confirmed') {
        throw new Error('Payment not yet confirmed. Please complete the payment and try again.');
      }
      onSuccess({
        ...awaiting.booking,
        status: 'confirmed',
        payment_status: 'completed',
        origin: trip.origin,
        destination: trip.destination,
        departure_time: trip.departure_time,
        operator_name: trip.operator_name,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Verification failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // ── Awaiting payment phase ───────────────────────────────────
  if (awaiting) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{
          textAlign: 'center', padding: '28px 16px 20px',
          background: '#fffbeb', borderRadius: 16, border: '2px solid #f59e0b', marginBottom: 20,
        }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🔐</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#92400e', marginBottom: 6 }}>
            Complete payment on Paystack
          </div>
          <div style={{ fontSize: 13, color: '#78350f' }}>
            A Paystack checkout tab was opened. Complete your payment there, then come back here.
          </div>
        </div>

        <div style={{ background: '#f8fafc', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: '#475569', marginBottom: 20 }}>
          <div><strong>Amount:</strong> {formatKoboToNaira(totalKobo)}</div>
          <div style={{ marginTop: 4, wordBreak: 'break-all' }}>
            <strong>Reference:</strong> <code style={{ fontSize: 11 }}>{awaiting.reference}</code>
          </div>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <button
          onClick={() => void handleVerify()}
          disabled={busy}
          style={{ ...primaryBtnStyle, width: '100%', opacity: busy ? 0.6 : 1, marginBottom: 10 }}
        >
          {busy ? 'Verifying…' : "I've completed payment"}
        </button>

        <button
          onClick={() => window.open(`https://checkout.paystack.com`, '_blank', 'noopener,noreferrer')}
          style={{ ...primaryBtnStyle, width: '100%', background: '#fff', color: '#2563eb', border: '1.5px solid #2563eb' }}
        >
          Re-open Paystack
        </button>
      </div>
    );
  }

  // ── Payment method selection phase ──────────────────────────
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h3 style={{ margin: 0, fontSize: 16 }}>Confirm booking</h3>
      </div>

      {/* Booking summary */}
      <div style={{ ...cardStyle, marginBottom: 16, cursor: 'default' }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>
          {trip.origin} → {trip.destination}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#475569' }}>
          <div>🗓️ {new Date(trip.departure_time).toLocaleString('en-NG')}</div>
          <div>🚌 {trip.operator_name}</div>
          <div>💺 {selectedSeats.length} seat{selectedSeats.length > 1 ? 's' : ''}</div>
          <div style={{ marginTop: 4, fontSize: 20, fontWeight: 800, color: '#16a34a' }}>
            {formatKoboToNaira(totalKobo)}
          </div>
        </div>
      </div>

      {/* Payment method selector */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
          Payment method
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {PAYMENT_METHODS.map(pm => (
            <label key={pm.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 14px', borderRadius: 10, border: '1.5px solid',
              borderColor: paymentMethod === pm.id ? '#2563eb' : '#e2e8f0',
              background: paymentMethod === pm.id ? '#eff6ff' : '#fff',
              cursor: 'pointer',
            }}>
              <input
                type="radio"
                name="payment_method"
                value={pm.id}
                checked={paymentMethod === pm.id}
                onChange={() => setPaymentMethod(pm.id)}
                style={{ accentColor: '#2563eb' }}
              />
              <span style={{ fontSize: 18 }}>{pm.icon}</span>
              <span style={{ fontSize: 14, fontWeight: paymentMethod === pm.id ? 700 : 400 }}>{pm.label}</span>
            </label>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <button
        onClick={() => void handlePay()}
        disabled={busy}
        style={{ ...primaryBtnStyle, width: '100%', opacity: busy ? 0.6 : 1 }}
      >
        {busy ? 'Processing…' : `Pay ${formatKoboToNaira(totalKobo)}`}
      </button>

      <p style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', marginTop: 10 }}>
        Payment is processed securely via Paystack · Subject to NDPR
      </p>
    </div>
  );
}

// ============================================================
// Step 5: Booking ticket (success state)
// ============================================================
function TicketView({ booking, onDone }: { booking: Booking; onDone: () => void }) {
  return (
    <div style={{ padding: 16 }}>
      <div style={{
        textAlign: 'center', padding: '24px 16px 16px',
        background: '#f0fdf4', borderRadius: 16, border: '2px solid #16a34a', marginBottom: 16,
      }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#15803d', marginBottom: 4 }}>
          Booking Confirmed!
        </div>
        <div style={{ fontSize: 13, color: '#64748b' }}>
          Your seat{(booking.seat_ids as unknown as string[]).length > 1 ? 's are' : ' is'} secured
        </div>
      </div>

      <div style={{ ...cardStyle, cursor: 'default' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: 1, marginBottom: 12 }}>
          BOOKING TICKET
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <TicketRow icon="🛣️" label="Route" value={`${booking.origin ?? ''} → ${booking.destination ?? ''}`} />
          <TicketRow
            icon="🗓️"
            label="Departure"
            value={booking.departure_time
              ? new Date(booking.departure_time).toLocaleString('en-NG')
              : '—'
            }
          />
          <TicketRow icon="🚌" label="Operator" value={booking.operator_name ?? '—'} />
          <TicketRow
            icon="💺"
            label="Seats"
            value={`${(booking.seat_ids as unknown as string[]).length} seat${(booking.seat_ids as unknown as string[]).length > 1 ? 's' : ''}`}
          />
          <TicketRow icon="💳" label="Payment" value={booking.payment_method} />
          <TicketRow
            icon="₦"
            label="Total paid"
            value={formatKoboToNaira(booking.total_amount)}
            highlight
          />
        </div>

        <div style={{
          marginTop: 16, padding: '10px 12px', background: '#f8fafc', borderRadius: 8,
          border: '1px dashed #e2e8f0',
        }}>
          <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>BOOKING REF</div>
          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: '#1e40af', marginTop: 2 }}>
            {booking.id}
          </div>
        </div>
      </div>

      <button onClick={onDone} style={{ ...primaryBtnStyle, width: '100%', marginTop: 16 }}>
        Book another trip
      </button>
    </div>
  );
}

function TicketRow({ icon, label, value, highlight }: {
  icon: string; label: string; value: string; highlight?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 13, color: '#64748b' }}>{icon} {label}</span>
      <span style={{
        fontSize: 13, fontWeight: highlight ? 800 : 600,
        color: highlight ? '#16a34a' : '#1e293b',
      }}>{value}</span>
    </div>
  );
}

// ============================================================
// Main BookingFlow orchestrator
// ============================================================
interface BookingFlowProps {
  trip: TripSummary;
  onBack: () => void;
}

export function BookingFlow({ trip, onBack }: BookingFlowProps) {
  const [step, setStep] = useState<Step>('seats');
  const [selectedSeats, setSelectedSeats] = useState<string[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [passengerNames, setPassengerNames] = useState<string[]>([]);
  const [confirmedBooking, setConfirmedBooking] = useState<Booking | null>(null);

  const handleSeatsDone = (seats: string[]) => {
    setSelectedSeats(seats);
    setStep('customer');
  };

  const handleCustomerDone = (custId: string, names: string[]) => {
    setCustomerId(custId);
    setPassengerNames(names);
    setStep('confirm');
  };

  const handleBookingSuccess = (booking: Booking) => {
    setConfirmedBooking(booking);
    setStep('ticket');
  };

  const handleReset = () => {
    setStep('seats');
    setSelectedSeats([]);
    setCustomerId('');
    setPassengerNames([]);
    setConfirmedBooking(null);
    onBack();
  };

  if (step === 'seats') {
    return (
      <StepSeats
        trip={trip}
        onNext={handleSeatsDone}
        onBack={onBack}
      />
    );
  }

  if (step === 'customer') {
    return (
      <StepCustomer
        onNext={handleCustomerDone}
        onBack={() => setStep('seats')}
      />
    );
  }

  if (step === 'confirm') {
    return (
      <StepConfirm
        trip={trip}
        selectedSeats={selectedSeats}
        customerId={customerId}
        passengerNames={passengerNames}
        onSuccess={handleBookingSuccess}
        onBack={() => setStep('customer')}
      />
    );
  }

  if (step === 'ticket' && confirmedBooking) {
    return <TicketView booking={confirmedBooking} onDone={handleReset} />;
  }

  return null;
}

// ============================================================
// Shared styles
// ============================================================
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px', borderRadius: 10,
  border: '1.5px solid #e2e8f0', fontSize: 15, background: '#fff',
  boxSizing: 'border-box', marginTop: 4,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: '#374151', display: 'block',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '14px 20px', borderRadius: 10, border: 'none',
  background: '#1e40af', color: '#fff', fontWeight: 700, fontSize: 15,
  cursor: 'pointer', minHeight: 48,
};

const backBtnStyle: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 8, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13, cursor: 'pointer',
};

const cardStyle: React.CSSProperties = {
  background: '#fff', borderRadius: 12, padding: 14, marginBottom: 10,
  border: '1.5px solid #e2e8f0',
};
