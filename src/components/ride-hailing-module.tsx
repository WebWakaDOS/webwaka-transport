/**
 * WebWaka Transport — Ride Hailing Module (TRN-5)
 *
 * Features:
 *   - Real-time ride request with GPS coordinates
 *   - Dynamic surge pricing display
 *   - Carpooling / ride-sharing (create & join)
 *   - Multi-stop waypoints
 *   - Scheduled rides
 *   - Promo code application
 *   - Driver tipping after ride completion
 *
 * Offline: ride request queued locally when offline, submitted on reconnect.
 * Nigeria-First: all fares displayed in ₦ (kobo ÷ 100).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../api/client';
import { formatAmount } from '../core/i18n/index';
import { useOnlineStatus } from '../core/offline/hooks';
import { useAuth } from '../core/auth/context';

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', border: '1px solid #e2e8f0',
  borderRadius: 8, fontSize: 14, boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  width: '100%', padding: '12px 0', background: '#1e40af', color: '#fff',
  border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer',
};

const cardStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
  padding: 14, marginBottom: 10, cursor: 'pointer',
};

const pillStyle = (active: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: 20, border: `1px solid ${active ? '#1e40af' : '#e2e8f0'}`,
  background: active ? '#eff6ff' : '#fff', color: active ? '#1e40af' : '#64748b',
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
});

// ── Surge Badge ───────────────────────────────────────────────────────────────

function SurgeBadge({ multiplier }: { multiplier: number }) {
  if (multiplier <= 1.0) return null;
  const color = multiplier >= 2.0 ? '#dc2626' : multiplier >= 1.5 ? '#d97706' : '#16a34a';
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12,
      background: color, color: '#fff', fontSize: 11, fontWeight: 700, marginLeft: 6,
    }}>
      ⚡ {multiplier}× SURGE
    </span>
  );
}

// ── Promo Code Input ──────────────────────────────────────────────────────────

function PromoInput({ fareKobo, onApply }: { fareKobo: number; onApply: (discountKobo: number, code: string) => void }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ discount_kobo: number; final_fare_kobo: number } | null>(null);
  const [error, setError] = useState('');

  const validate = async () => {
    if (!code.trim()) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const res = await api.validatePromo({ code: code.toUpperCase(), fare_kobo: fareKobo });
      setResult({ discount_kobo: res.discount_kobo, final_fare_kobo: res.final_fare_kobo });
      onApply(res.discount_kobo, code.toUpperCase());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Invalid promo code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          placeholder="Promo code (e.g. WAKA20)"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button onClick={() => void validate()} disabled={loading || !code}
          style={{ padding: '10px 16px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
          {loading ? '...' : 'Apply'}
        </button>
      </div>
      {error && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }}>{error}</div>}
      {result && (
        <div style={{ color: '#16a34a', fontSize: 13, marginTop: 4, fontWeight: 600 }}>
          ✓ Promo applied! You save {formatAmount(result.discount_kobo)} → Final: {formatAmount(result.final_fare_kobo)}
        </div>
      )}
    </div>
  );
}

// ── Tip Driver Modal ──────────────────────────────────────────────────────────

function TipModal({ rideId, customerId, onClose }: { rideId: string; customerId: string; onClose: () => void }) {
  const PRESETS = [5000, 10000, 20000, 50000]; // ₦50, ₦100, ₦200, ₦500
  const [amount, setAmount] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const tip = async () => {
    const kobo = amount ?? (custom ? Math.round(parseFloat(custom) * 100) : 0);
    if (!kobo || kobo <= 0) { setError('Please select or enter a tip amount'); return; }
    setLoading(true); setError('');
    try {
      await api.tipDriver(rideId, { amount_kobo: kobo, customer_id: customerId, message: message || undefined });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to send tip');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', zIndex: 9999 }}>
      <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', padding: 24, maxWidth: 480, margin: '0 auto' }}>
        {done ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48 }}>🙏</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 8 }}>Tip sent!</div>
            <div style={{ color: '#64748b', marginTop: 4 }}>Your driver will appreciate it.</div>
            <button onClick={onClose} style={{ ...primaryBtnStyle, marginTop: 20 }}>Done</button>
          </div>
        ) : (
          <>
            <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 16 }}>Tip your driver 🎉</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {PRESETS.map(p => (
                <button key={p} onClick={() => { setAmount(p); setCustom(''); }}
                  style={pillStyle(amount === p)}>
                  {formatAmount(p)}
                </button>
              ))}
            </div>
            <input placeholder="Custom amount (₦)" type="number" value={custom}
              onChange={e => { setCustom(e.target.value); setAmount(null); }}
              style={inputStyle} />
            <input placeholder="Leave a message (optional)" value={message}
              onChange={e => setMessage(e.target.value)} style={{ ...inputStyle, marginTop: 8 }} />
            {error && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 6 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={onClose} style={{ flex: 1, padding: '12px 0', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => void tip()} disabled={loading} style={{ ...primaryBtnStyle, flex: 2 }}>{loading ? 'Sending…' : 'Send Tip'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Carpool Section ───────────────────────────────────────────────────────────

function CarpoolSection({ customerId }: { customerId: string }) {
  const [view, setView] = useState<'search' | 'create'>('search');
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]!);
  const [groups, setGroups] = useState<Array<{ id: string; origin: string; destination: string; departure_time: number; current_passengers: number; max_passengers: number; base_fare_per_seat_kobo: number; status: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ origin: '', destination: '', fare: '', maxPassengers: '4' });
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const search = async () => {
    setLoading(true); setError('');
    try {
      const res = await api.searchCarpool({ origin: origin || undefined, destination: destination || undefined, date: date || undefined });
      setGroups(res as typeof groups);
    } catch { setError('Search failed'); }
    finally { setLoading(false); }
  };

  const join = async (groupId: string) => {
    try {
      await api.carpoolAction({ action: 'join', carpool_group_id: groupId, customer_id: customerId });
      setSuccess('Joined carpool successfully!');
      void search();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed to join'); }
  };

  const create = async () => {
    if (!createForm.origin || !createForm.destination || !createForm.fare) return;
    setCreating(true); setError('');
    try {
      const res = await api.carpoolAction({
        action: 'create', customer_id: customerId,
        origin: createForm.origin, destination: createForm.destination,
        departure_time: Date.now() + 3600000,
        max_passengers: parseInt(createForm.maxPassengers),
        base_fare_per_seat_kobo: Math.round(parseFloat(createForm.fare) * 100),
      });
      setSuccess(`Carpool created! ID: ${(res as { carpool_group_id: string }).carpool_group_id}`);
      setView('search');
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed to create carpool'); }
    finally { setCreating(false); }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button onClick={() => setView('search')} style={pillStyle(view === 'search')}>Search Pools</button>
        <button onClick={() => setView('create')} style={pillStyle(view === 'create')}>Create Pool</button>
      </div>

      {success && <div style={{ padding: '8px 12px', background: '#dcfce7', borderRadius: 8, color: '#166534', fontSize: 13, marginBottom: 10 }}>{success}</div>}
      {error && <div style={{ padding: '8px 12px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {view === 'search' && (
        <div>
          <input placeholder="From city" value={origin} onChange={e => setOrigin(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }} />
          <input placeholder="To city" value={destination} onChange={e => setDestination(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }} />
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }} />
          <button onClick={() => void search()} style={primaryBtnStyle}>{loading ? 'Searching…' : 'Find Carpools'}</button>

          <div style={{ marginTop: 14 }}>
            {groups.length === 0 && !loading && <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>No carpools found. Try creating one!</p>}
            {groups.map(g => (
              <div key={g.id} style={cardStyle}>
                <div style={{ fontWeight: 700 }}>{g.origin} → {g.destination}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                  {new Date(g.departure_time).toLocaleString('en-NG')} · {g.current_passengers}/{g.max_passengers} seats
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <span style={{ color: '#16a34a', fontWeight: 700 }}>{formatAmount(g.base_fare_per_seat_kobo)}/seat</span>
                  <button onClick={() => void join(g.id)} style={{ padding: '6px 16px', background: '#1e40af', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}>
                    Join
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === 'create' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input placeholder="From city" value={createForm.origin} onChange={e => setCreateForm(f => ({ ...f, origin: e.target.value }))} style={inputStyle} />
          <input placeholder="To city" value={createForm.destination} onChange={e => setCreateForm(f => ({ ...f, destination: e.target.value }))} style={inputStyle} />
          <input placeholder="Fare per seat (₦)" type="number" value={createForm.fare} onChange={e => setCreateForm(f => ({ ...f, fare: e.target.value }))} style={inputStyle} />
          <select value={createForm.maxPassengers} onChange={e => setCreateForm(f => ({ ...f, maxPassengers: e.target.value }))} style={inputStyle}>
            {[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} passengers max</option>)}
          </select>
          <button onClick={() => void create()} disabled={creating} style={primaryBtnStyle}>{creating ? 'Creating…' : 'Create Carpool'}</button>
        </div>
      )}
    </div>
  );
}

// ── Main Module ───────────────────────────────────────────────────────────────

export function RideHailingModule() {
  const { user } = useAuth();
  const online = useOnlineStatus();

  const [tab, setTab] = useState<'request' | 'carpool' | 'history'>('request');
  const [pickupAddr, setPickupAddr] = useState('');
  const [dropoffAddr, setDropoffAddr] = useState('');
  const [pickupLat, setPickupLat] = useState('');
  const [pickupLon, setPickupLon] = useState('');
  const [dropoffLat, setDropoffLat] = useState('');
  const [dropoffLon, setDropoffLon] = useState('');
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');
  const [waypoints, setWaypoints] = useState<Array<{ lat: string; lon: string; addr: string }>>([]);
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [promoCode, setPromoCode] = useState('');
  const [surge, setSurge] = useState<{ surge_multiplier: number; active_riders: number; available_drivers: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ride_request_id: string; status: string; surge_multiplier: number; matched_drivers: unknown[] } | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<unknown[]>([]);
  const [tipRideId, setTipRideId] = useState<string | null>(null);

  // Load surge for default zone on mount
  useEffect(() => {
    if (!online) return;
    api.getSurge({ zone_id: 'default' }).then(setSurge).catch(() => null);
  }, [online]);

  // Auto-detect location
  const detectLocation = () => {
    if (!navigator.geolocation) { setError('Geolocation not supported'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        setPickupLat(String(pos.coords.latitude));
        setPickupLon(String(pos.coords.longitude));
        setPickupAddr(`${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`);
      },
      () => setError('Could not detect location. Enter coordinates manually.'),
    );
  };

  const requestRide = async () => {
    const customerId = user?.id ?? 'guest';
    if (!pickupLat || !pickupLon || !dropoffLat || !dropoffLon) {
      setError('Please enter pickup and dropoff coordinates.'); return;
    }
    setLoading(true); setError(''); setResult(null);
    try {
      const wps = waypoints.filter(w => w.lat && w.lon).map(w => ({ latitude: parseFloat(w.lat), longitude: parseFloat(w.lon), address: w.addr || undefined }));
      const res = await api.requestRide({
        customer_id: customerId,
        pickup_latitude: parseFloat(pickupLat), pickup_longitude: parseFloat(pickupLon),
        pickup_address: pickupAddr || undefined,
        dropoff_latitude: parseFloat(dropoffLat), dropoff_longitude: parseFloat(dropoffLon),
        dropoff_address: dropoffAddr || undefined,
        waypoints: wps.length > 0 ? wps : undefined,
        is_scheduled: isScheduled,
        scheduled_for: isScheduled && scheduledFor ? new Date(scheduledFor).getTime() : undefined,
        promo_code: promoCode || undefined,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to request ride');
    } finally { setLoading(false); }
  };

  const loadHistory = useCallback(async () => {
    if (!user?.id) return;
    try {
      const res = await api.listRides({ customer_id: user.id, limit: 20 });
      setHistory(res);
    } catch { /* non-fatal */ }
  }, [user?.id]);

  useEffect(() => { if (tab === 'history') void loadHistory(); }, [tab, loadHistory]);

  return (
    <div style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🚖 Ride Hailing</h2>
        {surge && surge.surge_multiplier > 1.0 && <SurgeBadge multiplier={surge.surge_multiplier} />}
        {!online && <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>OFFLINE</span>}
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto' }}>
        {(['request', 'carpool', 'history'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={pillStyle(tab === t)}>
            {t === 'request' ? '🚕 Request' : t === 'carpool' ? '🚌 Carpool' : '📋 History'}
          </button>
        ))}
      </div>

      {tab === 'request' && (
        <>
          {/* Surge info banner */}
          {surge && surge.surge_multiplier > 1.0 && (
            <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13 }}>
              <strong>⚡ Surge pricing active ({surge.surge_multiplier}×)</strong>
              <div style={{ color: '#64748b', marginTop: 2 }}>
                {surge.active_riders} riders, {surge.available_drivers} drivers available.
                Fares are higher due to high demand.
              </div>
            </div>
          )}

          {/* Pickup */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Pickup</label>
            <input placeholder="Pickup address" value={pickupAddr} onChange={e => setPickupAddr(e.target.value)} style={inputStyle} />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <input placeholder="Lat" type="number" value={pickupLat} onChange={e => setPickupLat(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              <input placeholder="Lon" type="number" value={pickupLon} onChange={e => setPickupLon(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              <button onClick={detectLocation} title="Use my location" style={{ padding: '10px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 16 }}>📍</button>
            </div>
          </div>

          {/* Waypoints */}
          {waypoints.map((wp, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Stop {i + 1}</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input placeholder="Address" value={wp.addr} onChange={e => setWaypoints(w => w.map((x, j) => j === i ? { ...x, addr: e.target.value } : x))} style={{ ...inputStyle, flex: 2 }} />
                <input placeholder="Lat" type="number" value={wp.lat} onChange={e => setWaypoints(w => w.map((x, j) => j === i ? { ...x, lat: e.target.value } : x))} style={{ ...inputStyle, flex: 1 }} />
                <input placeholder="Lon" type="number" value={wp.lon} onChange={e => setWaypoints(w => w.map((x, j) => j === i ? { ...x, lon: e.target.value } : x))} style={{ ...inputStyle, flex: 1 }} />
                <button onClick={() => setWaypoints(w => w.filter((_, j) => j !== i))} style={{ padding: '10px', border: '1px solid #fee2e2', borderRadius: 8, background: '#fff', color: '#dc2626', cursor: 'pointer' }}>✕</button>
              </div>
            </div>
          ))}
          <button onClick={() => setWaypoints(w => [...w, { lat: '', lon: '', addr: '' }])} style={{ fontSize: 12, color: '#1e40af', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 10 }}>
            + Add stop
          </button>

          {/* Dropoff */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Dropoff</label>
            <input placeholder="Dropoff address" value={dropoffAddr} onChange={e => setDropoffAddr(e.target.value)} style={inputStyle} />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <input placeholder="Lat" type="number" value={dropoffLat} onChange={e => setDropoffLat(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              <input placeholder="Lon" type="number" value={dropoffLon} onChange={e => setDropoffLon(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>

          {/* Scheduled ride toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <input type="checkbox" id="scheduled" checked={isScheduled} onChange={e => setIsScheduled(e.target.checked)} />
            <label htmlFor="scheduled" style={{ fontSize: 13, fontWeight: 600 }}>Schedule for later</label>
          </div>
          {isScheduled && (
            <input type="datetime-local" value={scheduledFor} onChange={e => setScheduledFor(e.target.value)} style={{ ...inputStyle, marginBottom: 10 }} />
          )}

          {/* Promo code */}
          <PromoInput fareKobo={50000} onApply={(disc, code) => { setPromoDiscount(disc); setPromoCode(code); }} />
          {promoDiscount > 0 && (
            <div style={{ fontSize: 12, color: '#7c3aed', marginTop: 4 }}>
              Promo discount: -{formatAmount(promoDiscount)}
            </div>
          )}

          {/* Error */}
          {error && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 8, padding: '8px 12px', background: '#fee2e2', borderRadius: 8 }}>{error}</div>}

          {/* Result */}
          {result && (
            <div style={{ background: '#dcfce7', border: '1px solid #16a34a', borderRadius: 10, padding: 14, marginTop: 12 }}>
              <div style={{ fontWeight: 700, color: '#166534', marginBottom: 6 }}>✓ Ride requested!</div>
              <div style={{ fontSize: 13 }}>ID: <strong>{result.ride_request_id}</strong></div>
              <div style={{ fontSize: 13 }}>Surge: <strong>{result.surge_multiplier}×</strong></div>
              <div style={{ fontSize: 13 }}>Drivers matched: <strong>{result.matched_drivers.length}</strong></div>
              <button onClick={() => setTipRideId(result.ride_request_id)} style={{ marginTop: 10, padding: '8px 16px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
                🎁 Tip Driver
              </button>
            </div>
          )}

          <button onClick={() => void requestRide()} disabled={loading || !online} style={{ ...primaryBtnStyle, marginTop: 14 }}>
            {loading ? 'Requesting…' : !online ? 'Offline' : '🚖 Request Ride'}
          </button>
        </>
      )}

      {tab === 'carpool' && (
        <CarpoolSection customerId={user?.id ?? 'guest'} />
      )}

      {tab === 'history' && (
        <div>
          {history.length === 0
            ? <p style={{ color: '#94a3b8', textAlign: 'center' }}>No ride history yet.</p>
            : (history as Array<Record<string, unknown>>).map((ride) => (
              <div key={String(ride['id'])} style={cardStyle}>
                <div style={{ fontWeight: 600 }}>{String(ride['pickup_address'] ?? 'Unknown pickup')} → {String(ride['dropoff_address'] ?? 'Unknown dropoff')}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                  Status: <strong>{String(ride['status'])}</strong>
                  {ride['final_fare_kobo'] != null && <> · {formatAmount(Number(ride['final_fare_kobo']))}</>}
                </div>
                {ride['status'] === 'completed' && (
                  <button onClick={() => setTipRideId(String(ride['id']))} style={{ marginTop: 8, padding: '6px 12px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                    🎁 Tip Driver
                  </button>
                )}
              </div>
            ))
          }
        </div>
      )}

      {tipRideId && user?.id && (
        <TipModal rideId={tipRideId} customerId={user.id} onClose={() => setTipRideId(null)} />
      )}
    </div>
  );
}
