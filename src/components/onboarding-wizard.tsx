/**
 * P11-T2: Operator Onboarding Wizard
 * 7-step wizard for new operators: Profile → Vehicles → Routes → Seat Templates → Drivers → Agents → First Trip
 * Invariants: Nigeria-First, Mobile-First, step persisted to localStorage
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../api/client';
import { formatAmount } from '../core/i18n/index';

// ============================================================
// Nigerian cities list
// ============================================================
const NIGERIAN_CITIES = [
  'Aba', 'Abakaliki', 'Abeokuta', 'Abuja', 'Ado Ekiti', 'Akure', 'Asaba',
  'Awka', 'Bauchi', 'Benin City', 'Birnin Kebbi', 'Calabar', 'Damaturu',
  'Dutse', 'Enugu', 'Gombe', 'Gusau', 'Ibadan', 'Ilorin', 'Jalingo', 'Jos',
  'Kaduna', 'Kano', 'Katsina', 'Lafia', 'Lagos', 'Lokoja', 'Maiduguri',
  'Makurdi', 'Minna', 'Onitsha', 'Osogbo', 'Owerri', 'Port Harcourt',
  'Sokoto', 'Umuahia', 'Uyo', 'Warri', 'Yenagoa', 'Yola', 'Zaria',
].sort();

const STORAGE_KEY = 'webwaka_onboarding_step';

// ============================================================
// Shared styles
// ============================================================
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8,
  fontSize: 14, background: '#fff', boxSizing: 'border-box', outline: 'none',
};
const btnPrimary: React.CSSProperties = {
  background: '#2563eb', color: '#fff', border: 'none', borderRadius: 10,
  padding: '12px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer', width: '100%',
};
const btnSecondary: React.CSSProperties = {
  background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 10,
  padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
const fieldStyle: React.CSSProperties = { marginBottom: 14 };
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4,
};
const errorStyle: React.CSSProperties = { color: '#dc2626', fontSize: 12, marginTop: 4 };

// ============================================================
// Added item chip
// ============================================================
function AddedChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, background: '#eff6ff',
      border: '1px solid #bfdbfe', borderRadius: 8, padding: '4px 10px', fontSize: 12,
    }}>
      <span style={{ color: '#1d4ed8' }}>✓ {label}</span>
      <button
        onClick={onRemove}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 14, lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}

// ============================================================
// Step Progress
// ============================================================
function StepProgress({ current, total }: { current: number; total: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 20, justifyContent: 'center' }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{
          width: i === current - 1 ? 24 : 8, height: 8, borderRadius: 4,
          background: i < current ? '#2563eb' : '#e2e8f0', transition: 'all 0.2s',
        }} />
      ))}
      <span style={{ marginLeft: 8, fontSize: 11, color: '#64748b', fontWeight: 600 }}>
        Step {current} of {total}
      </span>
    </div>
  );
}

// ============================================================
// Internal state
// ============================================================
interface WizardData {
  vehicleIds: Array<{ id: string; label: string }>;
  routeIds: Array<{ id: string; label: string; routeId: string }>;
  driverIds: Array<{ id: string; label: string }>;
  agentIds: Array<{ id: string; label: string }>;
}

interface StepProps {
  onNext: () => void;
  onSkip: () => void;
  operatorId: string;
  operatorName: string;
  addedData: WizardData;
  setAddedData: React.Dispatch<React.SetStateAction<WizardData>>;
}

// ============================================================
// Step 1: Company Profile
// ============================================================
function StepProfile({ onNext, operatorName }: StepProps) {
  const [name, setName] = useState(operatorName);
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [cac, setCac] = useState('');
  const [tin, setTin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.updateOperatorProfile({ name, address, contact_phone: phone, cac_number: cac, firs_tin: tin });
      onNext();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save profile');
    } finally { setSaving(false); }
  };

  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Company Profile</h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>Tell us about your transport company</p>
      <div style={fieldStyle}>
        <label style={labelStyle}>Company Name *</label>
        <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="ABC Transport Ltd" />
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>Office Address</label>
        <input style={inputStyle} value={address} onChange={e => setAddress(e.target.value)} placeholder="15 Motor Park Road, Abuja" />
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>Contact Phone</label>
        <input style={inputStyle} value={phone} onChange={e => setPhone(e.target.value)} placeholder="+2348012345678" type="tel" />
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>CAC Registration Number</label>
        <input style={inputStyle} value={cac} onChange={e => setCac(e.target.value)} placeholder="RC123456" />
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>FIRS TIN</label>
        <input style={inputStyle} value={tin} onChange={e => setTin(e.target.value)} placeholder="12345678-0001" />
      </div>
      {error && <p style={errorStyle}>{error}</p>}
      <button onClick={() => void save()} style={btnPrimary} disabled={saving || !name}>
        {saving ? 'Saving…' : 'Save & Continue →'}
      </button>
    </div>
  );
}

// ============================================================
// Step 2: Add Vehicles
// ============================================================
function StepVehicles({ onNext, onSkip, operatorId, addedData, setAddedData }: StepProps) {
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [plate, setPlate] = useState('');
  const [capacity, setCapacity] = useState('');
  const [vtype, setVtype] = useState('bus');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const addVehicle = async () => {
    if (!plate || !capacity) { setError('Plate number and capacity are required'); return; }
    setSaving(true);
    setError('');
    try {
      const fullModel = [make, model, year].filter(Boolean).join(' ') || '';
      const v = await api.createVehicle({
        operator_id: operatorId,
        plate_number: plate,
        vehicle_type: vtype,
        total_seats: parseInt(capacity, 10),
        ...(fullModel ? { model: fullModel } : {}),
      });
      const label = `${plate} (${vtype}, ${capacity} seats)`;
      setAddedData(d => ({ ...d, vehicleIds: [...d.vehicleIds, { id: v.id, label }] }));
      setMake(''); setModel(''); setYear(''); setPlate(''); setCapacity(''); setVtype('bus');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to add vehicle');
    } finally { setSaving(false); }
  };

  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Add Vehicles</h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>Register the vehicles in your fleet</p>
      {addedData.vehicleIds.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {addedData.vehicleIds.map(v => (
            <AddedChip key={v.id} label={v.label} onRemove={() =>
              setAddedData(d => ({ ...d, vehicleIds: d.vehicleIds.filter(x => x.id !== v.id) }))} />
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={fieldStyle}><label style={labelStyle}>Make</label>
          <input style={inputStyle} value={make} onChange={e => setMake(e.target.value)} placeholder="Toyota" />
        </div>
        <div style={fieldStyle}><label style={labelStyle}>Model</label>
          <input style={inputStyle} value={model} onChange={e => setModel(e.target.value)} placeholder="Coaster" />
        </div>
        <div style={fieldStyle}><label style={labelStyle}>Year</label>
          <input style={inputStyle} value={year} onChange={e => setYear(e.target.value)} placeholder="2020" type="number" />
        </div>
        <div style={fieldStyle}><label style={labelStyle}>Type *</label>
          <select style={inputStyle} value={vtype} onChange={e => setVtype(e.target.value)}>
            <option value="bus">Bus</option><option value="minibus">Minibus</option><option value="coaster">Coaster</option>
          </select>
        </div>
        <div style={fieldStyle}><label style={labelStyle}>Plate Number *</label>
          <input style={inputStyle} value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} placeholder="ABC-123-EF" />
        </div>
        <div style={fieldStyle}><label style={labelStyle}>Capacity *</label>
          <input style={inputStyle} value={capacity} onChange={e => setCapacity(e.target.value)} placeholder="18" type="number" min="1" />
        </div>
      </div>
      {error && <p style={errorStyle}>{error}</p>}
      <button onClick={() => void addVehicle()} style={{ ...btnPrimary, marginBottom: 8 }} disabled={saving}>
        {saving ? 'Adding…' : '+ Add Vehicle'}
      </button>
      <div style={{ display: 'flex', gap: 8 }}>
        {addedData.vehicleIds.length > 0 && (
          <button onClick={onNext} style={{ ...btnPrimary, flex: 1, background: '#16a34a' }}>
            Continue ({addedData.vehicleIds.length} added) →
          </button>
        )}
        <button onClick={onSkip} style={{ ...btnSecondary, flex: addedData.vehicleIds.length > 0 ? 0 : 1 }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Step 3: Add Routes
// ============================================================
function StepRoutes({ onNext, onSkip, operatorId, addedData, setAddedData }: StepProps) {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [fare, setFare] = useState('');
  const [duration, setDuration] = useState('');
  const [distance, setDistance] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fareKobo = fare ? Math.round(parseFloat(fare) * 100) : 0;

  const addRoute = async () => {
    if (!origin || !destination || !fare) { setError('Origin, destination and fare are required'); return; }
    if (isNaN(fareKobo) || fareKobo <= 0) { setError('Enter a valid fare amount in ₦'); return; }
    if (origin === destination) { setError('Origin and destination must be different cities'); return; }
    setSaving(true);
    setError('');
    try {
      const r = await api.createRoute({
        operator_id: operatorId,
        origin, destination,
        base_fare: fareKobo,
        ...(duration ? { duration_minutes: parseInt(duration, 10) } : {}),
        ...(distance ? { distance_km: parseFloat(distance) } : {}),
      });
      const label = `${origin} → ${destination} (${formatAmount(fareKobo)})`;
      setAddedData(d => ({ ...d, routeIds: [...d.routeIds, { id: r.id, label, routeId: r.id }] }));
      setOrigin(''); setDestination(''); setFare(''); setDuration(''); setDistance('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to add route');
    } finally { setSaving(false); }
  };

  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Add Routes</h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>Define the routes your fleet operates</p>
      {addedData.routeIds.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {addedData.routeIds.map(r => (
            <AddedChip key={r.id} label={r.label} onRemove={() =>
              setAddedData(d => ({ ...d, routeIds: d.routeIds.filter(x => x.id !== r.id) }))} />
          ))}
        </div>
      )}
      <div style={fieldStyle}><label style={labelStyle}>Origin *</label>
        <select style={inputStyle} value={origin} onChange={e => setOrigin(e.target.value)}>
          <option value="">Select origin city</option>
          {NIGERIAN_CITIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div style={fieldStyle}><label style={labelStyle}>Destination *</label>
        <select style={inputStyle} value={destination} onChange={e => setDestination(e.target.value)}>
          <option value="">Select destination city</option>
          {NIGERIAN_CITIES.filter(c => c !== origin).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div style={fieldStyle}><label style={labelStyle}>Base Fare (₦) *</label>
        <input style={inputStyle} value={fare} onChange={e => setFare(e.target.value)} placeholder="2500" type="number" min="1" />
        {fareKobo > 0 && (
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>= {formatAmount(fareKobo)}</div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={fieldStyle}><label style={labelStyle}>Duration (min)</label>
          <input style={inputStyle} value={duration} onChange={e => setDuration(e.target.value)} placeholder="180" type="number" />
        </div>
        <div style={fieldStyle}><label style={labelStyle}>Distance (km)</label>
          <input style={inputStyle} value={distance} onChange={e => setDistance(e.target.value)} placeholder="300" type="number" />
        </div>
      </div>
      {error && <p style={errorStyle}>{error}</p>}
      <button onClick={() => void addRoute()} style={{ ...btnPrimary, marginBottom: 8 }} disabled={saving}>
        {saving ? 'Adding…' : '+ Add Route'}
      </button>
      <div style={{ display: 'flex', gap: 8 }}>
        {addedData.routeIds.length > 0 && (
          <button onClick={onNext} style={{ ...btnPrimary, flex: 1, background: '#16a34a' }}>
            Continue ({addedData.routeIds.length} added) →
          </button>
        )}
        <button onClick={onSkip} style={{ ...btnSecondary, flex: addedData.routeIds.length > 0 ? 0 : 1 }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Step 4: Seat Templates (optional)
// ============================================================
function StepSeatTemplates({ onNext, onSkip, addedData }: StepProps) {
  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Configure Seat Templates</h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>
        Seat templates let passengers choose specific seats. You can configure these later from the Vehicles panel.
      </p>
      {addedData.vehicleIds.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 24, color: '#94a3b8', fontSize: 13 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚌</div>
          No vehicles added yet — you can configure seat templates later from the Vehicles panel.
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          {addedData.vehicleIds.map(v => (
            <div key={v.id} style={{
              border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px',
              marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontSize: 13 }}>{v.label}</span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>Configure in Vehicles panel</span>
            </div>
          ))}
        </div>
      )}
      <button onClick={onNext} style={btnPrimary}>Continue →</button>
      <button onClick={onSkip} style={{ ...btnSecondary, width: '100%', marginTop: 8 }}>Skip</button>
    </div>
  );
}

// ============================================================
// Step 5: Add Drivers
// ============================================================
function StepDrivers({ onNext, onSkip, operatorId, addedData, setAddedData }: StepProps) {
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [license, setLicense] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const addDriver = async () => {
    if (!driverName || !driverPhone) { setError('Name and phone are required'); return; }
    setSaving(true);
    setError('');
    try {
      const d = await api.createDriver({
        operator_id: operatorId, name: driverName,
        phone: driverPhone,
        ...(license ? { license_number: license } : {}),
      });
      const label = `${driverName} (${driverPhone})`;
      setAddedData(prev => ({ ...prev, driverIds: [...prev.driverIds, { id: d.id, label }] }));
      setDriverName(''); setDriverPhone(''); setLicense('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to add driver');
    } finally { setSaving(false); }
  };

  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Add Drivers</h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>Register your drivers</p>
      {addedData.driverIds.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {addedData.driverIds.map(d => (
            <AddedChip key={d.id} label={d.label} onRemove={() =>
              setAddedData(prev => ({ ...prev, driverIds: prev.driverIds.filter(x => x.id !== d.id) }))} />
          ))}
        </div>
      )}
      <div style={fieldStyle}><label style={labelStyle}>Full Name *</label>
        <input style={inputStyle} value={driverName} onChange={e => setDriverName(e.target.value)} placeholder="Emeka Okafor" />
      </div>
      <div style={fieldStyle}><label style={labelStyle}>Phone *</label>
        <input style={inputStyle} value={driverPhone} onChange={e => setDriverPhone(e.target.value)} placeholder="+2348012345678" type="tel" />
      </div>
      <div style={fieldStyle}><label style={labelStyle}>License Number</label>
        <input style={inputStyle} value={license} onChange={e => setLicense(e.target.value)} placeholder="ABJ-1234-5678" />
      </div>
      {error && <p style={errorStyle}>{error}</p>}
      <button onClick={() => void addDriver()} style={{ ...btnPrimary, marginBottom: 8 }} disabled={saving}>
        {saving ? 'Adding…' : '+ Add Driver'}
      </button>
      <div style={{ display: 'flex', gap: 8 }}>
        {addedData.driverIds.length > 0 && (
          <button onClick={onNext} style={{ ...btnPrimary, flex: 1, background: '#16a34a' }}>
            Continue ({addedData.driverIds.length} added) →
          </button>
        )}
        <button onClick={onSkip} style={{ ...btnSecondary, flex: addedData.driverIds.length > 0 ? 0 : 1 }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Step 6: Add Agents
// ============================================================
function StepAgents({ onNext, onSkip, operatorId, addedData, setAddedData }: StepProps) {
  const [agentName, setAgentName] = useState('');
  const [agentPhone, setAgentPhone] = useState('');
  const [busPark, setBusPark] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const addAgent = async () => {
    if (!agentName || !agentPhone) { setError('Name and phone are required'); return; }
    setSaving(true);
    setError('');
    try {
      const a = await api.createAgent({
        operator_id: operatorId, name: agentName,
        phone: agentPhone, bus_parks: busPark ? [busPark] : [],
      });
      const label = `${agentName}${busPark ? ` @ ${busPark}` : ''}`;
      setAddedData(prev => ({ ...prev, agentIds: [...prev.agentIds, { id: a.id, label }] }));
      setAgentName(''); setAgentPhone(''); setBusPark('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to add agent');
    } finally { setSaving(false); }
  };

  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Add Agents</h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>Register your ticketing agents at bus parks</p>
      {addedData.agentIds.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {addedData.agentIds.map(a => (
            <AddedChip key={a.id} label={a.label} onRemove={() =>
              setAddedData(prev => ({ ...prev, agentIds: prev.agentIds.filter(x => x.id !== a.id) }))} />
          ))}
        </div>
      )}
      <div style={fieldStyle}><label style={labelStyle}>Full Name *</label>
        <input style={inputStyle} value={agentName} onChange={e => setAgentName(e.target.value)} placeholder="Amina Bello" />
      </div>
      <div style={fieldStyle}><label style={labelStyle}>Phone *</label>
        <input style={inputStyle} value={agentPhone} onChange={e => setAgentPhone(e.target.value)} placeholder="+2348098765432" type="tel" />
      </div>
      <div style={fieldStyle}><label style={labelStyle}>Bus Park</label>
        <input style={inputStyle} value={busPark} onChange={e => setBusPark(e.target.value)} placeholder="Utako Motor Park, Abuja" />
      </div>
      {error && <p style={errorStyle}>{error}</p>}
      <button onClick={() => void addAgent()} style={{ ...btnPrimary, marginBottom: 8 }} disabled={saving}>
        {saving ? 'Adding…' : '+ Add Agent'}
      </button>
      <div style={{ display: 'flex', gap: 8 }}>
        {addedData.agentIds.length > 0 && (
          <button onClick={onNext} style={{ ...btnPrimary, flex: 1, background: '#16a34a' }}>
            Continue ({addedData.agentIds.length} added) →
          </button>
        )}
        <button onClick={onSkip} style={{ ...btnSecondary, flex: addedData.agentIds.length > 0 ? 0 : 1 }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Step 7: Create First Trip
// ============================================================
function StepFirstTrip({ onComplete, addedData }: { onComplete: () => void; addedData: WizardData }) {
  const [routeId, setRouteId] = useState(addedData.routeIds[0]?.routeId ?? '');
  const [vehicleId, setVehicleId] = useState(addedData.vehicleIds[0]?.id ?? '');
  const [driverId, setDriverId] = useState(addedData.driverIds[0]?.id ?? '');
  const [depDate, setDepDate] = useState(new Date().toISOString().split('T')[0]!);
  const [depTime, setDepTime] = useState('08:00');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const createTrip = async () => {
    if (!routeId || !vehicleId) { setError('Route and vehicle are required'); return; }
    setCreating(true);
    setError('');
    try {
      const departureMs = new Date(`${depDate}T${depTime}:00`).getTime();
      await api.createTrip({
        route_id: routeId, vehicle_id: vehicleId,
        departure_time: departureMs,
        ...(driverId ? { driver_id: driverId } : {}),
      });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create trip');
    } finally { setCreating(false); }
  };

  if (done) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <div style={{ fontSize: 60, marginBottom: 12 }}>🎉</div>
        <h3 style={{ margin: '0 0 8px', fontSize: 18, color: '#16a34a' }}>You're all set!</h3>
        <p style={{ margin: '0 0 24px', fontSize: 13, color: '#64748b' }}>
          Your first trip has been created. Your fleet is ready to roll across Nigeria!
        </p>
        <button onClick={onComplete} style={{ ...btnPrimary, background: '#16a34a' }}>
          Go to Dashboard →
        </button>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Create Your First Trip</h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>Schedule the first departure for your fleet</p>
      <div style={fieldStyle}><label style={labelStyle}>Route *</label>
        {addedData.routeIds.length > 0 ? (
          <select style={inputStyle} value={routeId} onChange={e => setRouteId(e.target.value)}>
            <option value="">Select route</option>
            {addedData.routeIds.map(r => <option key={r.routeId} value={r.routeId}>{r.label}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: 12, color: '#94a3b8', padding: '8px 0' }}>
            No routes added — you can create trips later from the Trips panel.
          </div>
        )}
      </div>
      <div style={fieldStyle}><label style={labelStyle}>Vehicle *</label>
        {addedData.vehicleIds.length > 0 ? (
          <select style={inputStyle} value={vehicleId} onChange={e => setVehicleId(e.target.value)}>
            <option value="">Select vehicle</option>
            {addedData.vehicleIds.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: 12, color: '#94a3b8', padding: '8px 0' }}>
            No vehicles added — you can create trips later from the Trips panel.
          </div>
        )}
      </div>
      <div style={fieldStyle}><label style={labelStyle}>Driver (optional)</label>
        <select style={inputStyle} value={driverId} onChange={e => setDriverId(e.target.value)}>
          <option value="">No driver assigned yet</option>
          {addedData.driverIds.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={fieldStyle}><label style={labelStyle}>Date *</label>
          <input style={inputStyle} type="date" value={depDate} onChange={e => setDepDate(e.target.value)} />
        </div>
        <div style={fieldStyle}><label style={labelStyle}>Departure Time *</label>
          <input style={inputStyle} type="time" value={depTime} onChange={e => setDepTime(e.target.value)} />
        </div>
      </div>
      {error && <p style={errorStyle}>{error}</p>}
      <button
        onClick={() => void createTrip()}
        style={{ ...btnPrimary, background: '#16a34a', marginBottom: 8 }}
        disabled={creating || !routeId || !vehicleId}
      >
        {creating ? 'Creating…' : '🚀 Create Trip & Finish!'}
      </button>
      <button onClick={onComplete} style={{ ...btnSecondary, width: '100%' }}>
        Skip — Go to Dashboard
      </button>
    </div>
  );
}

// ============================================================
// Main OnboardingWizard Component
// ============================================================
export interface OnboardingWizardProps {
  operatorId: string;
  operatorName: string;
  onComplete: () => void;
}

const STEP_LABELS = [
  'Company Profile', 'Add Vehicles', 'Add Routes',
  'Seat Templates', 'Add Drivers', 'Add Agents', 'First Trip',
];
const TOTAL_STEPS = STEP_LABELS.length;

export function OnboardingWizard({ operatorId, operatorName, onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<number>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? Math.max(1, Math.min(TOTAL_STEPS, parseInt(saved, 10))) : 1;
  });
  const [addedData, setAddedData] = useState<WizardData>({
    vehicleIds: [], routeIds: [], driverIds: [], agentIds: [],
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(step));
  }, [step]);

  const next = useCallback(() => setStep(s => Math.min(s + 1, TOTAL_STEPS)), []);
  const skip = useCallback(() => setStep(s => Math.min(s + 1, TOTAL_STEPS)), []);

  const handleComplete = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    onComplete();
  }, [onComplete]);

  const stepProps: StepProps = { onNext: next, onSkip: skip, operatorId, operatorName, addedData, setAddedData };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      zIndex: 10000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div style={{
        background: '#fff', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 500,
        maxHeight: '92vh', overflowY: 'auto', padding: '24px 20px 32px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, gap: 10 }}>
          <div style={{ fontSize: 22 }}>🚌</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a' }}>Welcome to WebWaka!</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>Let's set up {operatorName || 'your company'}</div>
          </div>
        </div>

        <StepProgress current={step} total={TOTAL_STEPS} />

        <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', marginBottom: 16, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {STEP_LABELS[step - 1]}
        </div>

        {step === 1 && <StepProfile {...stepProps} />}
        {step === 2 && <StepVehicles {...stepProps} />}
        {step === 3 && <StepRoutes {...stepProps} />}
        {step === 4 && <StepSeatTemplates {...stepProps} />}
        {step === 5 && <StepDrivers {...stepProps} />}
        {step === 6 && <StepAgents {...stepProps} />}
        {step === 7 && <StepFirstTrip addedData={addedData} onComplete={handleComplete} />}

        {step > 1 && step < TOTAL_STEPS && (
          <button
            onClick={() => setStep(s => Math.max(1, s - 1))}
            style={{ ...btnSecondary, width: '100%', marginTop: 16, color: '#64748b' }}
          >
            ← Back to {STEP_LABELS[step - 2]}
          </button>
        )}

        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button
            onClick={handleComplete}
            style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 11, cursor: 'pointer' }}
          >
            Exit setup (you can continue later)
          </button>
        </div>
      </div>
    </div>
  );
}
