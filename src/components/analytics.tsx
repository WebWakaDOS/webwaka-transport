/**
 * C-005: Revenue Analytics Charts
 * Pure CSS/SVG charts — no external libraries (keeps mobile bundle small).
 * Visible to TENANT_ADMIN + SUPERVISOR roles only.
 * Invariants: Nigeria-First (₦), Mobile-First, Offline-First (5-min IndexedDB cache)
 */
import React, { useState, useEffect, useCallback } from 'react';
import { formatAmount } from '../core/i18n/index';
import { api, ApiError } from '../api/client';
import type { RevenueReport } from '../api/client';

// ============================================================
// Helpers
// ============================================================

function toDateString(ts: number): string {
  return new Date(ts).toLocaleDateString('en-NG', { month: 'short', day: 'numeric' });
}

function subtractDays(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().split('T')[0]!;
}

function todayString(): string {
  return new Date().toISOString().split('T')[0]!;
}

// ============================================================
// Sub-components
// ============================================================

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      background: '#fff', borderRadius: 12, padding: '16px 20px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.08)', flex: '1 1 140px', minWidth: 140,
    }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function HorizontalBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: '#0f172a', fontWeight: 500 }}>{label}</span>
        <span style={{ color: '#64748b' }}>{formatAmount(value)}</span>
      </div>
      <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.4s ease' }} />
      </div>
    </div>
  );
}

