/**
 * WebWaka Transport Suite — Mobile-First PWA
 * Modules: TRN-1 Seat Inventory, TRN-2 Agent POS, TRN-3 Booking Portal, TRN-4 Operator Dashboard
 * Invariants: Mobile-First, PWA-First, Offline-First, Nigeria-First (₦), Africa-First (4 languages)
 */
import React, { useState, useEffect, useCallback } from 'react';
import { t, setLanguage, getLanguage, getSupportedLanguages, formatKoboToNaira, type Language } from './core/i18n/index';
import { getPendingMutationCount } from './core/offline/db';

// ============================================================
// Hooks
// ============================================================
function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

function usePendingSync(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const poll = async () => setCount(await getPendingMutationCount());
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);
  return count;
}

// ============================================================
// Status Bar
// ============================================================
function StatusBar({ online, pendingSync, lang, onLangChange }: {
  online: boolean; pendingSync: number; lang: Language; onLangChange: (l: Language) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 16px', fontSize: 11, fontWeight: 600,
      background: online ? '#16a34a' : '#dc2626', color: '#fff',
    }}>
      <span>{online ? `● ${t('online')}` : `○ ${t('offline')}`}</span>
      {pendingSync > 0 && <span>⟳ {pendingSync} {t('pending_sync')}</span>}
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
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [trips, setTrips] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<any>(null);
  const [ndprConsent, setNdprConsent] = useState(false);

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ origin, destination, date });
      const res = await fetch(`/api/booking/trips/search?${params}`);
      const data = await res.json() as any;
      setTrips(data.data ?? []);
    } catch {
      setTrips([]);
    } finally {
      setLoading(false);
    }
  }, [origin, destination, date]);

  if (selectedTrip) {
    return (
      <div style={{ padding: 16 }}>
        <button onClick={() => setSelectedTrip(null)} style={backBtnStyle}>← {t('back')}</button>
        <h3 style={{ margin: '12px 0 8px' }}>{selectedTrip.origin} → {selectedTrip.destination}</h3>
        <p style={{ color: '#64748b', fontSize: 13 }}>
          {t('departure')}: {new Date(selectedTrip.departure_time).toLocaleString('en-NG')}
        </p>
        <p style={{ fontSize: 18, fontWeight: 700, color: '#16a34a' }}>
          {formatKoboToNaira(selectedTrip.base_fare)}
        </p>
        <p style={{ color: '#64748b', fontSize: 13 }}>{selectedTrip.available_seats} {t('available_seats')}</p>
        <div style={{ marginTop: 16, padding: 12, background: '#fef9c3', borderRadius: 8, fontSize: 12 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={ndprConsent} onChange={e => setNdprConsent(e.target.checked)} />
            <span>{t('ndpr_consent')}</span>
          </label>
        </div>
        <button
          onClick={() => { if (!ndprConsent) { alert(t('ndpr_required')); return; } alert(t('booking_confirmed')); }}
          style={{ ...primaryBtnStyle, marginTop: 16, width: '100%' }}
        >
          {t('confirm_booking')}
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{t('search_trips')}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input placeholder={t('origin')} value={origin} onChange={e => setOrigin(e.target.value)} style={inputStyle} />
        <input placeholder={t('destination')} value={destination} onChange={e => setDestination(e.target.value)} style={inputStyle} />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        <button onClick={search} style={primaryBtnStyle}>{loading ? t('loading') : t('search')}</button>
      </div>
      <div style={{ marginTop: 20 }}>
        {trips.length === 0 && !loading && (
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
  const [tripId, setTripId] = useState('');
  const [seatIds, setSeatIds] = useState('');
  const [passengers, setPassengers] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'mobile_money' | 'card'>('cash');
  const [lastReceipt, setLastReceipt] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSale = async () => {
    if (!tripId || !seatIds || !passengers || !amount) return;
    setSubmitting(true);
    const amountKobo = Math.round(parseFloat(amount) * 100);
    const seatArr = seatIds.split(',').map(s => s.trim());
    const passArr = passengers.split(',').map(p => p.trim());

    if (!online) {
      // Offline-First: queue locally
      const { saveOfflineTransaction } = await import('./core/offline/db');
      await saveOfflineTransaction({
        local_id: `local_${Date.now()}`,
        agent_id: 'current_agent',
        trip_id: tripId,
        seat_ids: seatArr,
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
      const res = await fetch('/api/agent-sales/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: 'current_agent', trip_id: tripId,
          seat_ids: seatArr, passenger_names: passArr,
          total_amount: amountKobo, payment_method: method,
        }),
      });
      const data = await res.json() as any;
      if (data.success) {
        setLastReceipt(data.data);
        setTripId(''); setSeatIds(''); setPassengers(''); setAmount('');
      }
    } catch { alert(t('error')); }
    setSubmitting(false);
  };

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{t('agent_pos')}</h2>
      {lastReceipt && (
        <div style={{ ...cardStyle, background: '#f0fdf4', borderColor: '#16a34a', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, color: '#16a34a' }}>✓ {t('sale_complete')}</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {t('fare')}: {formatKoboToNaira(lastReceipt.total_amount)} · {lastReceipt.payment_method}
          </div>
          <div style={{ fontSize: 12, color: '#64748b' }}>Receipt: {lastReceipt.receipt_id}</div>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input placeholder={t('select_trip')} value={tripId} onChange={e => setTripId(e.target.value)} style={inputStyle} />
        <input placeholder={`${t('select_seats_pos')} (s1, s2)`} value={seatIds} onChange={e => setSeatIds(e.target.value)} style={inputStyle} />
        <input placeholder={`${t('passenger_name')} (Amaka, Chidi)`} value={passengers} onChange={e => setPassengers(e.target.value)} style={inputStyle} />
        <input placeholder={`${t('fare')} (₦)`} type="number" value={amount} onChange={e => setAmount(e.target.value)} style={inputStyle} />
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
        <button onClick={handleSale} disabled={submitting} style={primaryBtnStyle}>
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
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/operator/dashboard')
      .then(r => r.json())
      .then((d: any) => setStats(d.data))
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
                <div style={{ fontSize: 22, fontWeight: 800, color: stateColors[state] }}>{stats?.trips?.[state] ?? 0}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, textTransform: 'capitalize' }}>{state.replace('_', ' ')}</div>
              </div>
            ))}
            {stats?.today_revenue_kobo != null && (
              <div style={{ ...cardStyle, borderLeft: '4px solid #16a34a', cursor: 'default', gridColumn: 'span 2' }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#16a34a' }}>
                  {formatKoboToNaira(stats.today_revenue_kobo as number)}
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
  const [routes, setRoutes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ origin: '', destination: '', base_fare: '', operator_id: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/operator/routes');
      const d = await r.json() as any;
      setRoutes(d.data ?? []);
    } catch { setRoutes([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!form.origin || !form.destination || !form.base_fare || !form.operator_id) {
      setError('All fields required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/operator/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, base_fare: Math.round(parseFloat(form.base_fare) * 100) }),
      });
      const d = await r.json() as any;
      if (d.success) {
        setShowForm(false);
        setForm({ origin: '', destination: '', base_fare: '', operator_id: '' });
        await load();
      } else {
        setError(d.error ?? 'Failed to create route');
      }
    } catch { setError('Network error'); } finally { setSaving(false); }
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
            <input placeholder="Operator ID" value={form.operator_id} onChange={e => setForm(f => ({ ...f, operator_id: e.target.value }))} style={inputStyle} />
            {error && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{error}</p>}
            <button onClick={handleCreate} disabled={saving} style={primaryBtnStyle}>{saving ? t('loading') : 'Create Route'}</button>
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
              <span style={{ color: '#16a34a', fontWeight: 700 }}>{formatKoboToNaira(r.base_fare as number)}</span>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                background: r.status === 'active' ? '#dcfce7' : '#f1f5f9',
                color: r.status === 'active' ? '#16a34a' : '#64748b',
              }}>{r.status as string}</span>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>ID: {r.id as string}</div>
          </div>
        ))
      )}
    </>
  );
}

