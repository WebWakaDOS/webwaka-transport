/**
 * P03-T5: E-Ticket Page — Public QR Boarding Pass
 * Route: /b/:bookingId (no auth required)
 * Fetches from GET /b/:bookingId, renders boarding pass with QR code.
 */
import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';

interface BookingDetail {
  id: string;
  customer_id: string;
  trip_id: string;
  seat_ids: string;
  passenger_names: string;
  total_amount: number;
  status: string;
  payment_status: string;
  payment_reference: string | null;
  confirmed_at: number | null;
  departure_time: number;
  origin: string;
  destination: string;
  operator_name: string;
}

function formatKobo(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('en-NG', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

interface TicketPageProps {
  bookingId: string;
}

export function TicketPage({ bookingId }: TicketPageProps) {
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    fetch(`/b/${bookingId}/data`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json() as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ success: boolean; data: BookingDetail }>;
      })
      .then(({ data }) => {
        setBooking(data);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load ticket');
      })
      .finally(() => setLoading(false));
  }, [bookingId]);

  useEffect(() => {
    if (!booking || !canvasRef.current) return;

    const seatIds: string[] = JSON.parse(booking.seat_ids) as string[];
    const qrData = `${booking.id}:${seatIds.join(',')}`;

    QRCode.toCanvas(canvasRef.current, qrData, {
      width: 200,
      margin: 2,
      color: { dark: '#1e293b', light: '#ffffff' },
    }).catch(() => {});
  }, [booking]);

  if (loading) {
    return (
      <div style={centerStyle}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🎫</div>
        <div style={{ color: '#64748b', fontSize: 14 }}>Loading your ticket…</div>
      </div>
    );
  }

  if (error || !booking) {
    return (
      <div style={centerStyle}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>❌</div>
        <div style={{ fontWeight: 700, color: '#b91c1c', marginBottom: 4 }}>Ticket not found</div>
        <div style={{ fontSize: 13, color: '#64748b', marginBottom: 20 }}>
          {error || 'This booking does not exist or has not been confirmed.'}
        </div>
        <button onClick={() => { window.location.href = '/'; }} style={btnStyle}>
          Back to Home
        </button>
      </div>
    );
  }

  const seatIds: string[] = JSON.parse(booking.seat_ids) as string[];
  const passengerNames: string[] = JSON.parse(booking.passenger_names) as string[];
  const shortRef = booking.id.slice(-8).toUpperCase();

  const receiptText = encodeURIComponent(
    `WebWaka Booking Confirmed!\n${booking.origin} → ${booking.destination}\n` +
    `Date: ${formatDate(booking.departure_time)}\n` +
    `Seats: ${seatIds.length}\nRef: ${shortRef}\n` +
    `View: https://webwaka.ng/b/${booking.id}`
  );

  return (
    <div style={pageStyle}>
      <style>{`
        @media print {
          body { background: #fff !important; }
          .no-print { display: none !important; }
          .ticket-card { box-shadow: none !important; border: 1px solid #e2e8f0 !important; max-width: 80mm !important; }
        }
      `}</style>

      <div className="ticket-card" style={ticketCardStyle}>
        <div style={headerStyle}>
          <div style={{ fontSize: 28, marginBottom: 4 }}>🚌</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>WebWaka Transport</div>
          <div style={{ fontSize: 12, color: '#bfdbfe', marginTop: 2 }}>E-Ticket / Boarding Pass</div>
        </div>

        <div style={bodyStyle}>
          <div style={routeStyle}>
            <div style={cityStyle}>{booking.origin}</div>
            <div style={{ fontSize: 18, color: '#94a3b8', margin: '0 8px' }}>⟶</div>
            <div style={cityStyle}>{booking.destination}</div>
          </div>

          <div style={dividerStyle} />

          <div style={fieldRowStyle}>
            <FieldItem label="Date & Time" value={formatDate(booking.departure_time)} />
            <FieldItem label="Operator" value={booking.operator_name} />
          </div>

          <div style={fieldRowStyle}>
            <FieldItem label="Passenger(s)" value={passengerNames.join(', ')} />
            <FieldItem label="Seat(s)" value={`${seatIds.length} seat${seatIds.length > 1 ? 's' : ''}`} />
          </div>

          <div style={fieldRowStyle}>
            <FieldItem label="Total Paid" value={formatKobo(booking.total_amount)} />
            <FieldItem label="Booking Ref" value={shortRef} mono />
          </div>

          <div style={dividerStyle} />

          <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10, fontWeight: 600 }}>
              SCAN TO BOARD
            </div>
            <canvas ref={canvasRef} style={{ borderRadius: 8, border: '2px solid #e2e8f0' }} />
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6, fontFamily: 'monospace' }}>
              {booking.id}
            </div>
          </div>

          <div style={dividerStyle} />

          <div className="no-print" style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <a
              href={`https://wa.me/?text=${receiptText}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...btnStyle, flex: 1, textAlign: 'center', textDecoration: 'none', background: '#16a34a' }}
            >
              📤 Share via WhatsApp
            </a>
            <button
              onClick={() => window.print()}
              style={{ ...btnStyle, flex: 1, background: '#475569' }}
            >
              🖨️ Print / Download
            </button>
          </div>

          <button
            className="no-print"
            onClick={() => { window.location.href = '/'; }}
            style={{ ...btnStyle, width: '100%', marginTop: 10, background: '#fff', color: '#1e40af', border: '1.5px solid #1e40af' }}
          >
            ← Back to App
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#1e293b', marginTop: 2, fontFamily: mono ? 'monospace' : 'inherit' }}>
        {value}
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: '#f1f5f9',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '24px 16px 48px',
};

const ticketCardStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 20,
  boxShadow: '0 4px 24px rgba(0,0,0,0.12)',
  width: '100%',
  maxWidth: 400,
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, #1e40af 0%, #1d4ed8 100%)',
  padding: '24px 20px 20px',
  textAlign: 'center',
};

const bodyStyle: React.CSSProperties = {
  padding: '20px 20px 16px',
};

const routeStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginBottom: 16,
};

const cityStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 800,
  color: '#1e293b',
};

const dividerStyle: React.CSSProperties = {
  height: 1,
  background: '#e2e8f0',
  margin: '12px 0',
};

const fieldRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 16,
  marginBottom: 12,
};

const centerStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  textAlign: 'center',
};

const btnStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderRadius: 10,
  border: 'none',
  background: '#1e40af',
  color: '#fff',
  fontWeight: 700,
  fontSize: 14,
  cursor: 'pointer',
  display: 'inline-block',
};
