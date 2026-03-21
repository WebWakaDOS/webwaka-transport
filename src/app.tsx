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
// Operator Dashboard Module (TRN-4)
// ============================================================
function OperatorDashboardModule() {
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
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{t('operator')}</h2>
      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            {tripStates.map(state => (
              <div key={state} style={{ ...cardStyle, borderLeft: `4px solid ${stateColors[state]}` }}>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{stats?.trips?.[state] ?? 0}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{t(state)}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={{ ...secondaryBtnStyle, flex: 1 }}>{t('manage_routes')}</button>
            <button style={{ ...secondaryBtnStyle, flex: 1 }}>{t('manage_vehicles')}</button>
          </div>
        </>
      )}
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
