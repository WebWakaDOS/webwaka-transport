/**
 * P06: Driver Mobile App View
 * Complete driver-facing experience: trip list, trip detail, inspection,
 * QR boarding scan, GPS sharing, SOS, and delay reporting.
 * Invariants: Mobile-First, Offline-First, Nigeria-First
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import jsQR from 'jsqr';
import { api, ApiError } from '../api/client';
import type { Trip, TripDetail, TripManifest, ManifestEntry, BoardingStatus, InspectionRecord } from '../api/client';
import { queueMutation } from '../core/offline/db';
import { ManifestExportButtons } from './manifest-export';

// ============================================================
// Helpers
// ============================================================

const STATE_COLORS: Record<string, string> = {
  boarding: '#16a34a', scheduled: '#2563eb', in_transit: '#f59e0b',
  completed: '#64748b', cancelled: '#dc2626',
};

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString('en-NG', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtFull(ms: number) {
  return new Date(ms).toLocaleString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

type NavState =
  | { view: 'list' }
  | { view: 'detail'; tripId: string }
  | { view: 'inspection'; tripId: string }
  | { view: 'scan'; tripId: string }
  | { view: 'manifest'; tripId: string }
  | { view: 'delay'; tripId: string };

// Shared card style
const card = { background: '#fff', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 12 };
const btnPrimary = { padding: '12px 18px', borderRadius: 10, background: '#2563eb', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14, width: '100%' };
const btnSecondary = { padding: '10px 18px', borderRadius: 10, background: '#f1f5f9', color: '#0f172a', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13, width: '100%' };
const btnBack = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#2563eb', marginBottom: 16, padding: 0 };

function OfflineBanner() {
  return (
    <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#92400e', marginBottom: 12 }}>
      ⚠ You are offline — this action will sync when connected
    </div>
  );
}

// ============================================================
// DriverSOS — Red SOS button with confirmation + active banner
// ============================================================
function DriverSOS({ tripId, sosActive, onSosChange }: {
  tripId: string;
  sosActive: boolean;
  onSosChange: (active: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTrigger = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.triggerSOS(tripId);
      onSosChange(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to send SOS');
    } finally {
      setLoading(false);
      setConfirming(false);
    }
  };

  // Full-screen banner (only supervisor can clear)
  if (sosActive) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: '#dc2626', zIndex: 9999,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#fff',
      }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>🚨</div>
        <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: 2 }}>SOS ACTIVE</div>
        <div style={{ fontSize: 16, marginTop: 12, opacity: 0.9, textAlign: 'center', padding: '0 32px' }}>
          Emergency alert sent. Your operator and emergency contacts have been notified.
        </div>
        <div style={{ fontSize: 13, marginTop: 24, opacity: 0.75 }}>
          Only a supervisor can clear this alert from the dashboard.
        </div>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', color: '#b91c1c', fontSize: 12, marginBottom: 8 }}>
          {error}
        </div>
      )}
      {confirming ? (
        <div style={{ background: '#fef2f2', borderRadius: 12, padding: 16, border: '2px solid #dc2626', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>⚠ Confirm Emergency SOS</div>
          <div style={{ fontSize: 13, color: '#7f1d1d', marginBottom: 12 }}>
            This will alert your operator and emergency contacts immediately. Only use in a genuine emergency.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setConfirming(false)} style={{ ...btnSecondary, width: 'auto', flex: 1 }}>Cancel</button>
            <button
              onClick={() => void handleTrigger()}
              disabled={loading}
              style={{ flex: 2, padding: '12px 18px', borderRadius: 10, background: loading ? '#fca5a5' : '#dc2626', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}
            >
              {loading ? 'Sending…' : '🚨 SEND SOS'}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          style={{ ...btnPrimary, background: '#dc2626', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 12 }}
        >
          🚨 Emergency SOS
        </button>
      )}
    </>
  );
}

// ============================================================
// DriverLocationShare — GPS toggle
// ============================================================
function DriverLocationShare({ tripId }: { tripId: string }) {
  const [sharing, setSharing] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [permError, setPermError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);

  const stopSharing = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setSharing(false);
  }, []);

  const startSharing = useCallback(() => {
    setPermError(null);
    if (!('geolocation' in navigator)) {
      setPermError('Geolocation is not supported by your browser.');
      return;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setCoords({ lat, lng, accuracy });
        setLastUpdate(Date.now());
        // Non-fatal background POST
        api.updateTripLocation(tripId, lat, lng, accuracy).catch(() => {});
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setPermError('Please enable location access in browser settings.');
        } else {
          setPermError(`Location error: ${err.message}`);
        }
        stopSharing();
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
    setSharing(true);
  }, [tripId, stopSharing]);

  useEffect(() => () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); }, []);

  return (
    <div style={{ ...card, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: permError || coords ? 12 : 0 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>📍 Share Location</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>Send GPS to dispatcher</div>
        </div>
        <button
          onClick={sharing ? stopSharing : startSharing}
          style={{
            padding: '8px 16px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: sharing ? '#16a34a' : '#e2e8f0', color: sharing ? '#fff' : '#374151',
          }}
        >
          {sharing ? 'ON' : 'OFF'}
        </button>
      </div>
      {permError && (
        <div style={{ fontSize: 12, color: '#b91c1c', background: '#fef2f2', borderRadius: 6, padding: '6px 10px' }}>
          {permError}
        </div>
      )}
      {coords && sharing && (
        <div style={{ fontSize: 11, color: '#64748b' }}>
          <div>{coords.lat.toFixed(6)}, {coords.lng.toFixed(6)} (±{Math.round(coords.accuracy)}m)</div>
          {lastUpdate && <div>Last update: {fmtTime(lastUpdate)}</div>}
        </div>
      )}
    </div>
  );
}

// ============================================================
// DriverInspectionForm — pre-trip checklist
// ============================================================
interface InspectionChecks {
  tires_ok: boolean;
  brakes_ok: boolean;
  lights_ok: boolean;
  fuel_ok: boolean;
  emergency_equipment_ok: boolean;
}

const CHECK_LABELS: Array<{ key: keyof InspectionChecks; label: string }> = [
  { key: 'tires_ok', label: 'Tires OK' },
  { key: 'brakes_ok', label: 'Brakes OK' },
  { key: 'lights_ok', label: 'Lights OK' },
  { key: 'fuel_ok', label: 'Fuel Adequate' },
  { key: 'emergency_equipment_ok', label: 'Emergency Equipment Present' },
];

function DriverInspectionForm({ tripId, onBack, onComplete }: {
  tripId: string;
  onBack: () => void;
  onComplete: () => void;
}) {
  const [checks, setChecks] = useState<InspectionChecks>({
    tires_ok: false, brakes_ok: false, lights_ok: false, fuel_ok: false, emergency_equipment_ok: false,
  });
  const [notes, setNotes] = useState('');
  const [manifestCount, setManifestCount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allChecked = Object.values(checks).every(Boolean);

  const handleSubmit = async () => {
    if (!allChecked) return;
    setLoading(true);
    setError(null);
    try {
      const inspData: Parameters<typeof api.submitInspection>[1] = { ...checks };
      if (notes.trim()) inspData.notes = notes.trim();
      if (manifestCount) inspData.manifest_count = parseInt(manifestCount, 10);
      await api.submitInspection(tripId, inspData);
      onComplete();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to submit inspection');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '0 0 32px' }}>
      <button onClick={onBack} style={btnBack}>← Back to Trip</button>
      <div style={{ fontWeight: 700, fontSize: 18, color: '#0f172a', marginBottom: 4 }}>Pre-Trip Inspection</div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 20 }}>Check each item before departure</div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#b91c1c', marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ ...card, marginBottom: 16 }}>
        {CHECK_LABELS.map(({ key, label }) => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #f1f5f9', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={checks[key]}
              onChange={e => setChecks(prev => ({ ...prev, [key]: e.target.checked }))}
              style={{ width: 20, height: 20, cursor: 'pointer', accentColor: '#16a34a' }}
            />
            <span style={{ fontWeight: 600, fontSize: 15, color: checks[key] ? '#16a34a' : '#0f172a' }}>{label}</span>
            {checks[key] && <span style={{ marginLeft: 'auto', color: '#16a34a' }}>✓</span>}
          </label>
        ))}
      </div>

      <div style={card}>
        <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6, color: '#374151' }}>
          Manifest Count (optional)
        </label>
        <input
          type="number"
          value={manifestCount}
          onChange={e => setManifestCount(e.target.value)}
          placeholder="Number of passengers"
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
        />
        <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6, marginTop: 14, color: '#374151' }}>
          Notes (optional)
        </label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Any observations or issues…"
          rows={3}
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, resize: 'vertical', boxSizing: 'border-box' }}
        />
      </div>

      <button
        onClick={() => void handleSubmit()}
        disabled={!allChecked || loading}
        style={{
          ...btnPrimary,
          background: allChecked ? '#16a34a' : '#94a3b8',
          cursor: allChecked && !loading ? 'pointer' : 'not-allowed',
          marginTop: 8,
        }}
      >
        {loading ? 'Submitting…' : allChecked ? '✓ Submit Inspection' : `Check all ${CHECK_LABELS.length} items to continue`}
      </button>
    </div>
  );
}

// ============================================================
// DriverBoardingScan — QR camera scanner
// ============================================================
type ScanResult = { type: 'success'; names: string[]; seats: string } | { type: 'already'; time: number } | { type: 'invalid' } | { type: 'error'; message: string };

function DriverBoardingScan({ tripId, onBack }: { tripId: string; onBack: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processingRef = useRef(false);

  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [status, setStatus] = useState<BoardingStatus | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getBoardingStatus(tripId);
      setStatus(s);
    } catch { /* non-fatal */ }
  }, [tripId]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);
  useEffect(() => {
    const h = () => setOffline(!navigator.onLine);
    window.addEventListener('online', h);
    window.addEventListener('offline', h);
    return () => { window.removeEventListener('online', h); window.removeEventListener('offline', h); };
  }, []);

  const stopCamera = useCallback(() => {
    if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
  }, []);

  const handleQR = useCallback(async (payload: string) => {
    if (processingRef.current) return;
    processingRef.current = true;
    setScanResult(null);

    if (offline) {
      try {
        await queueMutation('booking', payload.split(':')[0] ?? payload, 'CREATE', { qr_payload: payload, trip_id: tripId });
        setScanResult({ type: 'success', names: ['(Queued offline)'], seats: '—' });
      } catch { setScanResult({ type: 'error', message: 'Failed to queue offline boarding' }); }
      setTimeout(() => { processingRef.current = false; setScanResult(null); }, 2500);
      return;
    }

    try {
      const result = await api.boardByQR(tripId, payload);
      setScanResult({ type: 'success', names: result.passenger_names, seats: result.seat_numbers });
      void loadStatus();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409) {
          const boardedAt = (e.data as { boarded_at?: number } | undefined)?.boarded_at;
          setScanResult({ type: 'already', time: boardedAt ?? Date.now() });
        } else if (e.status === 404) {
          setScanResult({ type: 'invalid' });
        } else {
          setScanResult({ type: 'error', message: e.message });
        }
      } else {
        setScanResult({ type: 'error', message: 'Unknown error' });
      }
    }

    setTimeout(() => { processingRef.current = false; setScanResult(null); }, 2500);
  }, [offline, tripId, loadStatus]);

  const startScanning = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scan = () => {
      if (!streamRef.current) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.height = video.videoHeight;
        canvas.width = video.videoWidth;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
        if (code && !processingRef.current) {
          void handleQR(code.data);
        }
      }
      animRef.current = requestAnimationFrame(scan);
    };
    animRef.current = requestAnimationFrame(scan);
  }, [handleQR]);

  useEffect(() => {
    setCamError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError('Camera not available — getUserMedia not supported in this browser.');
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(stream => {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().then(startScanning).catch(() => { startScanning(); });
        }
      })
      .catch(err => {
        setCamError(`Camera error: ${(err as Error).message}. Ensure HTTPS and camera permissions.`);
      });
    return () => stopCamera();
  }, [startScanning, stopCamera]);

  const resultBg = scanResult?.type === 'success' ? '#f0fdf4' : scanResult?.type === 'already' ? '#fefce8' : '#fef2f2';
  const resultColor = scanResult?.type === 'success' ? '#15803d' : scanResult?.type === 'already' ? '#92400e' : '#b91c1c';

  return (
    <div style={{ padding: '0 0 24px' }}>
      <button onClick={() => { stopCamera(); onBack(); }} style={btnBack}>← Back to Trip</button>
      <div style={{ fontWeight: 700, fontSize: 18, color: '#0f172a', marginBottom: 4 }}>Scan Boarding Pass</div>

      {status && (
        <div style={{ background: '#eff6ff', borderRadius: 8, padding: '8px 14px', marginBottom: 12, fontSize: 13, color: '#1e40af', fontWeight: 600 }}>
          {status.total_boarded} / {status.total_confirmed} boarded · {status.remaining} remaining
        </div>
      )}

      {offline && <OfflineBanner />}

      {camError ? (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 16, color: '#b91c1c', fontSize: 13 }}>
          {camError}
        </div>
      ) : (
        <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#000', aspectRatio: '1', marginBottom: 12 }}>
          <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          {/* Viewfinder overlay */}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ width: '60%', aspectRatio: '1', border: '3px solid rgba(255,255,255,0.8)', borderRadius: 16 }} />
          </div>
          {!scanResult && (
            <div style={{ position: 'absolute', bottom: 12, left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,0.9)', fontSize: 12 }}>
              Point camera at QR code
            </div>
          )}
        </div>
      )}

      {scanResult && (
        <div style={{ background: resultBg, border: `1px solid ${resultColor}30`, borderRadius: 10, padding: 14, color: resultColor, marginBottom: 12 }}>
          {scanResult.type === 'success' && (
            <>
              <div style={{ fontWeight: 700, fontSize: 16 }}>✓ {scanResult.names.join(', ')}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Seat: {scanResult.seats}</div>
              <div style={{ fontSize: 12, marginTop: 2, opacity: 0.8 }}>Welcome aboard!</div>
            </>
          )}
          {scanResult.type === 'already' && (
            <div style={{ fontWeight: 700 }}>⚠ Already boarded at {fmtTime(scanResult.time)}</div>
          )}
          {scanResult.type === 'invalid' && (
            <div style={{ fontWeight: 700 }}>✗ Invalid ticket for this trip</div>
          )}
          {scanResult.type === 'error' && (
            <div style={{ fontWeight: 700 }}>✗ {scanResult.message}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// DriverDelayReport — delay reason + estimated departure form
// ============================================================
const DELAY_REASONS = [
  { value: 'traffic', label: 'Traffic' },
  { value: 'breakdown', label: 'Breakdown' },
  { value: 'weather', label: 'Weather' },
  { value: 'accident', label: 'Accident' },
  { value: 'fuel', label: 'Fuel' },
  { value: 'other', label: 'Other' },
];

function DriverDelayReport({ tripId, onBack, onDone }: { tripId: string; onBack: () => void; onDone: () => void }) {
  const [reasonCode, setReasonCode] = useState('');
  const [details, setDetails] = useState('');
  const [estTime, setEstTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!reasonCode || !estTime) return;
    const estMs = new Date(estTime).getTime();
    if (isNaN(estMs) || estMs <= Date.now()) {
      setError('Estimated departure must be in the future.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const delayData: Parameters<typeof api.reportDelay>[1] = { reason_code: reasonCode, estimated_departure_ms: estMs };
      if (details.trim()) delayData.reason_details = details.trim();
      await api.reportDelay(tripId, delayData);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to report delay');
    } finally {
      setLoading(false);
    }
  };

  // Compute default datetime-local value: now + 30min
  const defaultEst = (() => {
    const d = new Date(Date.now() + 30 * 60 * 1000);
    return d.toISOString().slice(0, 16);
  })();

  return (
    <div style={{ padding: '0 0 32px' }}>
      <button onClick={onBack} style={btnBack}>← Back to Trip</button>
      <div style={{ fontWeight: 700, fontSize: 18, color: '#0f172a', marginBottom: 4 }}>Report Delay</div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 20 }}>Passengers will be notified by SMS</div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={card}>
        <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6, color: '#374151' }}>
          Delay Reason *
        </label>
        <select
          value={reasonCode}
          onChange={e => setReasonCode(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, background: '#fff', boxSizing: 'border-box' }}
        >
          <option value="">Select reason…</option>
          {DELAY_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>

        <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6, marginTop: 14, color: '#374151' }}>
          New Estimated Departure *
        </label>
        <input
          type="datetime-local"
          defaultValue={defaultEst}
          onChange={e => setEstTime(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
        />

        <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6, marginTop: 14, color: '#374151' }}>
          Additional Details (optional)
        </label>
        <textarea
          value={details}
          onChange={e => setDetails(e.target.value)}
          placeholder="e.g. tyre burst near Ore junction…"
          rows={3}
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, resize: 'vertical', boxSizing: 'border-box' }}
        />
      </div>

      <button
        onClick={() => void handleSubmit()}
        disabled={!reasonCode || loading}
        style={{ ...btnPrimary, background: reasonCode ? '#f59e0b' : '#94a3b8', cursor: reasonCode && !loading ? 'pointer' : 'not-allowed', marginTop: 8 }}
      >
        {loading ? 'Reporting…' : 'Report Delay & Notify Passengers'}
      </button>
    </div>
  );
}

