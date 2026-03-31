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
  seat_numbers: string[];
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

        // QR payload format: bookingId:seat1,seat2,seat3
        // Uses seat_numbers from API response (human-readable), falls back to seat IDs
        let seatIds: string[] = [];
        try { seatIds = JSON.parse(bk.seat_ids) as string[]; } catch { seatIds = []; }
        const seatLabels = bk.seat_numbers?.length ? bk.seat_numbers : seatIds;
        const qrPayload = `${bk.id}:${seatLabels.join(',')}`;
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
  const seatDisplay = booking.seat_numbers?.length
    ? booking.seat_numbers.join(', ')
    : `${seatIds.length} seat${seatIds.length !== 1 ? 's' : ''}`;

  const ticketUrl = `https://webwaka.ng/b/${booking.id}`;
  const whatsappText = encodeURIComponent(
    `My WebWaka e-ticket: ${booking.origin} → ${booking.destination}, ${formatDate(booking.departure_time)}. Seats: ${seatDisplay}. View: ${ticketUrl}`
  );

  return (
    <>
      {/* @media print styles — injected once on mount */}
      <style>{`
        @media print {
          body { background: white !important; }
          .ticket-nav-hint, .waka-whatsapp-btn { display: none !important; }
          .ticket-card { box-shadow: none !important; border: 1px solid #e2e8f0 !important; max-width: 100% !important; }
          .ticket-page-wrap { padding: 0 !important; background: white !important; }
        }
      `}</style>

      <div style={pageStyle} className="ticket-page-wrap">
        {/* Nav hint — hidden on print */}
        <p className="ticket-nav-hint" style={{ width: '100%', maxWidth: 480, textAlign: 'right', fontSize: 13, color: '#94a3b8', marginBottom: 8 }}>
          🖨 Use browser Print to save as PDF
        </p>

        <div style={cardStyle} className="ticket-card">
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

          <hr style={divider} />

          {/* Trip info */}
          <div style={infoGrid}>
            <InfoRow label="Departure" value={formatDate(booking.departure_time)} />
            <InfoRow label="Seats" value={seatDisplay} />
            <InfoRow label="Amount Paid" value={formatNaira(booking.total_amount)} />
            <InfoRow label="Booking ID" value={booking.id} mono />
            <InfoRow label="Payment Ref" value={booking.payment_reference} mono />
            {booking.confirmed_at && (
              <InfoRow label="Confirmed At" value={formatDate(booking.confirmed_at)} />
            )}
          </div>

          {/* Passengers */}
          {passengerNames.length > 0 && (
            <>
              <hr style={divider} />
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
          <hr style={divider} />
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

          {/* WhatsApp share — hidden on print */}
          <hr style={divider} />
          <div style={{ textAlign: 'center' }}>
            <a
              className="waka-whatsapp-btn"
              href={`https://wa.me/?text=${whatsappText}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '11px 22px', borderRadius: 10, textDecoration: 'none',
                background: '#25D366', color: '#fff', fontWeight: 700, fontSize: 15,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.553 4.112 1.524 5.834L0 24l6.326-1.504A11.944 11.944 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.013-1.376l-.36-.213-3.73.887.92-3.636-.232-.372A9.818 9.818 0 1112 21.818z"/>
              </svg>
              Share via WhatsApp
            </a>
          </div>

          {/* Footer */}
          <div style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: '#cbd5e1' }}>
            WebWaka Transport Suite · Nigeria Intercity
          </div>
        </div>
      </div>
    </>
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
  flexDirection: 'column',
  alignItems: 'center',
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

const divider: React.CSSProperties = {
  border: 'none',
  borderTop: '1.5px dashed #e2e8f0',
  margin: '20px 0',
};
