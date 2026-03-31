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

  const whatsAppText = [
    'WebWaka Booking Confirmed! ✅',
    `Route: ${booking.origin} → ${booking.destination}`,
    `Date: ${formatDate(booking.departure_time)}`,
    `Seat(s): ${seatIds.length}`,
    `Passenger: ${passengerNames[0] ?? 'Passenger'}`,
    `Ref: ${shortRef}`,
    `View ticket: https://webwaka.ng/b/${booking.id}`,
  ].join('\n');
  const whatsAppUrl = `https://wa.me/?text=${encodeURIComponent(whatsAppText)}`;

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
              href={whatsAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-whatsapp"
              style={{ ...btnStyle, flex: 1, textAlign: 'center', textDecoration: 'none', background: '#25D366', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16" fill="currentColor" style={{ flexShrink: 0 }}>
                <path d="M16 0C7.163 0 0 7.163 0 16c0 2.826.74 5.476 2.034 7.773L0 32l8.454-2.012A15.93 15.93 0 0016 32c8.837 0 16-7.163 16-16S24.837 0 16 0zm0 29.3a13.27 13.27 0 01-6.74-1.835l-.483-.287-4.99 1.188 1.226-4.867-.316-.5A13.26 13.26 0 012.7 16C2.7 8.656 8.656 2.7 16 2.7c7.344 0 13.3 5.956 13.3 13.3S23.344 29.3 16 29.3zm7.3-9.946c-.4-.2-2.367-1.168-2.733-1.3-.366-.133-.633-.2-.9.2s-1.033 1.3-1.266 1.567c-.233.267-.467.3-.867.1a10.91 10.91 0 01-3.213-1.983 12.07 12.07 0 01-2.223-2.77c-.233-.4-.025-.617.175-.817.181-.18.4-.467.6-.7.2-.233.267-.4.4-.667.133-.267.067-.5-.033-.7-.1-.2-.9-2.167-1.233-2.967-.325-.78-.656-.674-.9-.686l-.767-.013c-.267 0-.7.1-1.067.5s-1.4 1.367-1.4 3.333 1.433 3.867 1.633 4.133c.2.267 2.82 4.3 6.833 6.033.954.413 1.699.66 2.28.845.958.306 1.83.263 2.52.16.769-.114 2.367-.968 2.7-1.9.333-.933.333-1.733.233-1.9-.1-.167-.367-.267-.767-.467z" />
              </svg>
              Share via WhatsApp
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
