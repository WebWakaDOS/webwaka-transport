/**
 * P07-T2: Thermal Receipt Component
 * Renders a printable receipt with QR code (validation payload) and supports
 * browser Print and WhatsApp share. Dynamically imports the `qrcode` lib to
 * keep it out of the main bundle.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { formatKobo } from '@webwaka/core';

export interface ReceiptData {
  receipt_id: string;
  transaction_id: string;
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

export default function ReceiptModal({ receipt, onClose }: ReceiptModalProps) {
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

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

  const handleShare = useCallback(async () => {
    const text = [
      `🚌 WebWaka Ticket`,
      `Route: ${receipt.trip_origin} → ${receipt.trip_destination}`,
      `Departure: ${fmtDT(receipt.departure_time)}`,
      `Seats: ${receipt.seat_numbers.join(', ')}`,
      `Passengers: ${receipt.passenger_names.join(', ')}`,
      `Amount: ${formatKobo(receipt.total_amount)} (${receipt.payment_method})`,
      `Receipt #: ${receipt.receipt_id}`,
    ].join('\n');

    setSharing(true);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'WebWaka Ticket', text });
      } else {
        const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
        window.open(wa, '_blank', 'noopener,noreferrer');
      }
    } catch {
      // share cancelled or not supported
    } finally {
      setSharing(false);
    }
  }, [receipt]);

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
            padding: '12px 16px 16px', display: 'flex', gap: 8,
            borderTop: '1px solid #f1f5f9',
          }}>
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
              onClick={() => void handleShare()}
              disabled={sharing}
              style={{
                flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid #16a34a',
                background: '#f0fdf4', color: '#16a34a', fontWeight: 700, fontSize: 13, cursor: 'pointer',
              }}
            >
              📤 Share
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
