/**
 * ticket.tsx — P03-T5 E-Ticket Page
 * Public page rendered at /b/:bookingId
 * Fetches confirmed booking JSON from GET /b/:bookingId/data
 * Displays passenger/trip info + QR code
 * No auth required; booking must be in 'confirmed' status
 */
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface BookingData {
  id: string;
  customer_id: string;
  trip_id: string;
  seat_ids: string;
  passenger_names: string;
  total_amount: number;
  status: string;
  payment_status: string;
  payment_reference: string;
  confirmed_at: number | null;
  created_at: number;
  departure_time: number | null;
  origin: string;
  destination: string;
  operator_name: string;
}

interface TicketPageProps {
  bookingId: string;
}

function formatNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-NG', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

export function TicketPage({ bookingId }: TicketPageProps) {
  const [booking, setBooking] = useState<BookingData | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/b/${bookingId}/data`);
        const json = await res.json() as { success: boolean; data?: BookingData; error?: string };
        if (!json.success || !json.data) {
          setError(json.error ?? 'Booking not found or not confirmed yet.');
          return;
        }
        const bk = json.data;
        if (!cancelled) setBooking(bk);

        // Generate QR code encoding the booking ID + reference
        const qrPayload = JSON.stringify({
          id: bk.id,
          ref: bk.payment_reference,
          trip: bk.trip_id,
        });
        const dataUrl = await QRCode.toDataURL(qrPayload, { width: 220, margin: 1 });
        if (!cancelled) setQrDataUrl(dataUrl);
      } catch {
        if (!cancelled) setError('Failed to load booking. Check your connection and try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [bookingId]);

  if (loading) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <p style={{ textAlign: 'center', color: '#64748b', fontSize: 16 }}>Loading your ticket…</p>
        </div>
      </div>
    );
  }

  if (error || !booking) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <h2 style={{ color: '#dc2626', margin: '0 0 12px' }}>Ticket Not Found</h2>
          <p style={{ color: '#64748b', fontSize: 15 }}>{error || 'Booking not found.'}</p>
          <p style={{ color: '#64748b', fontSize: 14, marginTop: 8 }}>
            Make sure the link is correct. Only confirmed bookings have e-tickets.
          </p>
        </div>
      </div>
    );
  }

  let seatIds: string[] = [];
  let passengerNames: string[] = [];
  try { seatIds = JSON.parse(booking.seat_ids) as string[]; } catch { seatIds = []; }
  try { passengerNames = JSON.parse(booking.passenger_names) as string[]; } catch { passengerNames = []; }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#1e40af', letterSpacing: '-0.5px' }}>
            WebWaka
          </div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>E-Ticket / Boarding Pass</div>
        </div>

        {/* Status badge */}
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <span style={{
            display: 'inline-block', padding: '4px 16px', borderRadius: 20,
            background: '#dcfce7', color: '#16a34a', fontWeight: 700, fontSize: 13,
          }}>
            ✓ CONFIRMED
          </span>
        </div>

        {/* Route */}
        <div style={routeRow}>
          <div style={routeCity}>{booking.origin}</div>
          <div style={{ color: '#94a3b8', fontSize: 20, padding: '0 8px' }}>→</div>
          <div style={routeCity}>{booking.destination}</div>
        </div>

        <div style={{ textAlign: 'center', color: '#64748b', fontSize: 14, marginBottom: 20 }}>
          {booking.operator_name}
        </div>

        {/* Divider */}
        <hr style={{ border: 'none', borderTop: '1.5px dashed #e2e8f0', margin: '0 0 20px' }} />

        {/* Trip info */}
        <div style={infoGrid}>
          <InfoRow label="Departure" value={formatDate(booking.departure_time)} />
          <InfoRow label="Booking ID" value={booking.id} mono />
          <InfoRow label="Payment Ref" value={booking.payment_reference} mono />
          <InfoRow label="Amount Paid" value={formatNaira(booking.total_amount)} />
          <InfoRow label="Seats" value={`${seatIds.length} seat${seatIds.length !== 1 ? 's' : ''}`} />
          {booking.confirmed_at && (
            <InfoRow label="Confirmed At" value={formatDate(booking.confirmed_at)} />
          )}
        </div>

        {/* Passengers */}
        {passengerNames.length > 0 && (
          <>
            <hr style={{ border: 'none', borderTop: '1.5px dashed #e2e8f0', margin: '20px 0' }} />
            <div style={{ marginBottom: 16 }}>
              <div style={sectionLabel}>Passengers</div>
              {passengerNames.map((name, i) => (
                <div key={i} style={{ fontSize: 15, color: '#1e293b', padding: '4px 0' }}>
                  {i + 1}. {name}
                </div>
              ))}
            </div>
          </>
        )}

        {/* QR Code */}
        <hr style={{ border: 'none', borderTop: '1.5px dashed #e2e8f0', margin: '20px 0' }} />
        <div style={{ textAlign: 'center' }}>
          <div style={sectionLabel}>Scan at the gate</div>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={`QR code for booking ${bookingId}`}
              style={{ width: 180, height: 180, marginTop: 8 }}
            />
          ) : (
            <div style={{ width: 180, height: 180, margin: '8px auto', background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>
              QR unavailable
            </div>
          )}
          <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>
            Present this ticket at the bus park boarding gate.
          </p>
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: '#cbd5e1' }}>
          WebWaka Transport Suite · Nigeria Intercity
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f1f5f9' }}>
      <span style={{ color: '#64748b', fontSize: 13 }}>{label}</span>
      <span style={{ color: '#1e293b', fontSize: 13, fontWeight: 600, fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all', textAlign: 'right', maxWidth: '60%' }}>
        {value}
      </span>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: 'linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '32px 16px 64px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const cardStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 20,
  boxShadow: '0 4px 24px rgba(30,64,175,0.10)',
  padding: '32px 28px',
  width: '100%',
  maxWidth: 480,
};

const routeRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  marginBottom: 8,
};

const routeCity: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 800,
  color: '#1e293b',
};

const infoGrid: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 8,
};
