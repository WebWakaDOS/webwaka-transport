/**
 * SeatMap — TRN-1 Seat Inventory Visual Component
 * Color-coded interactive seat grid. Nigeria-First, Mobile-First.
 */
import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { SeatInfo } from '../api/client';

interface SeatMapProps {
  tripId: string;
  selectedSeats: string[];
  onToggle: (seatId: string) => void;
  maxSelectable?: number;
  readOnly?: boolean;
}

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  available: { background: '#dcfce7', borderColor: '#16a34a', color: '#15803d', cursor: 'pointer' },
  reserved:  { background: '#fef9c3', borderColor: '#ca8a04', color: '#92400e', cursor: 'not-allowed' },
  confirmed: { background: '#dbeafe', borderColor: '#2563eb', color: '#1d4ed8', cursor: 'not-allowed' },
  blocked:   { background: '#fee2e2', borderColor: '#dc2626', color: '#b91c1c', cursor: 'not-allowed' },
};

const SELECTED_STYLE: React.CSSProperties = {
  background: '#1e40af', borderColor: '#1e40af', color: '#fff', cursor: 'pointer',
};

const LEGEND = [
  { status: 'available', label: 'Available' },
  { status: 'reserved',  label: 'Reserved' },
  { status: 'confirmed', label: 'Confirmed' },
  { status: 'blocked',   label: 'Blocked' },
];

export function SeatMap({ tripId, selectedSeats, onToggle, maxSelectable = 4, readOnly = false }: SeatMapProps) {
  const [seats, setSeats] = useState<SeatInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [liveConnected, setLiveConnected] = useState(false);

  // P10-T1: SSE live seat feed — fall back to polling if EventSource unavailable
  useEffect(() => {
    setLoading(true);
    setError('');

    // Initial fetch to populate seats immediately
    api.getSeatAvailability(tripId)
      .then(d => setSeats(d.seats))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));

    if (typeof EventSource === 'undefined') return;

    const sseUrl = `/api/seat-inventory/trips/${tripId}/live`;
    let es: EventSource;
    try {
      es = new EventSource(sseUrl);
    } catch {
      return; // SSE not supported — polling already done above
    }

    es.addEventListener('open', () => setLiveConnected(true));

    es.addEventListener('message', (evt) => {
      try {
        const payload = JSON.parse(evt.data) as {
          trip_id: string;
          seats: Record<string, number>;
          ts: number;
        };
        if (payload.trip_id !== tripId) return;
        // Re-fetch full seat list to get seat_number and reservation details
        api.getSeatAvailability(tripId)
          .then(d => setSeats(d.seats))
          .catch(() => { /* non-fatal — keep showing last known state */ });
      } catch { /* ignore malformed events */ }
    });

    es.addEventListener('error', () => {
      setLiveConnected(false);
      es.close();
    });

    es.addEventListener('close', () => {
      setLiveConnected(false);
      es.close();
    });

    return () => {
      setLiveConnected(false);
      es.close();
    };
  }, [tripId, refreshKey]);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 24, color: '#94a3b8' }}>
        Loading seat map…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 16, background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>
        <p style={{ margin: '0 0 8px', fontWeight: 600 }}>Could not load seats</p>
        <p style={{ margin: '0 0 8px' }}>{error}</p>
        <button
          onClick={() => setRefreshKey(k => k + 1)}
          style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #dc2626', background: '#fff', color: '#dc2626', cursor: 'pointer', fontSize: 12 }}
        >
          Retry
        </button>
      </div>
    );
  }

  const stats = seats.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const handleClick = (seat: SeatInfo) => {
    if (readOnly) return;
    if (seat.status !== 'available' && !selectedSeats.includes(seat.id)) return;
    if (!selectedSeats.includes(seat.id) && selectedSeats.length >= maxSelectable) return;
    onToggle(seat.id);
  };

  return (
    <div>
      {/* Stats bar + live indicator */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {LEGEND.map(({ status, label }) => (
          <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <div style={{
              width: 12, height: 12, borderRadius: 3, border: '1.5px solid',
              ...STATUS_STYLE[status],
            }} />
            <span style={{ color: '#64748b' }}>{label}: {stats[status] ?? 0}</span>
          </div>
        ))}
        {liveConnected && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#16a34a', fontWeight: 700, marginLeft: 'auto' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />
            LIVE
          </div>
        )}
      </div>

      {/* Bus driver indicator */}
      <div style={{
        textAlign: 'center', fontSize: 11, color: '#94a3b8', marginBottom: 8,
        padding: '6px 0', background: '#f8fafc', borderRadius: 8, border: '1px dashed #e2e8f0',
      }}>
        🚌 Front of bus
      </div>

      {/* Seat grid — 4 columns (2 aisle 2) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 12px 1fr 1fr',
        gap: 6,
        marginBottom: 12,
      }}>
        {Array.from({ length: Math.ceil(seats.length / 4) }, (_, row) => {
          const rowSeats = seats.slice(row * 4, row * 4 + 4);
          return (
            <React.Fragment key={row}>
              {rowSeats.slice(0, 2).map(seat => (
                <SeatButton key={seat.id} seat={seat} selected={selectedSeats.includes(seat.id)} onClick={() => handleClick(seat)} />
              ))}
              {/* Aisle */}
              <div />
              {rowSeats.slice(2, 4).map(seat => (
                <SeatButton key={seat.id} seat={seat} selected={selectedSeats.includes(seat.id)} onClick={() => handleClick(seat)} />
              ))}
              {/* Fill empty cells in last row */}
              {rowSeats.length < 4 && Array.from({ length: 4 - rowSeats.length }, (_, i) => (
                <div key={`empty-${i}`} />
              ))}
            </React.Fragment>
          );
        })}
      </div>

      {selectedSeats.length > 0 && !readOnly && (
        <div style={{
          padding: '8px 12px', background: '#eff6ff', borderRadius: 8,
          border: '1.5px solid #bfdbfe', fontSize: 13, color: '#1e40af', fontWeight: 600,
        }}>
          {selectedSeats.length} seat{selectedSeats.length > 1 ? 's' : ''} selected
          {maxSelectable > 1 && ` · max ${maxSelectable}`}
        </div>
      )}
    </div>
  );
}

function SeatButton({ seat, selected, onClick }: {
  seat: SeatInfo; selected: boolean; onClick: () => void;
}) {
  const style: React.CSSProperties = {
    width: '100%', aspectRatio: '1',
    borderRadius: 6, border: '1.5px solid',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 10, fontWeight: 700, transition: 'all 0.1s',
    ...(selected ? SELECTED_STYLE : (STATUS_STYLE[seat.status] ?? STATUS_STYLE['available'])),
  };

  return (
    <button onClick={onClick} style={style} title={`Seat ${seat.seat_number} — ${seat.status}`}>
      {seat.seat_number}
    </button>
  );
}
