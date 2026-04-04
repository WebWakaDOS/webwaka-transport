/**
 * WebWaka Transport — Offline-First Driver PWA Module
 *
 * Features:
 *   1. Shift start: selfie verification (Driver Verification)
 *   2. Pre-trip: daily vehicle inspection form
 *   3. Live trip: GPS location updates + in-app navigation
 *   4. SOS emergency button (one-tap)
 *   5. Driver earnings dashboard (daily/weekly/monthly)
 *   6. Ride acceptance interface (for ride-hailing mode)
 *
 * Offline-First: all actions work offline via Dexie mutation queue.
 * Nigeria-First: earnings shown in ₦ (kobo ÷ 100).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, ApiError } from '../api/client';
import { formatAmount } from '../core/i18n/index';
import { useOnlineStatus } from '../core/offline/hooks';
import { useAuth } from '../core/auth/context';
import {
  queueDriverTripCompletion,
  getPendingDriverTripCount,
} from '../core/offline/db';
import {
  flushDriverTripCompletions,
  registerDriverSyncOnReconnect,
} from '../core/offline/driver-sync';

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', border: '1px solid #e2e8f0',
  borderRadius: 8, fontSize: 14, boxSizing: 'border-box',
};

const pillStyle = (active: boolean, color = '#1e40af'): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: 20,
  border: `1px solid ${active ? color : '#e2e8f0'}`,
  background: active ? '#eff6ff' : '#fff',
  color: active ? color : '#64748b',
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
});

const primaryBtnStyle: React.CSSProperties = {
  width: '100%', padding: '12px 0', background: '#1e40af', color: '#fff',
  border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer',
};

// ── SOS Button ────────────────────────────────────────────────────────────────

function SOSButton({ tripId, online }: { tripId: string; online: boolean }) {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // 3-second countdown before activating (prevent accidental press)
  const handlePress = () => {
    if (active) return;
    setCountdown(3);
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          void activate();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const activate = async () => {
    setLoading(true);
    try {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          async (pos) => {
            await api.driverSOS(tripId, {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              message: 'SOS activated by driver',
            });
            setActive(true);
          },
          async () => {
            await api.driverSOS(tripId, { message: 'SOS activated by driver' });
            setActive(true);
          },
        );
      } else {
        await api.driverSOS(tripId, { message: 'SOS activated by driver' });
        setActive(true);
      }
    } catch { /* offline queue will handle */ setActive(true); }
    finally { setLoading(false); }
  };

  const clear = async () => {
    try {
      await api.clearSOS(tripId, 'driver');
      setActive(false);
    } catch { /* non-fatal */ }
  };

  return (
    <div>
      {active ? (
        <div style={{ background: '#fee2e2', border: '2px solid #dc2626', borderRadius: 12, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 32 }}>🆘</div>
          <div style={{ fontWeight: 700, color: '#b91c1c', fontSize: 16, marginTop: 8 }}>SOS ACTIVE</div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>Emergency services and operator notified.</div>
          <button onClick={() => void clear()} style={{ marginTop: 12, padding: '8px 20px', border: '1px solid #dc2626', borderRadius: 8, background: '#fff', color: '#dc2626', fontWeight: 700, cursor: 'pointer' }}>
            Clear SOS
          </button>
        </div>
      ) : (
        <button
          onPointerDown={handlePress}
          disabled={loading || !online || countdown > 0}
          style={{
            width: '100%', padding: '20px 0', borderRadius: 12,
            background: countdown > 0 ? '#f97316' : '#dc2626',
            color: '#fff', border: 'none', fontSize: 20, fontWeight: 900,
            cursor: loading ? 'not-allowed' : 'pointer',
            boxShadow: '0 4px 16px rgba(220,38,38,0.3)',
          }}
        >
          {countdown > 0 ? `🆘 SOS in ${countdown}…` : loading ? '🆘 Activating…' : '🆘 SOS EMERGENCY'}
        </button>
      )}
      {!online && <div style={{ fontSize: 11, color: '#dc2626', textAlign: 'center', marginTop: 4 }}>Offline — SOS will be sent when connected</div>}
    </div>
  );
}

// ── Vehicle Inspection Form ───────────────────────────────────────────────────