function VehiclesPanel({ onBack }: { onBack: () => void }) {
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ operator_id: '', plate_number: '', model: '', capacity: '', vehicle_type: 'bus' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/operator/vehicles');
      const d = await r.json() as any;
      setVehicles(d.data ?? []);
    } catch { setVehicles([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!form.operator_id || !form.plate_number || !form.model || !form.capacity) {
      setError('All fields required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/operator/vehicles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, capacity: parseInt(form.capacity, 10) }),
      });
      const d = await r.json() as any;
      if (d.success) {
        setShowForm(false);
        setForm({ operator_id: '', plate_number: '', model: '', capacity: '', vehicle_type: 'bus' });
        await load();
      } else {
        setError(d.error ?? 'Failed to register vehicle');
      }
    } catch { setError('Network error'); } finally { setSaving(false); }
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
            <input placeholder="Operator ID" value={form.operator_id} onChange={e => setForm(f => ({ ...f, operator_id: e.target.value }))} style={inputStyle} />
            <input placeholder="Plate number (e.g. LAG-123-XY)" value={form.plate_number} onChange={e => setForm(f => ({ ...f, plate_number: e.target.value }))} style={inputStyle} />
            <input placeholder="Model (e.g. Toyota Coaster)" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} style={inputStyle} />
            <input placeholder="Capacity (seats)" type="number" value={form.capacity} onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))} style={inputStyle} />
            <select value={form.vehicle_type} onChange={e => setForm(f => ({ ...f, vehicle_type: e.target.value }))} style={inputStyle}>
              <option value="bus">Bus</option>
              <option value="minibus">Minibus</option>
              <option value="car">Car</option>
            </select>
            {error && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{error}</p>}
            <button onClick={handleCreate} disabled={saving} style={primaryBtnStyle}>{saving ? t('loading') : 'Register Vehicle'}</button>
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
                <div style={{ fontWeight: 700 }}>{v.plate_number as string}</div>
                <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>{v.model as string} · {v.capacity as number} seats</div>
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                background: v.status === 'active' ? '#dcfce7' : '#f1f5f9',
                color: v.status === 'active' ? '#16a34a' : '#64748b',
              }}>{v.status as string}</span>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, textTransform: 'capitalize' }}>{v.vehicle_type as string}</div>
          </div>
        ))
      )}
    </>
  );
}

