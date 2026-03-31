/**
 * C-004: Driver Mobile App View
 * Shows today's trips for the logged-in driver with passenger manifest
 * and offline-first boarding mark capability.
 * Invariants: Mobile-First, Offline-First, Nigeria-First
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../api/client';
import type { Trip, TripManifest, ManifestEntry } from '../api/client';
import { formatKoboToNaira } from '../core/i18n/index';

// ============================================================
// Sub-components
// ============================================================

function TripCard({ trip, onSelect }: { trip: Trip; onSelect: () => void }) {
  const dep = new Date(trip.departure_time).toLocaleString('en-NG', {
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  const stateColors: Record<string, string> = {
    boarding: '#16a34a', scheduled: '#2563eb', in_transit: '#f59e0b',
    completed: '#64748b', cancelled: '#dc2626',
  };
  const color = stateColors[trip.state] ?? '#64748b';

  return (
    <div
      onClick={onSelect}
      style={{
        background: '#fff', borderRadius: 12, padding: '14px 16px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 12,
        cursor: 'pointer', borderLeft: `4px solid ${color}`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#0f172a' }}>
            {trip.origin} → {trip.destination}
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{dep}</div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}20`, padding: '4px 10px', borderRadius: 20 }}>
          {trip.state.replace('_', ' ').toUpperCase()}
        </span>
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: '#64748b' }}>
        {trip.vehicle_id ? `Vehicle: ${trip.vehicle_id}` : 'No vehicle assigned'}
      </div>
    </div>
  );
}

interface ManifestViewProps {
  tripId: string;
  onBack: () => void;
}

function ManifestView({ tripId, onBack }: ManifestViewProps) {
  const [manifest, setManifest] = useState<TripManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [boarding, setBoarding] = useState<Set<string>>(new Set());
  const [boarded, setBoarded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getTripManifest(tripId);
      setManifest(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load manifest');
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => { void load(); }, [load]);

  const handleBoard = async (bookingId: string) => {
    setBoarding(prev => new Set([...prev, bookingId]));
    try {
      await api.markPassengerBoarded(tripId, bookingId);
      setBoarded(prev => new Set([...prev, bookingId]));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to mark boarded');
    } finally {
      setBoarding(prev => {
        const next = new Set(prev);
        next.delete(bookingId);
        return next;
      });
    }
  };

  const passenger = manifest?.passengers ?? [];
  const boardedCount = passenger.filter(p => boarded.has(p.booking_id) || p.boarded_at != null).length;

  return (
    <div style={{ padding: '0 0 24px' }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#2563eb', marginBottom: 16, padding: 0 }}>
        ← Back to My Trips
      </button>

      {loading && <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>Loading manifest…</div>}

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#b91c1c', marginBottom: 12 }}>
          {error}
        </div>
      )}

      {manifest && (
        <>
          <div style={{ background: '#fff', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
              {manifest.origin} → {manifest.destination}
            </div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              {new Date(manifest.departure_time ?? Date.now()).toLocaleString('en-NG')}
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12 }}>
              <span><strong>{passenger.length}</strong> passengers</span>
              <span style={{ color: '#16a34a' }}><strong>{boardedCount}</strong> boarded</span>
              <span style={{ color: '#f59e0b' }}><strong>{passenger.length - boardedCount}</strong> pending</span>
            </div>
            {manifest.driver && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
                Driver: <strong>{manifest.driver.name}</strong> · {manifest.driver.phone}
              </div>
            )}
          </div>

          {passenger.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#94a3b8', padding: 32 }}>No passengers confirmed yet</div>
          ) : (
            passenger.map((p: ManifestEntry) => {
              const isBoarded = boarded.has(p.booking_id) || p.boarded_at != null;
              const isBusy = boarding.has(p.booking_id);
              return (
                <div
                  key={p.booking_id}
                  style={{
                    background: '#fff', borderRadius: 10, padding: '12px 16px',
                    marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                    borderLeft: `4px solid ${isBoarded ? '#16a34a' : '#e2e8f0'}`,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>
                      {p.passenger_name ?? 'Unknown'}
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      Seat: {p.seat_numbers?.join(', ') ?? '—'} · {p.payment_method ?? '—'}
                    </div>
                    {p.phone && <div style={{ fontSize: 11, color: '#64748b' }}>{p.phone}</div>}
                  </div>
                  {isBoarded ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a', background: '#f0fdf4', padding: '4px 10px', borderRadius: 20 }}>
                      ✓ Boarded
                    </span>
                  ) : (
                    <button
                      disabled={isBusy}
                      onClick={() => handleBoard(p.booking_id)}
                      style={{
                        padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                        background: isBusy ? '#f1f5f9' : '#2563eb', color: isBusy ? '#94a3b8' : '#fff',
                        border: 'none', cursor: isBusy ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {isBusy ? '…' : 'Board'}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
// Main Driver View
// ============================================================

export function DriverView() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getMyDriverTrips();
      setTrips(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load trips');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (selectedTrip) {
    return <ManifestView tripId={selectedTrip} onBack={() => setSelectedTrip(null)} />;
  }

  return (
    <div style={{ padding: '0 0 24px' }}>
      <div style={{ fontWeight: 700, fontSize: 20, color: '#0f172a', marginBottom: 4 }}>My Trips Today</div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 20 }}>
        {new Date().toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
      </div>

      {loading && <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>Loading trips…</div>}

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#b91c1c', marginBottom: 16 }}>
          {error}
          <button onClick={load} style={{ marginLeft: 8, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: '#b91c1c' }}>Retry</button>
        </div>
      )}

      {!loading && trips.length === 0 && !error && (
        <div style={{ textAlign: 'center', color: '#94a3b8', padding: 48 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚌</div>
          No trips assigned to you today
        </div>
      )}

      {trips.map(trip => (
        <TripCard
          key={trip.id}
          trip={trip}
          onSelect={() => setSelectedTrip(trip.id)}
        />
      ))}
    </div>
  );
}
