/**
 * P07-T2: Thermal Receipt Component
 * P13-T1: WhatsApp branded share button (#25D366 + SVG icon)
 * Renders a printable receipt with QR code (validation payload) and supports
 * browser Print and WhatsApp share. Dynamically imports the `qrcode` lib to
 * keep it out of the main bundle.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { formatKobo } from '@webwaka/core';

export interface ReceiptData {
  receipt_id: string;
  transaction_id: string;
  booking_id?: string | undefined;
  trip_origin: string;
  trip_destination: string;
  departure_time: number;
  operator_name?: string | undefined;
  agent_name?: string | undefined;
  seat_numbers: string[];
  passenger_names: string[];
  total_amount: number;
  payment_method: string;
  qr_code: string;
  issued_at: number;
}

interface ReceiptModalProps {
  receipt: ReceiptData;
  onClose: () => void;
}

const fmtDT = (ms: number) =>
  new Date(ms).toLocaleString('en-NG', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

const WhatsAppIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 32 32"
    width="16"
    height="16"
    fill="currentColor"
    style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5 }}
  >
    <path d="M16 0C7.163 0 0 7.163 0 16c0 2.826.74 5.476 2.034 7.773L0 32l8.454-2.012A15.93 15.93 0 0016 32c8.837 0 16-7.163 16-16S24.837 0 16 0zm0 29.3a13.27 13.27 0 01-6.74-1.835l-.483-.287-4.99 1.188 1.226-4.867-.316-.5A13.26 13.26 0 012.7 16C2.7 8.656 8.656 2.7 16 2.7c7.344 0 13.3 5.956 13.3 13.3S23.344 29.3 16 29.3zm7.3-9.946c-.4-.2-2.367-1.168-2.733-1.3-.366-.133-.633-.2-.9.2s-1.033 1.3-1.266 1.567c-.233.267-.467.3-.867.1a10.91 10.91 0 01-3.213-1.983 12.07 12.07 0 01-2.223-2.77c-.233-.4-.025-.617.175-.817.181-.18.4-.467.6-.7.2-.233.267-.4.4-.667.133-.267.067-.5-.033-.7-.1-.2-.9-2.167-1.233-2.967-.325-.78-.656-.674-.9-.686l-.767-.013c-.267 0-.7.1-1.067.5s-1.4 1.367-1.4 3.333 1.433 3.867 1.633 4.133c.2.267 2.82 4.3 6.833 6.033.954.413 1.699.66 2.28.845.958.306 1.83.263 2.52.16.769-.114 2.367-.968 2.7-1.9.333-.933.333-1.733.233-1.9-.1-.167-.367-.267-.767-.467z" />
  </svg>
);

interface ShareParams {
  origin: string;
  destination: string;
  departureDate: string;
  seatNumbers: string;
  passengerName: string;
  bookingId: string;
}

function buildWhatsAppUrl({ origin, destination, departureDate, seatNumbers, passengerName, bookingId }: ShareParams) {
  const text = [
    'WebWaka Booking Confirmed! ✅',
    `Route: ${origin} → ${destination}`,
    `Date: ${departureDate}`,
    `Seat(s): ${seatNumbers}`,
    `Passenger: ${passengerName}`,
    `Ref: ${bookingId.slice(-8).toUpperCase()}`,
    `View ticket: https://webwaka.ng/b/${bookingId}`,
  ].join('\n');
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export default function ReceiptModal({ receipt, onClose }: ReceiptModalProps) {
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const QRCode = (await import('qrcode')).default;
        const canvas = qrCanvasRef.current;
        if (canvas && !cancelled) {
          await QRCode.toCanvas(canvas, receipt.qr_code, { width: 160, margin: 1 });
          setQrDataUrl(canvas.toDataURL('image/png'));
        }
      } catch {
        // QR generation failed — non-fatal
      }
    })();
    return () => { cancelled = true; };
  }, [receipt.qr_code]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const whatsAppUrl = buildWhatsAppUrl({
    origin: receipt.trip_origin,
    destination: receipt.trip_destination,
    departureDate: fmtDT(receipt.departure_time),
    seatNumbers: receipt.seat_numbers.join(', '),
    passengerName: receipt.passenger_names[0] ?? 'Passenger',
    bookingId: receipt.booking_id ?? receipt.receipt_id,
  });

  return (
    <>
      <style>{`
        @media print {
          body > *:not(.receipt-print-root) { display: none !important; }
          .receipt-print-root { position: fixed; inset: 0; z-index: 9999; background: #fff; }
          .no-print { display: none !important; }
          .receipt-card { box-shadow: none !important; border: none !important; max-width: 100% !important; }
        }
      `}</style>

      <div
        className="receipt-print-root"
        style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.6)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16,
        }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          className="receipt-card"
          style={{
            background: '#fff', borderRadius: 12, width: '100%', maxWidth: 380,
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            fontFamily: '"Courier New", Courier, monospace',
          }}
        >
          {/* Header */}
          <div style={{
            background: '#1e3a5f', color: '#fff', padding: '16px 20px',
            borderRadius: '12px 12px 0 0', textAlign: 'center',
          }}>
            <div style={{ fontSize: 13, letterSpacing: 2, opacity: 0.8 }}>WEBWAKA TRANSPORT</div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
              {receipt.operator_name ?? 'Bus Operator'}
            </div>
          </div>

          {/* Dashed separator */}
          <div style={{ borderTop: '2px dashed #e2e8f0', margin: '0 20px' }} />

          {/* Route block */}
          <div style={{ padding: '14px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>ROUTE</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#1e293b', letterSpacing: 1 }}>
              {receipt.trip_origin.toUpperCase()} → {receipt.trip_destination.toUpperCase()}
            </div>
            <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>
              {fmtDT(receipt.departure_time)}
            </div>
          </div>

          <div style={{ borderTop: '1px dashed #e2e8f0', margin: '0 20px' }} />

          {/* Seats & passengers */}
          <div style={{ padding: '12px 20px' }}>
            <Row label="SEAT(S)" value={receipt.seat_numbers.join(', ')} />
            <Row label="PASSENGER(S)" value={receipt.passenger_names.join(', ')} />
          </div>

          <div style={{ borderTop: '1px dashed #e2e8f0', margin: '0 20px' }} />

          {/* Payment */}
          <div style={{ padding: '12px 20px' }}>
            <Row label="AMOUNT" value={formatKobo(receipt.total_amount)} bold />
            <Row label="PAYMENT" value={receipt.payment_method.replace('_', ' ').toUpperCase()} />
            {receipt.agent_name && <Row label="AGENT" value={receipt.agent_name} />}
            <Row label="RECEIPT #" value={receipt.receipt_id.slice(-10).toUpperCase()} />
            <Row label="ISSUED" value={fmtDT(receipt.issued_at)} />
          </div>

          <div style={{ borderTop: '2px dashed #e2e8f0', margin: '0 20px' }} />

          {/* QR code */}
          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <canvas ref={qrCanvasRef} style={{ display: qrDataUrl ? 'block' : 'none' }} />
            {!qrDataUrl && (
              <div style={{
                width: 160, height: 160, background: '#f1f5f9', borderRadius: 6,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, color: '#94a3b8',
              }}>
                Generating QR…
              </div>
            )}
            <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 6, textAlign: 'center' }}>
              Scan to verify ticket at boarding
            </div>
          </div>

          {/* Footer note */}
          <div style={{
            padding: '8px 20px 16px', textAlign: 'center',
            fontSize: 10, color: '#94a3b8', lineHeight: 1.5,
          }}>
            This receipt is issued by {receipt.operator_name ?? 'the operator'}.{'\n'}
            Non-refundable after departure. Arrive 15 min early.
          </div>

          {/* Action buttons */}
          <div className="no-print" style={{
            padding: '12px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8,
            borderTop: '1px solid #f1f5f9',
          }}>
            {/* WhatsApp share button */}
            <a
              href={whatsAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-whatsapp"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '11px 0', borderRadius: 8, border: 'none',
                background: '#25D366', color: '#fff', fontWeight: 700, fontSize: 13,
                cursor: 'pointer', textDecoration: 'none', width: '100%',
              }}
            >
              <WhatsAppIcon />
              Share via WhatsApp
            </a>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handlePrint}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid #2563eb',
                  background: '#eff6ff', color: '#2563eb', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                }}
              >
                🖨 Print
              </button>
              <button
                onClick={onClose}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid #e2e8f0',
                  background: '#f8fafc', color: '#64748b', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 11 }}>
      <span style={{ color: '#64748b', minWidth: 90 }}>{label}</span>
      <span style={{
        color: '#1e293b', fontWeight: bold ? 700 : 400,
        textAlign: 'right', maxWidth: 220, wordBreak: 'break-word',
      }}>
        {value}
      </span>
    </div>
  );
}