function TripsPanel({ onBack }: { onBack: () => void }) {
  const [trips, setTrips] = useState<any[]>([]);
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
      const r = await fetch('/api/operator/trips');
      const d = await r.json() as any;
      setTrips(d.data ?? []);
    } catch { setTrips([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const transition = async (tripId: string, newState: string) => {
    setUpdatingId(tripId);
    try {
      await fetch(`/api/operator/trips/${tripId}/state`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: newState }),
      });
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
          const possibleNext = nextStates[trip.state as string] ?? [];
          return (
            <div key={trip.id} style={{ ...cardStyle, cursor: 'default' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{trip.origin as string} → {trip.destination as string}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                    {new Date(trip.departure_time as number).toLocaleString('en-NG')}
                  </div>
                </div>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 12,
                  background: `${stateColors[trip.state as string]}20`,
                  color: stateColors[trip.state as string],
                  whiteSpace: 'nowrap',
                }}>{(trip.state as string).replace('_', ' ')}</span>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                {trip.available_seats as number} available · {formatKoboToNaira(trip.base_fare as number)}
              </div>
              {possibleNext.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  {possibleNext.map(ns => (
                    <button
                      key={ns}
                      disabled={updatingId === trip.id}
                      onClick={() => void transition(trip.id as string, ns)}
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
  const [bookings, setBookings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/booking/bookings')
      .then(r => r.json())
      .then((d: any) => setBookings(d.data ?? []))
      .catch(() => setBookings([]))
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
      ) : bookings.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>{t('no_trips_found')}</p>
      ) : (
        bookings.map(bkg => (
          <div key={bkg.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700 }}>{bkg.origin} → {bkg.destination}</span>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                background: `${statusColors[bkg.status]}20`, color: statusColors[bkg.status],
              }}>
                {t(bkg.status)}
              </span>
            </div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
              {new Date(bkg.departure_time).toLocaleString('en-NG')}
            </div>
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
// Main App
// ============================================================
type Tab = 'search' | 'bookings' | 'agent' | 'operator';

export function TransportApp() {
  const [tab, setTab] = useState<Tab>('search');
  const [lang, setLang] = useState<Language>(getLanguage());
  const online = useOnlineStatus();
  const pendingSync = usePendingSync();

  const handleLangChange = (l: Language) => {
    setLanguage(l);
    setLang(l);
  };

  const tabs: Array<{ id: Tab; icon: string; label: string }> = [
    { id: 'search', icon: '🔍', label: t('search_trips') },
    { id: 'bookings', icon: '🎫', label: t('my_bookings') },
    { id: 'agent', icon: '💰', label: t('agent_pos') },
    { id: 'operator', icon: '🚌', label: t('operator') },
  ];

  return (
    <div data-testid="transport-app" style={{ maxWidth: 430, margin: '0 auto', minHeight: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif', background: '#f8fafc' }}>
      <StatusBar online={online} pendingSync={pendingSync} lang={lang} onLangChange={handleLangChange} />
      <div style={{ background: '#1e40af', color: '#fff', padding: '12px 16px', fontWeight: 800, fontSize: 18 }}>
        🚌 {t('app_name')}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 70 }}>
        {tab === 'search' && <TripSearchModule />}
        {tab === 'bookings' && <MyBookingsModule />}
        {tab === 'agent' && <AgentPOSModule online={online} />}
        {tab === 'operator' && <OperatorDashboardModule />}
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
            color: tab === id ? '#1e40af' : '#94a3b8',
            borderTop: tab === id ? '2px solid #1e40af' : '2px solid transparent',
          }}>
            <span style={{ fontSize: 20 }}>{icon}</span>
            <span style={{ fontSize: 10, fontWeight: tab === id ? 700 : 400 }}>{label}</span>
          </button>
        ))}
      </nav>
    </div>
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