// ============================================================
// ManifestView — passenger list with boarding status (P04 enhanced)
// ============================================================
function ManifestView({ tripId, onBack }: { tripId: string; onBack: () => void }) {
  const [manifest, setManifest] = useState<TripManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [boarding, setBoarding] = useState<Set<string>>(new Set());
  const [boarded, setBoarded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setManifest(await api.getTripManifest(tripId)); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Failed to load manifest'); }
    finally { setLoading(false); }
  }, [tripId]);

  useEffect(() => { void load(); }, [load]);

  const handleBoard = async (bookingId: string) => {
    setBoarding(prev => new Set([...prev, bookingId]));
    try {
      await api.markPassengerBoarded(tripId, bookingId);
      setBoarded(prev => new Set([...prev, bookingId]));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to mark boarded');
    } finally {
      setBoarding(prev => { const n = new Set(prev); n.delete(bookingId); return n; });
    }
  };

  const passengers = manifest?.passengers ?? [];
  const boardedCount = passengers.filter(p => boarded.has(p.booking_id) || p.boarded_at != null).length;

  return (
    <div style={{ padding: '0 0 24px' }}>
      <button onClick={onBack} style={btnBack}>← Back to Trip</button>
      {loading && <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>Loading manifest…</div>}
      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#b91c1c', marginBottom: 12, fontSize: 13 }}>
          {error} <button onClick={load} style={{ marginLeft: 6, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: '#b91c1c' }}>Retry</button>
        </div>
      )}
      {manifest && (
        <>
          <div style={{ ...card, marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{manifest.trip.origin} → {manifest.trip.destination}</div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{fmtFull(manifest.trip.departure_time)}</div>
            <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12 }}>
              <span><strong>{passengers.length}</strong> passengers</span>
              <span style={{ color: '#16a34a' }}><strong>{boardedCount}</strong> boarded</span>
              <span style={{ color: '#f59e0b' }}><strong>{passengers.length - boardedCount}</strong> pending</span>
            </div>
            <div style={{ marginTop: 12 }}>
              <ManifestExportButtons
                tripId={tripId}
                tripLabel={`${manifest.trip.origin}-${manifest.trip.destination}_${new Date(manifest.trip.departure_time).toISOString().slice(0, 10)}`}
              />
            </div>
          </div>
          {passengers.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#94a3b8', padding: 32 }}>No confirmed passengers</div>
          ) : (
            passengers.map((p: ManifestEntry) => {
              const isBoarded = boarded.has(p.booking_id) || p.boarded_at != null;
              const isBusy = boarding.has(p.booking_id);
              return (
                <div key={p.booking_id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, borderLeft: `4px solid ${isBoarded ? '#16a34a' : '#e2e8f0'}`, marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{p.passenger_names?.[0] ?? p.passenger_name ?? 'Unknown'}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      Seat: {(p as ManifestEntry & { seat_numbers?: string }).seat_numbers ?? p.seat_ids?.join(', ') ?? '—'} · {p.payment_method ?? '—'}
                    </div>
                  </div>
                  {isBoarded ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a', background: '#f0fdf4', padding: '4px 10px', borderRadius: 20 }}>✓ Boarded</span>
                  ) : (
                    <button disabled={isBusy} onClick={() => void handleBoard(p.booking_id)}
                      style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: isBusy ? '#f1f5f9' : '#2563eb', color: isBusy ? '#94a3b8' : '#fff', border: 'none', cursor: isBusy ? 'not-allowed' : 'pointer' }}>
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
// DriverTripDetail — single trip detail with state-based actions
// ============================================================
function DriverTripDetail({ tripId, onBack, onNav }: {
  tripId: string;
  onBack: () => void;
  onNav: (state: NavState) => void;
}) {
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [inspection, setInspection] = useState<InspectionRecord | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, insp] = await Promise.all([api.getTrip(tripId), api.getInspection(tripId)]);
      setTrip(t);
      setInspection(insp);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load trip');
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => { void load(); }, [load]);

  if (trip?.sos_active === 1) {
    return <DriverSOS tripId={tripId} sosActive={true} onSosChange={() => void load()} />;
  }

  const stateColor = STATE_COLORS[trip?.state ?? ''] ?? '#64748b';
  const inspected = !!inspection;

  return (
    <div style={{ padding: '0 0 32px' }}>
      <button onClick={onBack} style={btnBack}>← My Trips</button>

      {loading && <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>Loading trip…</div>}
      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#b91c1c', marginBottom: 12, fontSize: 13 }}>
          {error} <button onClick={load} style={{ marginLeft: 6, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: '#b91c1c' }}>Retry</button>
        </div>
      )}

      {trip && (
        <>
          {/* Trip info card */}
          <div style={{ ...card, borderLeft: `4px solid ${stateColor}`, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, marginRight: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 18, color: '#0f172a' }}>{trip.origin ?? '—'} → {trip.destination ?? '—'}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>{fmtFull(trip.departure_time)}</div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: stateColor, background: `${stateColor}20`, padding: '4px 10px', borderRadius: 20, whiteSpace: 'nowrap' }}>
                {trip.state.replace('_', ' ').toUpperCase()}
              </span>
            </div>

            {/* Vehicle, driver, seat info */}
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12, color: '#64748b' }}>
              {trip.plate_number
                ? <span>🚌 <strong>{trip.plate_number}</strong></span>
                : trip.vehicle_id
                  ? <span>🚌 Vehicle: {trip.vehicle_id}</span>
                  : <span style={{ color: '#f59e0b' }}>No vehicle assigned</span>
              }
              {trip.driver_name
                ? <span>👤 <strong>{trip.driver_name}</strong>{trip.driver_phone ? ` · ${trip.driver_phone}` : ''}</span>
                : null
              }
              {trip.total_seats
                ? <span>💺 <strong>{trip.total_seats}</strong> seats</span>
                : trip.available_seats !== undefined
                  ? <span>💺 <strong>{trip.available_seats}</strong> available</span>
                  : null
              }
            </div>

            {/* Inspection status badge */}
            <div style={{ marginTop: 10, fontSize: 12 }}>
              {inspected ? (
                <span style={{ color: '#16a34a', fontWeight: 700 }}>✓ Inspected</span>
              ) : (
                <span style={{ color: '#f59e0b', fontWeight: 700 }}>⚠ Not Inspected</span>
              )}
            </div>
          </div>

          {/* State-based actions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            {trip.state === 'scheduled' && !inspected && (
              <button onClick={() => onNav({ view: 'inspection', tripId })} style={btnPrimary}>
                📋 Start Pre-Trip Inspection
              </button>
            )}
            {trip.state === 'boarding' && (
              <>
                <button onClick={() => onNav({ view: 'scan', tripId })} style={btnPrimary}>
                  📷 Scan Boarding Pass
                </button>
                <button onClick={() => onNav({ view: 'manifest', tripId })} style={btnSecondary}>
                  📋 View Manifest
                </button>
              </>
            )}
            {trip.state === 'in_transit' && (
              <>
                {trip.delay_reported_at ? (
                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#15803d', fontWeight: 600 }}>
                    ✓ Delay reported — passengers notified ({new Date(trip.delay_reported_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })})
                  </div>
                ) : (
                  <button onClick={() => onNav({ view: 'delay', tripId })} style={{ ...btnSecondary, color: '#92400e', background: '#fef3c7' }}>
                    ⏰ Report Delay
                  </button>
                )}
              </>
            )}
          </div>

          {/* GPS share (in_transit only) */}
          {trip.state === 'in_transit' && <DriverLocationShare tripId={tripId} />}

          {/* SOS button — always visible for active trips */}
          {trip.state !== 'completed' && trip.state !== 'cancelled' && (
            <DriverSOS tripId={tripId} sosActive={trip.sos_active === 1} onSosChange={() => void load()} />
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
// DriverTripList — list of driver's trips
// ============================================================
function TripCard({ trip, onSelect }: { trip: Trip; onSelect: () => void }) {
  const color = STATE_COLORS[trip.state] ?? '#64748b';
  return (
    <div onClick={onSelect} style={{ ...card, cursor: 'pointer', borderLeft: `4px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#0f172a' }}>{trip.origin ?? 'Origin'} → {trip.destination ?? 'Destination'}</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>{fmtTime(trip.departure_time)}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{trip.vehicle_id ? `Vehicle: ${trip.vehicle_id}` : 'No vehicle assigned'}</div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}20`, padding: '4px 10px', borderRadius: 20, whiteSpace: 'nowrap' }}>
          {trip.state.replace('_', ' ').toUpperCase()}
        </span>
      </div>
    </div>
  );
}

function DriverTripList({ onSelect }: { onSelect: (tripId: string) => void }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setTrips(await api.getMyDriverTrips()); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Failed to load trips'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ padding: '0 0 24px' }}>
      <div style={{ fontWeight: 700, fontSize: 20, color: '#0f172a', marginBottom: 2 }}>My Trips</div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 20 }}>
        {new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </div>

      {loading && <div style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>Loading trips…</div>}
      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#b91c1c', marginBottom: 16, fontSize: 13 }}>
          {error} <button onClick={load} style={{ marginLeft: 6, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: '#b91c1c' }}>Retry</button>
        </div>
      )}
      {!loading && trips.length === 0 && !error && (
        <div style={{ textAlign: 'center', color: '#94a3b8', padding: 48 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🚌</div>
          No trips assigned today
        </div>
      )}
      {trips.map(t => <TripCard key={t.id} trip={t} onSelect={() => onSelect(t.id)} />)}
    </div>
  );
}

// ============================================================
// DriverView — root navigation manager (exported)
// ============================================================
export function DriverView() {
  const [nav, setNav] = useState<NavState>({ view: 'list' });

  const go = useCallback((state: NavState) => setNav(state), []);

  switch (nav.view) {
    case 'list':
      return <DriverTripList onSelect={id => go({ view: 'detail', tripId: id })} />;

    case 'detail':
      return (
        <DriverTripDetail
          tripId={nav.tripId}
          onBack={() => go({ view: 'list' })}
          onNav={go}
        />
      );

    case 'inspection':
      return (
        <DriverInspectionForm
          tripId={nav.tripId}
          onBack={() => go({ view: 'detail', tripId: nav.tripId })}
          onComplete={() => go({ view: 'detail', tripId: nav.tripId })}
        />
      );

    case 'scan':
      return (
        <DriverBoardingScan
          tripId={nav.tripId}
          onBack={() => go({ view: 'detail', tripId: nav.tripId })}
        />
      );

    case 'manifest':
      return (
        <ManifestView
          tripId={nav.tripId}
          onBack={() => go({ view: 'detail', tripId: nav.tripId })}
        />
      );

    case 'delay':
      return (
        <DriverDelayReport
          tripId={nav.tripId}
          onBack={() => go({ view: 'detail', tripId: nav.tripId })}
          onDone={() => go({ view: 'detail', tripId: nav.tripId })}
        />
      );
  }
}
