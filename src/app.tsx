/**
 * WebWaka Transport Suite — Mobile-First PWA
 * Modules: TRN-1 Seat Inventory, TRN-2 Agent POS, TRN-3 Booking Portal, TRN-4 Operator Dashboard
 * Invariants: Mobile-First, PWA-First, Offline-First, Nigeria-First (₦), Africa-First (4 languages)
 */
import React, { Component, useState, useEffect, useCallback } from 'react';
import { t, setLanguage, getLanguage, getSupportedLanguages, formatKoboToNaira, type Language } from './core/i18n/index';
import { useOnlineStatus, useSyncQueue } from './core/offline/hooks';
import { AuthProvider, useAuth, type WakaRole } from './core/auth/context';
import { LoginScreen } from './components/login-screen';
import { BookingFlow } from './components/booking-flow';
import { api, ApiError } from './api/client';
import type { TripSummary, Route, Vehicle, Trip, OperatorStats, Booking, SeatAvailability } from './api/client';

// ============================================================
// Error Boundary
// ============================================================
interface ErrorBoundaryState { hasError: boolean; message: string }

class ErrorBoundary extends Component<React.PropsWithChildren<{ label: string }>, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren<{ label: string }>) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(err: unknown): ErrorBoundaryState {
    return { hasError: true, message: err instanceof Error ? err.message : 'Unknown error' };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, textAlign: 'center', color: '#b91c1c' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{this.props.label} failed to load</div>
          <div style={{ fontSize: 12, color: '#64748b' }}>{this.state.message}</div>
          <button
            onClick={() => this.setState({ hasError: false, message: '' })}
            style={{ marginTop: 16, padding: '8px 20px', borderRadius: 8, border: '1px solid #dc2626', background: '#fff', color: '#dc2626', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================
// Status Bar
// ============================================================
function StatusBar({ online, pendingSync, syncing, lang, onLangChange }: {
  online: boolean; pendingSync: number; syncing: boolean; lang: Language; onLangChange: (l: Language) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 16px', fontSize: 11, fontWeight: 600,
      background: online ? '#16a34a' : '#dc2626', color: '#fff',
    }}>
      <span>{online ? `● ${t('online')}` : `○ ${t('offline')}`}</span>
      {syncing && <span>↻ {t('syncing') ?? 'Syncing…'}</span>}
      {!syncing && pendingSync > 0 && <span>⟳ {pendingSync} {t('pending_sync')}</span>}
      <select
        value={lang}
        onChange={e => onLangChange(e.target.value as Language)}
        style={{ background: 'transparent', color: '#fff', border: 'none', fontSize: 11, cursor: 'pointer' }}
      >
        {getSupportedLanguages().map(l => (
          <option key={l.code} value={l.code} style={{ color: '#000' }}>{l.name}</option>
        ))}
      </select>
    </div>
  );
}

// ============================================================
// Trip Search Module (TRN-3 Booking Portal)
// ============================================================
function TripSearchModule() {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]!);
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedTrip, setSelectedTrip] = useState<TripSummary | null>(null);

  const search = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const results = await api.searchTrips({ origin, destination, date });
      setTrips(results);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Search failed');
      setTrips([]);
    } finally {
      setLoading(false);
    }
  }, [origin, destination, date]);

  if (selectedTrip) {
    return (
      <BookingFlow
        trip={selectedTrip}
        onBack={() => setSelectedTrip(null)}
      />
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{t('search_trips')}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input placeholder={t('origin')} value={origin} onChange={e => setOrigin(e.target.value)} style={inputStyle} />
        <input placeholder={t('destination')} value={destination} onChange={e => setDestination(e.target.value)} style={inputStyle} />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        <button onClick={() => void search()} style={primaryBtnStyle}>
          {loading ? t('loading') : t('search')}
        </button>
      </div>
      {error && (
        <div style={{ marginTop: 12, padding: '10px 14px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>
          {error}
        </div>
      )}
      <div style={{ marginTop: 20 }}>
        {trips.length === 0 && !loading && !error && (
          <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>{t('no_trips_found')}</p>
        )}
        {trips.map(trip => (
          <div key={trip.id} onClick={() => setSelectedTrip(trip)} style={cardStyle}>
            <div style={{ fontWeight: 700 }}>{trip.origin} → {trip.destination}</div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
              {new Date(trip.departure_time).toLocaleString('en-NG')} · {trip.operator_name}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <span style={{ color: '#16a34a', fontWeight: 700 }}>{formatKoboToNaira(trip.base_fare)}</span>
              <span style={{ fontSize: 12, color: '#64748b' }}>{trip.available_seats} {t('available_seats')}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Agent POS Module (TRN-2)
// ============================================================
function AgentPOSModule({ online }: { online: boolean }) {
  const { user } = useAuth();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [tripId, setTripId] = useState('');
  const [seatAvailability, setSeatAvailability] = useState<SeatAvailability | null>(null);
  const [seatsLoading, setSeatsLoading] = useState(false);
  const [selectedSeats, setSelectedSeats] = useState<string[]>([]);
  const [passengers, setPassengers] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'mobile_money' | 'card'>('cash');
  const [lastReceipt, setLastReceipt] = useState<{ receipt_id: string; total_amount: number; payment_method: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Load active trips when coming online
  useEffect(() => {
    if (!online) return;
    setTripsLoading(true);
    api.getOperatorTrips()
      .then(data => setTrips(data.filter(tr => tr.state === 'scheduled' || tr.state === 'boarding')))
      .catch(() => setTrips([]))
      .finally(() => setTripsLoading(false));
  }, [online]);

  // Load seat availability when trip changes
  useEffect(() => {
    if (!tripId) { setSeatAvailability(null); setSelectedSeats([]); return; }
    setSeatsLoading(true);
    api.getSeatAvailability(tripId)
      .then(data => { setSeatAvailability(data); setSelectedSeats([]); })
      .catch(() => setSeatAvailability(null))
      .finally(() => setSeatsLoading(false));
  }, [tripId]);

  // Auto-fill amount from trip base_fare × selected seat count
  useEffect(() => {
    const trip = trips.find(tr => tr.id === tripId);
    if (trip?.base_fare != null && selectedSeats.length > 0) {
      setAmount(String(Math.round(trip.base_fare * selectedSeats.length / 100)));
    } else if (selectedSeats.length === 0) {
      setAmount('');
    }
  }, [selectedSeats, tripId, trips]);

  const toggleSeat = (seatId: string) => {
    setSelectedSeats(prev =>
      prev.includes(seatId) ? prev.filter(s => s !== seatId) : [...prev, seatId]
    );
  };

  const handleSale = async () => {
    if (!tripId || selectedSeats.length === 0 || !amount) return;
    setSubmitting(true);
    setError('');
    const amountKobo = Math.round(parseFloat(amount) * 100);
    const passArr = passengers.split(',').map(p => p.trim()).filter(Boolean);
    const agentId = user?.id ?? 'agent';

    if (!online) {
      const { saveOfflineTransaction } = await import('./core/offline/db');
      await saveOfflineTransaction({
        local_id: `local_${Date.now()}`,
        agent_id: agentId,
        trip_id: tripId,
        seat_ids: selectedSeats,
        passenger_names: passArr,
        total_amount: amountKobo,
        payment_method: method,
        created_at: Date.now(),
        synced: false,
      });
      alert(t('offline_queued'));
      setSubmitting(false);
      return;
    }

    try {
      const receipt = await api.recordSale({
        agent_id: agentId,
        trip_id: tripId,
        seat_ids: selectedSeats,
        passenger_names: passArr,
        total_amount: amountKobo,
        payment_method: method,
      });
      setLastReceipt(receipt);
      setTripId(''); setSelectedSeats([]); setSeatAvailability(null);
      setPassengers(''); setAmount('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{t('agent_pos')}</h2>

      {lastReceipt && (
        <div style={{ ...cardStyle, background: '#f0fdf4', borderColor: '#16a34a', marginBottom: 16, cursor: 'default' }}>
          <div style={{ fontWeight: 700, color: '#16a34a' }}>✓ {t('sale_complete')}</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {t('fare')}: {formatKoboToNaira(lastReceipt.total_amount)} · {lastReceipt.payment_method}
          </div>
          <div style={{ fontSize: 12, color: '#64748b' }}>Receipt: {lastReceipt.receipt_id}</div>
        </div>
      )}

      {error && (
        <div style={{ padding: '10px 14px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Trip selector — dropdown when online with trips, text input as fallback */}
        {online && trips.length > 0 ? (
          <select value={tripId} onChange={e => setTripId(e.target.value)} style={inputStyle}>
            <option value="">-- {t('select_trip')} --</option>
            {trips.map(tr => (
              <option key={tr.id} value={tr.id}>
                {tr.origin ?? tr.route_id} → {tr.destination ?? ''} · {new Date(tr.departure_time).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })} · {tr.available_seats ?? '?'} avail
              </option>
            ))}
          </select>
        ) : (
          <input
            placeholder={tripsLoading ? t('loading') : t('select_trip')}
            value={tripId}
            onChange={e => setTripId(e.target.value)}
            style={inputStyle}
            disabled={tripsLoading}
          />
        )}

        {/* Seat grid — shown when a trip is selected */}
        {tripId && (
          seatsLoading ? (
            <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 13, margin: '4px 0' }}>{t('loading')} seats…</p>
          ) : seatAvailability ? (
            <div style={{ marginTop: 2 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>
                Seats — {selectedSeats.length} selected
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
                {seatAvailability.seats.map(seat => {
                  const isAvail = seat.status === 'available';
                  const isSel = selectedSeats.includes(seat.id);
                  return (
                    <button
                      key={seat.id}
                      disabled={!isAvail}
                      onClick={() => { if (isAvail) toggleSeat(seat.id); }}
                      style={{
                        padding: '7px 4px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                        cursor: isAvail ? 'pointer' : 'not-allowed',
                        border: '1.5px solid',
                        borderColor: isSel ? '#1e40af' : isAvail ? '#e2e8f0' : '#f1f5f9',
                        background: isSel ? '#1e40af' : isAvail ? '#fff' : '#f1f5f9',
                        color: isSel ? '#fff' : isAvail ? '#1e293b' : '#cbd5e1',
                      }}
                    >
                      {seat.seat_number}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null
        )}

        <input
          placeholder={selectedSeats.length > 0 ? `${t('passenger_name')} (${selectedSeats.length}, comma-separated)` : t('passenger_name')}
          value={passengers}
          onChange={e => setPassengers(e.target.value)}
          style={inputStyle}
        />
        <input
          placeholder={`${t('fare')} (₦)`}
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          style={inputStyle}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          {(['cash', 'mobile_money', 'card'] as const).map(m => (
            <button key={m} onClick={() => setMethod(m)} style={{
              flex: 1, padding: '10px 4px', borderRadius: 8, border: '2px solid',
              borderColor: method === m ? '#2563eb' : '#e2e8f0',
              background: method === m ? '#eff6ff' : '#fff',
              fontWeight: method === m ? 700 : 400, fontSize: 12, cursor: 'pointer',
            }}>
              {t(m)}
            </button>
          ))}
        </div>
        <button
          onClick={() => void handleSale()}
          disabled={submitting || !tripId || selectedSeats.length === 0 || !amount}
          style={primaryBtnStyle}
        >
          {submitting ? t('loading') : t('sale_complete')}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Operator Dashboard Module (TRN-4) — Routes, Vehicles, Trips
// ============================================================
type OperatorView = 'overview' | 'routes' | 'vehicles' | 'trips';

function OperatorOverview({ onNav }: { onNav: (v: OperatorView) => void }) {
  const [stats, setStats] = useState<OperatorStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getOperatorDashboard()
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  const tripStates = ['scheduled', 'boarding', 'in_transit', 'completed', 'cancelled'] as const;
  const stateColors: Record<string, string> = {
    scheduled: '#2563eb', boarding: '#d97706', in_transit: '#16a34a',
    completed: '#64748b', cancelled: '#dc2626',
  };

  return (
    <>
      <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>{t('operator')}</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>{t('dashboard')}</p>
      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            {tripStates.map(state => (
              <div key={state} style={{ ...cardStyle, borderLeft: `4px solid ${stateColors[state]}`, cursor: 'default' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: stateColors[state] }}>{stats?.trips[state] ?? 0}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, textTransform: 'capitalize' }}>{state.replace('_', ' ')}</div>
              </div>
            ))}
            {stats?.today_revenue_kobo != null && (
              <div style={{ ...cardStyle, borderLeft: '4px solid #16a34a', cursor: 'default', gridColumn: 'span 2' }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#16a34a' }}>
                  {formatKoboToNaira(stats.today_revenue_kobo)}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>Today's Revenue</div>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button onClick={() => onNav('routes')} style={navCardStyle}>
              <span style={{ fontSize: 24 }}>🗺️</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{t('manage_routes')}</span>
            </button>
            <button onClick={() => onNav('vehicles')} style={navCardStyle}>
              <span style={{ fontSize: 24 }}>🚌</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{t('manage_vehicles')}</span>
            </button>
            <button onClick={() => onNav('trips')} style={{ ...navCardStyle, gridColumn: 'span 2' }}>
              <span style={{ fontSize: 24 }}>📋</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>Manage Trips</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}

function RoutesPanel({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ origin: '', destination: '', base_fare: '', operator_id: user?.operator_id ?? '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getOperatorRoutes();
      setRoutes(data);
    } catch { setRoutes([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    const operatorId = user?.operator_id ?? form.operator_id;
    if (!form.origin || !form.destination || !form.base_fare || !operatorId) {
      setError('All fields required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.createRoute({
        origin: form.origin,
        destination: form.destination,
        base_fare: Math.round(parseFloat(form.base_fare) * 100),
        operator_id: operatorId,
      });
      setShowForm(false);
      setForm({ origin: '', destination: '', base_fare: '', operator_id: user?.operator_id ?? '' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create route');
    } finally { setSaving(false); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>{t('manage_routes')}</h2>
        <button onClick={() => setShowForm(s => !s)} style={{ ...primaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>
      {showForm && (
        <div style={{ ...cardStyle, marginBottom: 16, cursor: 'default' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input placeholder="Origin (e.g. Lagos)" value={form.origin} onChange={e => setForm(f => ({ ...f, origin: e.target.value }))} style={inputStyle} />
            <input placeholder="Destination (e.g. Abuja)" value={form.destination} onChange={e => setForm(f => ({ ...f, destination: e.target.value }))} style={inputStyle} />
            <input placeholder="Base fare (₦)" type="number" value={form.base_fare} onChange={e => setForm(f => ({ ...f, base_fare: e.target.value }))} style={inputStyle} />
            {user?.operator_id ? (
              <div style={{ padding: '10px 14px', background: '#eff6ff', borderRadius: 10, fontSize: 13, color: '#1e40af', fontWeight: 600 }}>
                Operator: {user.operator_id}
              </div>
            ) : (
              <input placeholder="Operator ID (Super Admin)" value={form.operator_id} onChange={e => setForm(f => ({ ...f, operator_id: e.target.value }))} style={inputStyle} />
            )}
            {error && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{error}</p>}
            <button onClick={() => void handleCreate()} disabled={saving} style={primaryBtnStyle}>
              {saving ? t('loading') : 'Create Route'}
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : routes.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>No routes found</p>
      ) : (
        routes.map(r => (
          <div key={r.id} style={{ ...cardStyle, cursor: 'default' }}>
            <div style={{ fontWeight: 700 }}>{r.origin} → {r.destination}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, alignItems: 'center' }}>
              <span style={{ color: '#16a34a', fontWeight: 700 }}>{formatKoboToNaira(r.base_fare)}</span>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                background: r.status === 'active' ? '#dcfce7' : '#f1f5f9',
                color: r.status === 'active' ? '#16a34a' : '#64748b',
              }}>{r.status}</span>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>ID: {r.id}</div>
          </div>
        ))
      )}
    </>
  );
}

function VehiclesPanel({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ operator_id: user?.operator_id ?? '', plate_number: '', model: '', total_seats: '', vehicle_type: 'bus' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setVehicles(await api.getVehicles());
    } catch { setVehicles([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    const operatorId = user?.operator_id ?? form.operator_id;
    if (!operatorId || !form.plate_number || !form.total_seats) {
      setError('All fields required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.createVehicle({
        operator_id: operatorId,
        plate_number: form.plate_number,
        vehicle_type: form.vehicle_type,
        total_seats: parseInt(form.total_seats, 10),
        ...(form.model ? { model: form.model } : {}),
      });
      setShowForm(false);
      setForm({ operator_id: user?.operator_id ?? '', plate_number: '', model: '', total_seats: '', vehicle_type: 'bus' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to register vehicle');
    } finally { setSaving(false); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>{t('manage_vehicles')}</h2>
        <button onClick={() => setShowForm(s => !s)} style={{ ...primaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>
      {showForm && (
        <div style={{ ...cardStyle, marginBottom: 16, cursor: 'default' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {user?.operator_id ? (
              <div style={{ padding: '10px 14px', background: '#eff6ff', borderRadius: 10, fontSize: 13, color: '#1e40af', fontWeight: 600 }}>
                Operator: {user.operator_id}
              </div>
            ) : (
              <input placeholder="Operator ID (Super Admin)" value={form.operator_id} onChange={e => setForm(f => ({ ...f, operator_id: e.target.value }))} style={inputStyle} />
            )}
            <input placeholder="Plate number (e.g. LAG-123-XY)" value={form.plate_number} onChange={e => setForm(f => ({ ...f, plate_number: e.target.value }))} style={inputStyle} />
            <input placeholder="Model (e.g. Toyota Coaster)" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} style={inputStyle} />
            <input placeholder="Capacity (seats)" type="number" value={form.total_seats} onChange={e => setForm(f => ({ ...f, total_seats: e.target.value }))} style={inputStyle} />
            <select value={form.vehicle_type} onChange={e => setForm(f => ({ ...f, vehicle_type: e.target.value }))} style={inputStyle}>
              <option value="bus">Bus</option>
              <option value="minibus">Minibus</option>
              <option value="car">Car</option>
            </select>
            {error && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{error}</p>}
            <button onClick={() => void handleCreate()} disabled={saving} style={primaryBtnStyle}>
              {saving ? t('loading') : 'Register Vehicle'}
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : vehicles.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>No vehicles found</p>
      ) : (
        vehicles.map(v => (
          <div key={v.id} style={{ ...cardStyle, cursor: 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{v.plate_number}</div>
                <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>{v.model ?? 'N/A'} · {v.total_seats} seats</div>
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                background: v.status === 'active' ? '#dcfce7' : '#f1f5f9',
                color: v.status === 'active' ? '#16a34a' : '#64748b',
              }}>{v.status}</span>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, textTransform: 'capitalize' }}>{v.vehicle_type}</div>
          </div>
        ))
      )}
    </>
  );
}

function TripsPanel({ onBack }: { onBack: () => void }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const stateColors: Record<string, string> = {
    scheduled: '#2563eb', boarding: '#d97706', in_transit: '#16a34a',
    completed: '#64748b', cancelled: '#dc2626',
  };

  const nextStates: Record<string, string[]> = {
    scheduled: ['boarding', 'cancelled'],
    boarding: ['in_transit', 'cancelled'],
    in_transit: ['completed'],
    completed: [],
    cancelled: [],
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTrips(await api.getOperatorTrips());
    } catch { setTrips([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const transition = async (tripId: string, newState: string) => {
    setUpdatingId(tripId);
    try {
      await api.transitionTrip(tripId, newState);
      await load();
    } catch { /* ignore */ } finally { setUpdatingId(null); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>Manage Trips</h2>
        <button onClick={() => void load()} style={{ ...secondaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>↻</button>
      </div>
      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : trips.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>No trips found</p>
      ) : (
        trips.map(trip => {
          const possibleNext = nextStates[trip.state] ?? [];
          return (
            <div key={trip.id} style={{ ...cardStyle, cursor: 'default' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{trip.origin ?? trip.route_id} → {trip.destination ?? ''}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                    {new Date(trip.departure_time).toLocaleString('en-NG')}
                  </div>
                </div>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 12,
                  background: `${stateColors[trip.state] ?? '#64748b'}20`,
                  color: stateColors[trip.state] ?? '#64748b',
                  whiteSpace: 'nowrap',
                }}>{trip.state.replace('_', ' ')}</span>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                {trip.available_seats ?? '—'} available
                {trip.base_fare != null && ` · ${formatKoboToNaira(trip.base_fare)}`}
              </div>
              {possibleNext.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  {possibleNext.map(ns => (
                    <button
                      key={ns}
                      disabled={updatingId === trip.id}
                      onClick={() => void transition(trip.id, ns)}
                      style={{
                        flex: 1, padding: '7px 4px', borderRadius: 8, border: '1.5px solid',
                        borderColor: stateColors[ns] ?? '#e2e8f0',
                        background: `${stateColors[ns] ?? '#64748b'}10`,
                        color: stateColors[ns] ?? '#64748b',
                        fontWeight: 600, fontSize: 11, cursor: 'pointer',
                      }}
                    >
                      → {ns.replace('_', ' ')}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}

function OperatorDashboardModule() {
  const [view, setView] = useState<OperatorView>('overview');

  return (
    <div style={{ padding: 16 }}>
      {view === 'overview' && <OperatorOverview onNav={setView} />}
      {view === 'routes' && <RoutesPanel onBack={() => setView('overview')} />}
      {view === 'vehicles' && <VehiclesPanel onBack={() => setView('overview')} />}
      {view === 'trips' && <TripsPanel onBack={() => setView('overview')} />}
    </div>
  );
}

// ============================================================
// My Bookings Module (TRN-3)
// ============================================================
function MyBookingsModule() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getBookings()
      .then(data => setBookings(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const statusColors: Record<string, string> = {
    pending: '#d97706', confirmed: '#16a34a', cancelled: '#dc2626', completed: '#64748b',
  };

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{t('my_bookings')}</h2>
      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : error ? (
        <div style={{ padding: '10px 14px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>{error}</div>
      ) : bookings.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>{t('no_trips_found')}</p>
      ) : (
        bookings.map(bkg => (
          <div key={bkg.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700 }}>
                {bkg.origin != null ? bkg.origin : '—'} → {bkg.destination != null ? bkg.destination : '—'}
              </span>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                background: `${statusColors[bkg.status] ?? '#64748b'}20`,
                color: statusColors[bkg.status] ?? '#64748b',
              }}>
                {t(bkg.status)}
              </span>
            </div>
            {bkg.departure_time != null && (
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
                {new Date(bkg.departure_time).toLocaleString('en-NG')}
              </div>
            )}
            <div style={{ fontSize: 15, fontWeight: 700, color: '#16a34a', marginTop: 4 }}>
              {formatKoboToNaira(bkg.total_amount)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ============================================================
// Role gating — which roles can see which tabs
// ============================================================
const STAFF_ROLES: WakaRole[] = ['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR', 'STAFF'];
const ADMIN_ROLES: WakaRole[] = ['SUPER_ADMIN', 'TENANT_ADMIN'];

// ============================================================
// Main App — inner shell (requires AuthProvider above it)
// ============================================================
type Tab = 'search' | 'bookings' | 'agent' | 'operator';

function AppContent() {
  const { user, isAuthenticated, isLoading, logout, hasRole } = useAuth();
  const [tab, setTab] = useState<Tab>('search');
  const [lang, setLang] = useState<Language>(getLanguage());
  const online = useOnlineStatus();
  const { pendingCount: pendingSync, isSyncing } = useSyncQueue();

  // Auto-logout when JWT expires mid-session
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener('waka:unauthorized', handler);
    return () => window.removeEventListener('waka:unauthorized', handler);
  }, [logout]);

  const handleLangChange = (l: Language) => {
    setLanguage(l);
    setLang(l);
  };

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ textAlign: 'center', color: '#94a3b8' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🚌</div>
          <div>Loading…</div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  // Build tabs based on role
  const tabs: Array<{ id: Tab; icon: string; label: string }> = [
    { id: 'search', icon: '🔍', label: t('search_trips') },
    { id: 'bookings', icon: '🎫', label: t('my_bookings') },
    ...(hasRole(STAFF_ROLES) ? [{ id: 'agent' as Tab, icon: '💰', label: t('agent_pos') }] : []),
    ...(hasRole(ADMIN_ROLES) ? [{ id: 'operator' as Tab, icon: '🚌', label: t('operator') }] : []),
  ];

  // Reset tab if current tab is no longer visible (e.g. after role change)
  const validTab = tabs.some(t => t.id === tab) ? tab : 'search';

  const roleLabel: Record<string, string> = {
    CUSTOMER: 'Customer', STAFF: 'Agent', SUPERVISOR: 'Supervisor',
    TENANT_ADMIN: 'Operator Admin', SUPER_ADMIN: 'Super Admin', DRIVER: 'Driver',
  };

  return (
    <div data-testid="transport-app" style={{ maxWidth: 430, margin: '0 auto', minHeight: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif', background: '#f8fafc' }}>
      <StatusBar online={online} pendingSync={pendingSync} syncing={isSyncing} lang={lang} onLangChange={handleLangChange} />

      {/* App header with user strip */}
      <div style={{ background: '#1e40af', color: '#fff', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>🚌 {t('app_name')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.95 }}>
              {user?.name ?? user?.phone}
            </div>
            <div style={{ fontSize: 10, opacity: 0.7 }}>
              {roleLabel[user?.role ?? ''] ?? user?.role}
            </div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            style={{
              background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff',
              borderRadius: 8, padding: '5px 10px', fontSize: 12, cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 70 }}>
        <ErrorBoundary label="Trip Search">
          {validTab === 'search' && <TripSearchModule />}
        </ErrorBoundary>
        <ErrorBoundary label="My Bookings">
          {validTab === 'bookings' && <MyBookingsModule />}
        </ErrorBoundary>
        <ErrorBoundary label="Agent POS">
          {validTab === 'agent' && <AgentPOSModule online={online} />}
        </ErrorBoundary>
        <ErrorBoundary label="Operator Dashboard">
          {validTab === 'operator' && <OperatorDashboardModule />}
        </ErrorBoundary>
      </div>

      {/* Mobile-First bottom navigation */}
      <nav style={{
        position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        width: '100%', maxWidth: 430, background: '#fff',
        borderTop: '1px solid #e2e8f0', display: 'flex',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {tabs.map(({ id, icon, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            flex: 1, padding: '10px 4px 8px', border: 'none', background: 'none', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            color: validTab === id ? '#1e40af' : '#94a3b8',
            borderTop: validTab === id ? '2px solid #1e40af' : '2px solid transparent',
          }}>
            <span style={{ fontSize: 20 }}>{icon}</span>
            <span style={{ fontSize: 10, fontWeight: validTab === id ? 700 : 400 }}>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ============================================================
// Main export — AuthProvider wraps everything
// ============================================================
export function TransportApp() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

// ============================================================
// Shared Styles
// ============================================================
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px', borderRadius: 10, border: '1.5px solid #e2e8f0',
  fontSize: 15, background: '#fff', boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '14px 20px', borderRadius: 10, border: 'none',
  background: '#1e40af', color: '#fff', fontWeight: 700, fontSize: 15,
  cursor: 'pointer', minHeight: 48,
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '12px 16px', borderRadius: 10, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#1e40af', fontWeight: 600, fontSize: 14,
  cursor: 'pointer', minHeight: 44,
};

const backBtnStyle: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 8, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13, cursor: 'pointer',
};

const cardStyle: React.CSSProperties = {
  background: '#fff', borderRadius: 12, padding: 14, marginBottom: 10,
  border: '1.5px solid #e2e8f0', cursor: 'pointer',
};

const navCardStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  padding: '20px 12px', borderRadius: 12, border: '1.5px solid #e2e8f0',
  background: '#fff', cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
  marginBottom: 0,
};
