/**
 * WebWaka Transport — EV Charging Station Locator
 *
 * Features:
 *   - Find nearby EV charging stations using GPS
 *   - Filter by connector type and availability
 *   - View station details (power, price, amenities, hours)
 *   - Sort by distance
 *   - Link to Google Maps for directions
 *
 * Nigeria-First: prices shown in ₦/kWh
 */

import React, { useState, useCallback } from 'react';
import { api, ApiError } from '../api/client';
import { formatAmount } from '../core/i18n/index';
import { useOnlineStatus } from '../core/offline/hooks';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', border: '1px solid #e2e8f0',
  borderRadius: 8, fontSize: 14, boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  width: '100%', padding: '12px 0', background: '#16a34a', color: '#fff',
  border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer',
};

const pillStyle = (active: boolean): React.CSSProperties => ({
  padding: '5px 12px', borderRadius: 20,
  border: `1px solid ${active ? '#16a34a' : '#e2e8f0'}`,
  background: active ? '#f0fdf4' : '#fff',
  color: active ? '#16a34a' : '#64748b',
  fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
});

type Station = {
  id: string; name: string; address: string | null; city: string;
  latitude: number; longitude: number; connector_types: string[];
  total_points: number; available_points: number;
  max_power_kw: number | null; price_per_kwh_kobo: number | null;
  amenities: string[]; operating_hours: string | null;
  status: string; distance_km: number;
};

const CONNECTOR_TYPES = ['Type2', 'CCS', 'CHAdeMO', 'Tesla'];

export function EVStationsModule() {
  const online = useOnlineStatus();
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [radius, setRadius] = useState('20');
  const [connectorFilter, setConnectorFilter] = useState('');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [stations, setStations] = useState<Station[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const detectLocation = () => {
    if (!navigator.geolocation) { setError('Geolocation not supported'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        setLat(String(pos.coords.latitude));
        setLon(String(pos.coords.longitude));
        setLocating(false);
      },
      err => { setError('Location error: ' + err.message); setLocating(false); },
    );
  };

  const search = useCallback(async () => {
    if (!lat || !lon) { setError('Please enter or detect your location first'); return; }
    setLoading(true); setError('');
    try {
      const res = await api.getNearbyEVStations({
        lat: parseFloat(lat), lon: parseFloat(lon),
        radius_km: parseFloat(radius) || 20,
        connector_type: connectorFilter || undefined,
        available_only: availableOnly,
      });
      setStations(res.stations as Station[]);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Search failed');
    } finally { setLoading(false); }
  }, [lat, lon, radius, connectorFilter, availableOnly]);

  const availabilityColor = (available: number, total: number) => {
    const ratio = available / total;
    if (ratio === 0) return '#dc2626';
    if (ratio < 0.4) return '#d97706';
    return '#16a34a';
  };

  const getConnectorEmoji = (type: string) => {
    const map: Record<string, string> = { Type2: '🔌', CCS: '⚡', CHAdeMO: '🔋', Tesla: '✦' };
    return map[type] ?? '🔌';
  };

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>⚡ EV Charging Stations</h2>
        {!online && <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>OFFLINE</span>}
      </div>

      {/* Location input */}
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Your Location</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Latitude" type="number" value={lat} onChange={e => setLat(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <input placeholder="Longitude" type="number" value={lon} onChange={e => setLon(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button onClick={detectLocation} disabled={locating} title="Detect my location" style={{ padding: '10px 14px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc', cursor: 'pointer', fontSize: 18 }}>
            {locating ? '⏳' : '📍'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', whiteSpace: 'nowrap' }}>Radius:</label>
          <select value={radius} onChange={e => setRadius(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
            {[5, 10, 20, 50].map(r => <option key={r} value={r}>{r} km</option>)}
          </select>
        </div>
      </div>

      {/* Filters */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Connector Type</div>
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
          <button onClick={() => setConnectorFilter('')} style={pillStyle(!connectorFilter)}>All</button>
          {CONNECTOR_TYPES.map(ct => (
            <button key={ct} onClick={() => setConnectorFilter(ct === connectorFilter ? '' : ct)} style={pillStyle(connectorFilter === ct)}>
              {getConnectorEmoji(ct)} {ct}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input type="checkbox" id="avail" checked={availableOnly} onChange={e => setAvailableOnly(e.target.checked)} />
          <label htmlFor="avail" style={{ fontSize: 13 }}>Available points only</label>
        </div>
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <button onClick={() => void search()} disabled={loading || !online} style={primaryBtnStyle}>
        {loading ? 'Searching…' : !online ? 'Offline' : '⚡ Find EV Stations'}
      </button>

      {/* Results */}
      {stations.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
            {total} station{total !== 1 ? 's' : ''} found
          </div>

          {stations.map(station => {
            const isExpanded = expanded === station.id;
            const avColor = availabilityColor(station.available_points, station.total_points);

            return (
              <div
                key={station.id}
                style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, marginBottom: 10 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, paddingRight: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{station.name}</div>
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{station.city}{station.address ? ` · ${station.address}` : ''}</div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{station.distance_km} km away</div>

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      {station.connector_types.map(ct => (
                        <span key={ct} style={{ padding: '2px 8px', borderRadius: 10, background: '#f0fdf4', color: '#16a34a', fontSize: 11, fontWeight: 700 }}>
                          {getConnectorEmoji(ct)} {ct}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontWeight: 800, color: avColor, fontSize: 18 }}>
                      {station.available_points}/{station.total_points}
                    </div>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>available</div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button onClick={() => setExpanded(isExpanded ? null : station.id)} style={{ flex: 1, padding: '8px 0', border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc', fontSize: 13, cursor: 'pointer' }}>
                    {isExpanded ? '▲ Less' : '▼ Details'}
                  </button>
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${station.latitude},${station.longitude}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{ flex: 1, padding: '8px 0', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, textAlign: 'center', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                  >
                    🗺️ Directions
                  </a>
                </div>

                {isExpanded && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
                    {station.max_power_kw && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                        <span style={{ color: '#475569' }}>Max Power</span>
                        <strong>{station.max_power_kw} kW</strong>
                      </div>
                    )}
                    {station.price_per_kwh_kobo && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                        <span style={{ color: '#475569' }}>Price</span>
                        <strong>{formatAmount(station.price_per_kwh_kobo)}/kWh</strong>
                      </div>
                    )}
                    {station.operating_hours && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                        <span style={{ color: '#475569' }}>Hours</span>
                        <strong>{station.operating_hours}</strong>
                      </div>
                    )}
                    {station.amenities && station.amenities.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <span style={{ fontSize: 12, color: '#475569' }}>Amenities: </span>
                        {station.amenities.map(a => (
                          <span key={a} style={{ fontSize: 12, margin: '0 4px', padding: '2px 8px', borderRadius: 10, background: '#f1f5f9', color: '#475569' }}>{a}</span>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: 8 }}>
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: station.status === 'active' ? '#dcfce7' : '#fee2e2', color: station.status === 'active' ? '#166534' : '#b91c1c', fontWeight: 700 }}>
                        {station.status}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && stations.length === 0 && total === 0 && lat && lon && (
        <div style={{ textAlign: 'center', color: '#94a3b8', padding: 32, fontSize: 14 }}>
          No EV stations found within {radius}km.
          <br />
          <span style={{ fontSize: 12 }}>Try expanding the search radius.</span>
        </div>
      )}
    </div>
  );
}