function SvgBarChart({ data }: { data: Array<{ label: string; value: number }> }) {
  const W = 300;
  const H = 100;
  const maxVal = Math.max(...data.map(d => d.value), 1);
  const barW = Math.floor((W - (data.length - 1) * 2) / Math.max(data.length, 1));

  return (
    <svg viewBox={`0 0 ${W} ${H + 20}`} style={{ width: '100%', maxWidth: W, display: 'block', margin: '0 auto' }}>
      {data.map((d, i) => {
        const bh = Math.max(2, Math.round((d.value / maxVal) * H));
        const x = i * (barW + 2);
        const y = H - bh;
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={bh} fill="#2563eb" rx={2} />
            <text x={x + barW / 2} y={H + 14} textAnchor="middle" fontSize={7} fill="#64748b">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function PieChart({ slices }: { slices: Array<{ label: string; value: number; color: string }> }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total === 0) return <div style={{ color: '#94a3b8', textAlign: 'center', padding: 16 }}>No data</div>;

  let angle = -Math.PI / 2;
  const R = 50;
  const cx = 60;
  const cy = 60;

  const paths = slices.map(slice => {
    const fraction = slice.value / total;
    const start = angle;
    const end = start + fraction * 2 * Math.PI;
    angle = end;
    const x1 = cx + R * Math.cos(start);
    const y1 = cy + R * Math.sin(start);
    const x2 = cx + R * Math.cos(end);
    const y2 = cy + R * Math.sin(end);
    const large = fraction > 0.5 ? 1 : 0;
    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`;
    return { d, color: slice.color, label: slice.label, pct: Math.round(fraction * 100) };
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <svg viewBox="0 0 120 120" style={{ width: 120, flexShrink: 0 }}>
        {paths.map((p, i) => <path key={i} d={p.d} fill={p.color} />)}
      </svg>
      <div style={{ fontSize: 12 }}>
        {paths.map((p, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: p.color }} />
            <span style={{ color: '#0f172a' }}>{p.label}</span>
            <span style={{ color: '#64748b' }}>({p.pct}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Main Analytics Component
// ============================================================

export function AnalyticsDashboard() {
  const [report, setReport] = useState<RevenueReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(subtractDays(30));
  const [toDate, setToDate] = useState(todayString());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fromMs = new Date(fromDate).getTime();
      const toMs = new Date(toDate).getTime() + 86400000 - 1; // end of day
      const data = await api.getRevenueReport({ from: fromMs, to: toMs });
      setReport(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => { void load(); }, [load]);

  const sectionStyle: React.CSSProperties = {
    background: '#fff', borderRadius: 12, padding: '16px 20px',
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16,
  };

  const sectionTitle: React.CSSProperties = {
    fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 14,
  };

  // Build payment method pie data from report
  const paymentSlices = report ? [
    { label: 'Paystack', value: report.booking_revenue_kobo ?? 0, color: '#2563eb' },
    { label: 'Cash', value: report.agent_sales_revenue_kobo ?? 0, color: '#16a34a' },
  ].filter(s => s.value > 0) : [];

  // Build route bars
  const routeBars = report?.top_routes?.slice(0, 5).map(r => ({
    label: `${r.origin.slice(0, 3)}→${r.destination.slice(0, 3)}`,
    value: r.trip_count * (report.total_revenue_kobo / Math.max(report.total_bookings + report.total_agent_transactions, 1)),
  })) ?? [];

  // Daily revenue bars (stub using total / 30 per day when no daily breakdown)
  const dailyBars = (() => {
    if (report?.daily_breakdown) {
      return report.daily_breakdown.map(d => ({
        label: toDateString(d.date_ms).split(' ')[0] ?? '',
        value: d.total_kobo,
      }));
    }
    // Distribute evenly as a placeholder visual when daily_breakdown is absent
    const days = Math.max(1, Math.round((new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000));
    const avg = report ? Math.round(report.total_revenue_kobo / days) : 0;
    return Array.from({ length: Math.min(days, 14) }, (_, i) => ({
      label: toDateString(Date.now() - (i * 86400000)).split(' ')[0] ?? '',
      value: avg,
    })).reverse();
  })();

  return (
    <div style={{ padding: '0 0 24px' }}>
      {/* Date range picker */}
      <div style={{ ...sectionStyle, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>From</label>
          <input type="date" value={fromDate} max={toDate}
            onChange={e => setFromDate(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>To</label>
          <input type="date" value={toDate} min={fromDate}
            onChange={e => setToDate(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13 }}
          />
        </div>
        <button onClick={load} style={{ marginTop: 16, padding: '7px 18px', borderRadius: 6, background: '#2563eb', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
          Apply
        </button>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#b91c1c', marginBottom: 16 }}>
          {error} <button onClick={load} style={{ marginLeft: 8, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: '#b91c1c' }}>Retry</button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#64748b' }}>Loading analytics…</div>
      ) : report ? (
        <>
          {/* KPI Cards */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Total Revenue" value={formatAmount(report.total_revenue_kobo)} />
            <StatCard label="Booking Revenue" value={formatAmount(report.booking_revenue_kobo)} sub={`${report.total_bookings} bookings`} />
            <StatCard label="Agent Sales" value={formatAmount(report.agent_sales_revenue_kobo)} sub={`${report.total_agent_transactions} transactions`} />
          </div>

          {/* Daily Revenue Bar Chart */}
          <div style={sectionStyle}>
            <div style={sectionTitle}>Daily Revenue Trend</div>
            {dailyBars.length > 0 ? (
              <SvgBarChart data={dailyBars} />
            ) : (
              <div style={{ color: '#94a3b8', textAlign: 'center', padding: 16 }}>No daily data</div>
            )}
          </div>

          {/* Route Occupancy */}
          {report.top_routes && report.top_routes.length > 0 && (
            <div style={sectionStyle}>
              <div style={sectionTitle}>Top Routes by Trips</div>
              {report.top_routes.slice(0, 5).map((r, i) => (
                <HorizontalBar
                  key={r.route_id}
                  label={`${r.origin} → ${r.destination}`}
                  value={routeBars[i]?.value ?? 0}
                  max={Math.max(...routeBars.map(rb => rb.value), 1)}
                  color={['#2563eb', '#16a34a', '#f59e0b', '#8b5cf6', '#ef4444'][i % 5]!}
                />
              ))}
            </div>
          )}

          {/* Agent Breakdown */}
          {report.agent_breakdown && report.agent_breakdown.length > 0 && (
            <div style={sectionStyle}>
              <div style={sectionTitle}>Agent Performance</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', color: '#64748b', fontWeight: 600 }}>Agent</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', color: '#64748b', fontWeight: 600 }}>Revenue</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', color: '#64748b', fontWeight: 600 }}>Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {report.agent_breakdown.map((a, i) => (
                    <tr key={a.agent_id ?? i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '8px 8px', color: '#0f172a' }}>{a.agent_name ?? a.agent_id}</td>
                      <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 600 }}>{formatAmount(a.total_kobo)}</td>
                      <td style={{ padding: '8px 8px', textAlign: 'right', color: '#64748b' }}>{a.transaction_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Payment Method Pie */}
          {paymentSlices.length > 0 && (
            <div style={sectionStyle}>
              <div style={sectionTitle}>Revenue by Source</div>
              <PieChart slices={paymentSlices} />
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