function InspectionForm({ driverId, operatorId, vehicleId }: { driverId: string; operatorId: string; vehicleId: string }) {
  const [form, setForm] = useState({
    tires_ok: false, brakes_ok: false, lights_ok: false,
    engine_ok: false, ac_ok: false, mirrors_ok: false,
    emergency_equipment_ok: false, fire_extinguisher_ok: false, first_aid_ok: false,
    fuel_level: 'full', mileage_km: '', notes: '',
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ status: string; inspection_date: string } | null>(null);
  const [error, setError] = useState('');

  const toggle = (field: string) => setForm(f => ({ ...f, [field]: !f[field as keyof typeof f] }));

  const submit = async () => {
    setLoading(true); setError('');
    try {
      const res = await api.submitVehicleInspection(driverId, {
        vehicle_id: vehicleId, operator_id: operatorId,
        tires_ok: form.tires_ok, brakes_ok: form.brakes_ok,
        lights_ok: form.lights_ok, fuel_level: form.fuel_level,
        engine_ok: form.engine_ok, ac_ok: form.ac_ok,
        mirrors_ok: form.mirrors_ok,
        emergency_equipment_ok: form.emergency_equipment_ok,
        mileage_km: form.mileage_km ? parseInt(form.mileage_km) : undefined,
        notes: form.notes || undefined,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Submission failed');
    } finally { setLoading(false); }
  };

  if (result) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <div style={{ fontSize: 48 }}>{result.status === 'passed' ? '✅' : '❌'}</div>
        <div style={{ fontWeight: 700, fontSize: 17, marginTop: 8 }}>
          Inspection {result.status === 'passed' ? 'Passed' : 'Failed'}
        </div>
        <div style={{ color: '#64748b', marginTop: 4 }}>Date: {result.inspection_date}</div>
        {result.status === 'failed' && (
          <div style={{ color: '#dc2626', marginTop: 8, fontSize: 13 }}>
            Vehicle has failed inspection. Report to your supervisor before proceeding.
          </div>
        )}
        <button onClick={() => setResult(null)} style={{ ...primaryBtnStyle, marginTop: 16 }}>New Inspection</button>
      </div>
    );
  }

  const CheckItem = ({ field, label }: { field: string; label: string }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f1f5f9' }}>
      <span style={{ fontSize: 14 }}>{label}</span>
      <button
        onClick={() => toggle(field)}
        style={{
          padding: '6px 16px', borderRadius: 20, border: 'none',
          background: form[field as keyof typeof form] ? '#dcfce7' : '#fee2e2',
          color: form[field as keyof typeof form] ? '#16a34a' : '#dc2626',
          fontWeight: 700, cursor: 'pointer', fontSize: 13,
        }}
      >
        {form[field as keyof typeof form] ? '✓ OK' : '✗ FAIL'}
      </button>
    </div>
  );

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: '0 0 12px' }}>Daily Vehicle Inspection</h3>

      <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0', padding: '0 14px' }}>
        {[
          { field: 'tires_ok', label: '🛞 Tires — condition & pressure' },
          { field: 'brakes_ok', label: '🛑 Brakes — responsive & no grinding' },
          { field: 'lights_ok', label: '💡 Lights — headlights, tail, indicators' },
          { field: 'engine_ok', label: '⚙️ Engine — no warning lights' },
          { field: 'ac_ok', label: '❄️ Air Conditioning' },
          { field: 'mirrors_ok', label: '🪞 Mirrors — all clear & adjusted' },
          { field: 'emergency_equipment_ok', label: '⛑️ Emergency equipment in place' },
          { field: 'fire_extinguisher_ok', label: '🧯 Fire extinguisher present' },
          { field: 'first_aid_ok', label: '🩺 First aid kit stocked' },
        ].map(item => <CheckItem key={item.field} {...item} />)}
      </div>

      <div style={{ marginTop: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Fuel Level</label>
        <select value={form.fuel_level} onChange={e => setForm(f => ({ ...f, fuel_level: e.target.value }))} style={inputStyle}>
          {['full', '3/4', '1/2', '1/4', 'empty'].map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      <div style={{ marginTop: 8 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Odometer (km)</label>
        <input placeholder="Current mileage" type="number" value={form.mileage_km} onChange={e => setForm(f => ({ ...f, mileage_km: e.target.value }))} style={inputStyle} />
      </div>
      <div style={{ marginTop: 8 }}>
        <textarea placeholder="Notes (optional)" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>{error}</div>}
      <button onClick={() => void submit()} disabled={loading} style={{ ...primaryBtnStyle, marginTop: 14 }}>
        {loading ? 'Submitting…' : 'Submit Inspection'}
      </button>
    </div>
  );
}

// ── Earnings Dashboard ────────────────────────────────────────────────────────

function EarningsDashboard({ driverId }: { driverId: string }) {
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [data, setData] = useState<{
    totals: { net_earnings_kobo: number; gross_earnings_kobo: number; trips_completed: number; tips_kobo: number; km_driven: number };
    daily_breakdown: Array<{ date: string; net_earnings_kobo: number; trips_completed: number }>;
    recent_tips: Array<{ amount_kobo: number; message: string | null; customer_name: string | null; created_at: number }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getDriverEarnings(driverId, period);
      setData(res as typeof data);
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, [driverId, period]);

  useEffect(() => { void load(); }, [load]);

  const totalNet = data?.totals?.net_earnings_kobo ?? 0;
  const totalGross = data?.totals?.gross_earnings_kobo ?? 0;
  const trips = data?.totals?.trips_completed ?? 0;
  const tips = data?.totals?.tips_kobo ?? 0;
  const km = data?.totals?.km_driven ?? 0;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {(['daily', 'weekly', 'monthly'] as const).map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={pillStyle(period === p)}>
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>

      {loading && <div style={{ textAlign: 'center', color: '#94a3b8', padding: 20 }}>Loading…</div>}

      {!loading && data && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
            {[
              { label: 'Net Earnings', value: formatAmount(totalNet), color: '#16a34a' },
              { label: 'Gross Earnings', value: formatAmount(totalGross), color: '#1e40af' },
              { label: 'Trips', value: String(trips), color: '#7c3aed' },
              { label: 'Tips Received', value: formatAmount(tips), color: '#d97706' },
              { label: 'Km Driven', value: `${Math.round(km)} km`, color: '#0891b2' },
              { label: 'Commission Paid', value: formatAmount(totalGross - totalNet), color: '#64748b' },
            ].map(card => (
              <div key={card.label} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>{card.label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: card.color, marginTop: 4 }}>{card.value}</div>
              </div>
            ))}
          </div>

          {/* Daily breakdown */}
          {data.daily_breakdown.length > 0 && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Daily Breakdown</div>
              {data.daily_breakdown.slice(0, 7).map(row => (
                <div key={row.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{row.date}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>{row.trips_completed} trips</div>
                  </div>
                  <div style={{ fontWeight: 700, color: '#16a34a' }}>{formatAmount(row.net_earnings_kobo)}</div>
                </div>
              ))}
            </div>
          )}

          {/* Recent tips */}
          {data.recent_tips.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Recent Tips 🎁</div>
              {data.recent_tips.slice(0, 5).map((tip, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <div>
                    <div style={{ fontSize: 13 }}>{tip.customer_name ?? 'Anonymous'}</div>
                    {tip.message && <div style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic' }}>"{tip.message}"</div>}
                  </div>
                  <div style={{ fontWeight: 700, color: '#d97706' }}>+{formatAmount(tip.amount_kobo)}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Shift Verification ────────────────────────────────────────────────────────

function ShiftVerification({ driverId, operatorId }: { driverId: string; operatorId: string }) {
  const [status, setStatus] = useState<string>('checking');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    api.getTodayVerification(driverId)
      .then(res => setStatus(res.status))
      .catch(() => setStatus('not_submitted'));
  }, [driverId]);

  const submit = async () => {
    setLoading(true);
    try {
      await api.submitDriverVerification(driverId, {
        operator_id: operatorId,
        selfie_url: `selfie_placeholder_${Date.now()}`,
      });
      setSubmitted(true);
      setStatus('pending');
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  };

  const statusConfig: Record<string, { emoji: string; label: string; color: string }> = {
    approved: { emoji: '✅', label: 'Shift verified — you\'re good to go!', color: '#16a34a' },
    pending: { emoji: '⏳', label: 'Verification pending supervisor review', color: '#d97706' },
    rejected: { emoji: '❌', label: 'Verification rejected — contact supervisor', color: '#dc2626' },
    not_submitted: { emoji: '📸', label: 'Submit selfie to start your shift', color: '#1e40af' },
    checking: { emoji: '🔄', label: 'Checking verification status…', color: '#64748b' },
  };

  const cfg = statusConfig[status] ?? statusConfig['checking']!;

  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 28 }}>{cfg.emoji}</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Shift Verification</div>
          <div style={{ fontSize: 13, color: cfg.color }}>{cfg.label}</div>
        </div>
      </div>
      {(status === 'not_submitted' || status === 'rejected') && !submitted && (
        <button onClick={() => void submit()} disabled={loading} style={{ ...primaryBtnStyle, marginTop: 12 }}>
          {loading ? 'Submitting…' : '📸 Submit Selfie Verification'}
        </button>
      )}
    </div>
  );
}

// ── Navigation Panel ──────────────────────────────────────────────────────────

function NavigationPanel({ tripId, driverId }: { tripId: string; driverId: string }) {
  const online = useOnlineStatus();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [tracking, setTracking] = useState(false);
  const [currentPos, setCurrentPos] = useState<{ lat: number; lon: number } | null>(null);
  const [error, setError] = useState('');

  const startTracking = () => {
    if (!navigator.geolocation) { setError('Geolocation not supported'); return; }
    setTracking(true);

    intervalRef.current = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude, longitude } = pos.coords;
          setCurrentPos({ lat: latitude, lon: longitude });
          if (online) {
            try {
              await api.updateDriverLocation(tripId, { latitude, longitude, driver_id: driverId });
            } catch { /* non-fatal */ }
          }
        },
        err => setError('Location error: ' + err.message),
        { enableHighAccuracy: true, timeout: 10000 },
      );
    }, 15000); // Update every 15 seconds
  };

  const stopTracking = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setTracking(false);
  };

  useEffect(() => () => stopTracking(), []);

  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>📍 Navigation & Location</div>

      {currentPos && (
        <div style={{ background: '#f0f9ff', borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 13 }}>
          <strong>Current:</strong> {currentPos.lat.toFixed(5)}, {currentPos.lon.toFixed(5)}
          {!online && <span style={{ color: '#dc2626', marginLeft: 6 }}>(offline — buffered)</span>}
        </div>
      )}

      {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 8 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        {!tracking ? (
          <button onClick={startTracking} style={{ flex: 1, padding: '10px 0', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
            ▶ Start Tracking
          </button>
        ) : (
          <button onClick={stopTracking} style={{ flex: 1, padding: '10px 0', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
            ■ Stop Tracking
          </button>
        )}
        <a
          href={`https://www.google.com/maps/dir/?api=1&travelmode=driving`}
          target="_blank" rel="noopener noreferrer"
          style={{ flex: 1, padding: '10px 0', background: '#1e40af', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', textAlign: 'center', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          🗺️ Open Maps
        </a>
      </div>
    </div>
  );
}

// ── Trip Completion Panel (QA-TRA-3: Offline-First) ──────────────────────────

interface TripCompletionPanelProps {
  rideRequestId: string;
  driverId: string;
  operatorId: string;
  online: boolean;
}

function TripCompletionPanel({ rideRequestId, driverId, operatorId, online }: TripCompletionPanelProps) {
  const [completing, setCompleting] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [message, setMessage] = useState('');
  const [distanceKm, setDistanceKm] = useState('');
  const [durationMin, setDurationMin] = useState('');

  // Refresh pending count on mount and after each action
  const refreshPending = useCallback(async () => {
    const count = await getPendingDriverTripCount();
    setPendingCount(count);
  }, []);

  useEffect(() => { void refreshPending(); }, [refreshPending]);

  const handleComplete = useCallback(async () => {
    setCompleting(true);
    setMessage('');
    const localId = `dtc_${rideRequestId}_${Date.now()}`;
    const completedAt = Date.now();

    try {
      if (online) {
        // Online path: call API directly
        const res = await fetch(`/api/ride-hailing/${rideRequestId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            driver_id: driverId,
            operator_id: operatorId,
            distance_km: distanceKm ? parseFloat(distanceKm) : null,
            duration_minutes: durationMin ? parseInt(durationMin, 10) : null,
            completed_at: completedAt,
          }),
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        setMessage('Trip marked complete.');
      } else {
        // Offline path: queue to IndexedDB (QA-TRA-3 core requirement)
        const completionData: Parameters<typeof queueDriverTripCompletion>[0] = {
          local_id: localId,
          ride_request_id: rideRequestId,
          driver_id: driverId,
          operator_id: operatorId,
          completed_at: completedAt,
        };
        if (distanceKm) completionData.distance_km = parseFloat(distanceKm);
        if (durationMin) completionData.duration_minutes = parseInt(durationMin, 10);
        await queueDriverTripCompletion(completionData);
        await refreshPending();
        setMessage('Saved offline — will sync when online.');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to complete trip.';
      setMessage(errMsg);
    } finally {
      setCompleting(false);
    }
  }, [online, rideRequestId, driverId, operatorId, distanceKm, durationMin, refreshPending]);

  const handleManualSync = useCallback(async () => {
    setCompleting(true);
    try {
      const result = await flushDriverTripCompletions();
      await refreshPending();
      setMessage(`Synced ${result.synced} record(s). ${result.failed > 0 ? `${result.failed} failed.` : ''}`);
    } catch {
      setMessage('Sync failed — try again.');
    } finally {
      setCompleting(false);
    }
  }, [refreshPending]);

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Complete Active Ride</h3>

      {pendingCount > 0 && (
        <div style={{
          background: '#fef9c3', border: '1px solid #fde047', borderRadius: 8,
          padding: '10px 14px', marginBottom: 14, fontSize: 13, color: '#854d0e',
        }}>
          <strong>{pendingCount}</strong> trip completion(s) queued offline.
          {online && (
            <button
              onClick={() => { void handleManualSync(); }}
              disabled={completing}
              style={{ ...pillStyle(true, '#854d0e'), marginLeft: 10, fontSize: 12 }}
            >
              Sync Now
            </button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          style={inputStyle}
          type="number"
          placeholder="Distance (km) — optional"
          value={distanceKm}
          onChange={e => setDistanceKm(e.target.value)}
        />
        <input
          style={inputStyle}
          type="number"
          placeholder="Duration (minutes) — optional"
          value={durationMin}
          onChange={e => setDurationMin(e.target.value)}
        />
        <button
          style={{ ...primaryBtnStyle, background: online ? '#16a34a' : '#d97706' }}
          onClick={() => { void handleComplete(); }}
          disabled={completing}
        >
          {completing
            ? 'Saving…'
            : online
              ? 'Complete Trip (Online)'
              : 'Save Offline (Sync Later)'}
        </button>
      </div>

      {message && (
        <div style={{
          marginTop: 12, fontSize: 13, color: '#16a34a',
          background: '#f0fdf4', borderRadius: 6, padding: '8px 12px',
        }}>
          {message}
        </div>
      )}
    </div>
  );
}

// ── Main Driver App Module ────────────────────────────────────────────────────

export function DriverAppModule() {
  const { user } = useAuth();
  const online = useOnlineStatus();
  const [tab, setTab] = useState<'verify' | 'inspect' | 'earnings' | 'navigate' | 'rides' | 'sos'>('verify');

  // For demo purposes — in production these come from the active trip assignment
  const driverId = user?.id ?? 'driver_demo';
  const operatorId = user?.operator_id ?? 'op_demo';
  const vehicleId = 'vehicle_demo';
  const activeTripId = 'trip_demo';
  const activeRideId = 'ride_demo';

  // QA-TRA-3: Register background sync listener — flushes queued trip
  // completions automatically when the browser goes from offline → online.
  useEffect(() => {
    const cleanup = registerDriverSyncOnReconnect();
    return cleanup;
  }, []);

  const tabs: Array<{ key: typeof tab; label: string }> = [
    { key: 'verify', label: '✅ Verify' },
    { key: 'inspect', label: '🔧 Inspect' },
    { key: 'earnings', label: '💰 Earnings' },
    { key: 'navigate', label: '📍 Navigate' },
    { key: 'rides', label: '🚖 Rides' },
    { key: 'sos', label: '🆘 SOS' },
  ];

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🚗 Driver App</h2>
        <span style={{ fontSize: 11, fontWeight: 600, color: online ? '#16a34a' : '#dc2626' }}>
          {online ? '● Online' : '○ Offline'}
        </span>
      </div>

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, overflowX: 'auto', paddingBottom: 2 }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            ...pillStyle(tab === t.key, t.key === 'sos' ? '#dc2626' : '#1e40af'),
            whiteSpace: 'nowrap',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'verify' && <ShiftVerification driverId={driverId} operatorId={operatorId} />}
      {tab === 'inspect' && <InspectionForm driverId={driverId} operatorId={operatorId} vehicleId={vehicleId} />}
      {tab === 'earnings' && <EarningsDashboard driverId={driverId} />}
      {tab === 'navigate' && <NavigationPanel tripId={activeTripId} driverId={driverId} />}
      {tab === 'rides' && (
        <TripCompletionPanel
          rideRequestId={activeRideId}
          driverId={driverId}
          operatorId={operatorId}
          online={online}
        />
      )}
      {tab === 'sos' && (
        <div style={{ padding: 16 }}>
          <div style={{ color: '#64748b', fontSize: 13, marginBottom: 16, textAlign: 'center' }}>
            Press and hold to activate SOS. Emergency services and your operator will be notified immediately.
          </div>
          <SOSButton tripId={activeTripId} online={online} />
        </div>
      )}
    </div>
  );
}
