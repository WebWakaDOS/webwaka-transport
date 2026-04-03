/**
 * T-TRN-03: FareRulesPanel — Admin UI for dynamic fare rule management.
 * Allows TENANT_ADMIN to configure surge pricing, peak hours, weekend premiums per route.
 * Gated behind the seat_class_pricing tier feature.
 */
import { useState, useEffect } from 'react';
import { getStoredToken } from '../core/auth/store';
import { formatKobo } from '@webwaka/core';

interface FareRule {
  id: string;
  name: string;
  rule_type: 'surge_period' | 'peak_hours' | 'peak_days' | 'weekend' | 'always';
  base_multiplier: number;
  starts_at: number | null;
  ends_at: number | null;
  days_of_week: string | null;
  hour_from: number | null;
  hour_to: number | null;
  class_multipliers: string | null;
  priority: number;
  is_active: number;
}

interface EffectiveFarePreview {
  route_id: string;
  ref_time_ms: number;
  base_fare: number;
  effective_fare_by_class: Record<string, number>;
}

const RULE_TYPE_LABELS: Record<string, string> = {
  surge_period: 'Surge Period (Date Range)',
  peak_hours: 'Peak Hours',
  peak_days: 'Peak Days',
  weekend: 'Weekend',
  always: 'Always Active',
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeRule(rule: FareRule): string {
  if (rule.rule_type === 'surge_period' && rule.starts_at && rule.ends_at) {
    const from = new Date(rule.starts_at).toLocaleDateString('en-NG', { dateStyle: 'medium' });
    const to = new Date(rule.ends_at).toLocaleDateString('en-NG', { dateStyle: 'medium' });
    return `${from} → ${to}`;
  }
  if (rule.rule_type === 'peak_hours' && rule.hour_from !== null && rule.hour_to !== null) {
    return `${rule.hour_from}:00 – ${rule.hour_to}:00 UTC`;
  }
  if (rule.rule_type === 'peak_days' && rule.days_of_week) {
    const days = (JSON.parse(rule.days_of_week) as number[]).map(d => DAY_NAMES[d]).join(', ');
    return `Every ${days}`;
  }
  if (rule.rule_type === 'weekend') return 'Saturdays & Sundays';
  if (rule.rule_type === 'always') return 'Applies at all times';
  return '';
}

interface Props {
  routeId: string;
  routeLabel: string;
}

export default function FareRulesPanel({ routeId, routeLabel }: Props) {
  const [rules, setRules] = useState<FareRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<FareRule | null>(null);
  const [preview, setPreview] = useState<EffectiveFarePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [form, setForm] = useState({
    name: '',
    rule_type: 'always',
    base_multiplier: '1.2',
    priority: '0',
    starts_at: '',
    ends_at: '',
    hour_from: '',
    hour_to: '',
    days_of_week: [] as number[],
    class_multipliers_standard: '',
    class_multipliers_window: '',
    class_multipliers_vip: '',
    class_multipliers_front: '',
  });

  const token = getStoredToken();

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/operator/routes/${routeId}/fare-rules`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { success: boolean; data: FareRule[]; error?: string };
      if (!data.success) throw new Error(data.error ?? 'Failed to load');
      setRules(data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load fare rules');
    } finally {
      setLoading(false);
    }
  }

  async function loadPreview() {
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/operator/routes/${routeId}/effective-fare?ref_time=${Date.now()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { success: boolean; data: EffectiveFarePreview };
      if (data.success) setPreview(data.data);
    } catch {
      // non-fatal preview failure
    } finally {
      setPreviewLoading(false);
    }
  }

  useEffect(() => {
    load();
    loadPreview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  function resetForm() {
    setForm({
      name: '', rule_type: 'always', base_multiplier: '1.2', priority: '0',
      starts_at: '', ends_at: '', hour_from: '', hour_to: '', days_of_week: [],
      class_multipliers_standard: '', class_multipliers_window: '',
      class_multipliers_vip: '', class_multipliers_front: '',
    });
    setEditingRule(null);
  }

  function openEditForm(rule: FareRule) {
    setEditingRule(rule);
    const cm = rule.class_multipliers ? JSON.parse(rule.class_multipliers) as Record<string, number> : {};
    setForm({
      name: rule.name,
      rule_type: rule.rule_type,
      base_multiplier: String(rule.base_multiplier),
      priority: String(rule.priority),
      starts_at: rule.starts_at ? new Date(rule.starts_at).toISOString().slice(0, 10) : '',
      ends_at: rule.ends_at ? new Date(rule.ends_at).toISOString().slice(0, 10) : '',
      hour_from: rule.hour_from !== null ? String(rule.hour_from) : '',
      hour_to: rule.hour_to !== null ? String(rule.hour_to) : '',
      days_of_week: rule.days_of_week ? JSON.parse(rule.days_of_week) as number[] : [],
      class_multipliers_standard: cm['standard'] ? String(cm['standard']) : '',
      class_multipliers_window: cm['window'] ? String(cm['window']) : '',
      class_multipliers_vip: cm['vip'] ? String(cm['vip']) : '',
      class_multipliers_front: cm['front'] ? String(cm['front']) : '',
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const payload: Record<string, unknown> = {
      name: form.name,
      rule_type: form.rule_type,
      base_multiplier: parseFloat(form.base_multiplier),
      priority: parseInt(form.priority, 10),
    };

    if (form.rule_type === 'surge_period') {
      if (!form.starts_at || !form.ends_at) { setError('Start and end dates are required'); return; }
      payload['starts_at'] = new Date(form.starts_at).getTime();
      payload['ends_at'] = new Date(form.ends_at + 'T23:59:59').getTime();
    }
    if (form.rule_type === 'peak_hours') {
      if (form.hour_from === '' || form.hour_to === '') { setError('Hour range is required'); return; }
      payload['hour_from'] = parseInt(form.hour_from, 10);
      payload['hour_to'] = parseInt(form.hour_to, 10);
    }
    if (form.rule_type === 'peak_days') {
      if (form.days_of_week.length === 0) { setError('Select at least one day'); return; }
      payload['days_of_week'] = form.days_of_week;
    }

    const cm: Record<string, number> = {};
    if (form.class_multipliers_standard) cm['standard'] = parseFloat(form.class_multipliers_standard);
    if (form.class_multipliers_window) cm['window'] = parseFloat(form.class_multipliers_window);
    if (form.class_multipliers_vip) cm['vip'] = parseFloat(form.class_multipliers_vip);
    if (form.class_multipliers_front) cm['front'] = parseFloat(form.class_multipliers_front);
    if (Object.keys(cm).length > 0) payload['class_multipliers'] = cm;

    const isEdit = Boolean(editingRule);
    const url = isEdit
      ? `/api/operator/routes/${routeId}/fare-rules/${editingRule!.id}`
      : `/api/operator/routes/${routeId}/fare-rules`;

    try {
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json() as { success: boolean; error?: string };
      if (!data.success) throw new Error(data.error ?? 'Failed to save');
      setShowForm(false);
      resetForm();
      await Promise.all([load(), loadPreview()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    }
  }

  async function handleDelete(ruleId: string, ruleName: string) {
    if (!confirm(`Delete fare rule "${ruleName}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/operator/routes/${routeId}/fare-rules/${ruleId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { success: boolean; error?: string };
      if (!data.success) throw new Error(data.error ?? 'Failed to delete');
      await Promise.all([load(), loadPreview()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    }
  }

  function toggleDay(day: number) {
    setForm(prev => ({
      ...prev,
      days_of_week: prev.days_of_week.includes(day)
        ? prev.days_of_week.filter(d => d !== day)
        : [...prev.days_of_week, day].sort(),
    }));
  }

  return (
    <div style={{ padding: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Fare Rules — {routeLabel}</h3>
          <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#6b7280' }}>
            Dynamic pricing rules. Highest multiplier wins. Prices locked at reservation time.
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true); }}
          style={{ background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px' }}
        >
          + Add Rule
        </button>
      </div>

      {/* Live Effective Fare Preview */}
      {preview && (
        <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', color: '#0369a1', fontWeight: 600, marginBottom: '8px' }}>
            Effective Fare Now {previewLoading && <span>(refreshing...)</span>}
          </div>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            {Object.entries(preview.effective_fare_by_class).map(([cls, fare]) => (
              <div key={cls} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '11px', color: '#6b7280', textTransform: 'uppercase' }}>{cls}</div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: '#1e3a5f' }}>{formatKobo(fare)}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '6px' }}>
            Base: {formatKobo(preview.base_fare)} · Rules applied to current time
          </div>
        </div>
      )}

      {error && (
        <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px', borderRadius: '6px', marginBottom: '12px', fontSize: '13px' }}>
          {error}
        </div>
      )}

      {/* Rule Form */}
      {showForm && (
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 12px', fontSize: '14px' }}>
            {editingRule ? `Edit: ${editingRule.name}` : 'New Fare Rule'}
          </h4>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
              <label style={{ fontSize: '13px' }}>
                Rule Name *
                <input
                  required
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Christmas Surge 2026"
                  style={{ display: 'block', width: '100%', marginTop: '4px', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px', boxSizing: 'border-box' }}
                />
              </label>
              <label style={{ fontSize: '13px' }}>
                Rule Type *
                <select
                  value={form.rule_type}
                  onChange={e => setForm(p => ({ ...p, rule_type: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: '4px', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                >
                  {Object.entries(RULE_TYPE_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '13px' }}>
                Base Multiplier * (e.g. 1.5 = 50% surge)
                <input
                  required type="number" min="0.5" max="10" step="0.05"
                  value={form.base_multiplier}
                  onChange={e => setForm(p => ({ ...p, base_multiplier: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: '4px', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px', boxSizing: 'border-box' }}
                />
              </label>
              <label style={{ fontSize: '13px' }}>
                Priority (higher = applied first)
                <input
                  type="number" min="0" max="100"
                  value={form.priority}
                  onChange={e => setForm(p => ({ ...p, priority: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: '4px', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px', boxSizing: 'border-box' }}
                />
              </label>
            </div>

            {/* Conditional fields by rule_type */}
            {form.rule_type === 'surge_period' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                <label style={{ fontSize: '13px' }}>
                  Start Date *
                  <input type="date" required value={form.starts_at} onChange={e => setForm(p => ({ ...p, starts_at: e.target.value }))}
                    style={{ display: 'block', width: '100%', marginTop: '4px', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px', boxSizing: 'border-box' }} />
                </label>
                <label style={{ fontSize: '13px' }}>
                  End Date *
                  <input type="date" required value={form.ends_at} onChange={e => setForm(p => ({ ...p, ends_at: e.target.value }))}
                    style={{ display: 'block', width: '100%', marginTop: '4px', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px', boxSizing: 'border-box' }} />
                </label>
              </div>
            )}

            {form.rule_type === 'peak_hours' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                <label style={{ fontSize: '13px' }}>
                  Hour From (0-23 UTC) *
                  <input type="number" min="0" max="23" required value={form.hour_from} onChange={e => setForm(p => ({ ...p, hour_from: e.target.value }))}
                    placeholder="e.g. 16 (4 PM)"
                    style={{ display: 'block', width: '100%', marginTop: '4px', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px', boxSizing: 'border-box' }} />
                </label>
                <label style={{ fontSize: '13px' }}>
                  Hour To (0-23 UTC, exclusive) *
                  <input type="number" min="0" max="23" required value={form.hour_to} onChange={e => setForm(p => ({ ...p, hour_to: e.target.value }))}
                    placeholder="e.g. 21 (9 PM)"
                    style={{ display: 'block', width: '100%', marginTop: '4px', padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px', boxSizing: 'border-box' }} />
                </label>
              </div>
            )}

            {form.rule_type === 'peak_days' && (
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '13px', marginBottom: '6px' }}>Select Days *</div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {DAY_NAMES.map((d, i) => (
                    <button key={i} type="button"
                      onClick={() => toggleDay(i)}
                      style={{
                        padding: '6px 12px', borderRadius: '20px', fontSize: '12px', cursor: 'pointer',
                        background: form.days_of_week.includes(i) ? '#1e3a5f' : '#f1f5f9',
                        color: form.days_of_week.includes(i) ? '#fff' : '#374151',
                        border: '1px solid ' + (form.days_of_week.includes(i) ? '#1e3a5f' : '#d1d5db'),
                      }}
                    >{d}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Per-class multiplier overrides */}
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '13px', marginBottom: '6px', color: '#6b7280' }}>
                Class Multiplier Overrides (optional — overrides base for specific classes)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                {(['standard', 'window', 'vip', 'front'] as const).map(cls => (
                  <label key={cls} style={{ fontSize: '12px' }}>
                    {cls.charAt(0).toUpperCase() + cls.slice(1)}
                    <input type="number" min="0.5" max="10" step="0.05"
                      value={form[`class_multipliers_${cls}`]}
                      onChange={e => setForm(p => ({ ...p, [`class_multipliers_${cls}`]: e.target.value }))}
                      placeholder="e.g. 2.0"
                      style={{ display: 'block', width: '100%', marginTop: '2px', padding: '4px', border: '1px solid #d1d5db', borderRadius: '4px', boxSizing: 'border-box' }} />
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit"
                style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 20px', cursor: 'pointer', fontSize: '13px' }}>
                {editingRule ? 'Update Rule' : 'Create Rule'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); resetForm(); }}
                style={{ background: '#f1f5f9', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px' }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rules list */}
      {loading ? (
        <div style={{ textAlign: 'center', color: '#6b7280', padding: '24px', fontSize: '14px' }}>Loading...</div>
      ) : rules.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#9ca3af', padding: '24px', fontSize: '14px' }}>
          No fare rules configured. Add rules to enable dynamic pricing on this route.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {rules.map(rule => {
            const cm = rule.class_multipliers ? JSON.parse(rule.class_multipliers) as Record<string, number> : null;
            return (
              <div key={rule.id}
                style={{
                  border: '1px solid ' + (rule.is_active ? '#e2e8f0' : '#fee2e2'),
                  borderRadius: '8px', padding: '12px',
                  background: rule.is_active ? '#fff' : '#fef2f2',
                  opacity: rule.is_active ? 1 : 0.7,
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 600, fontSize: '14px' }}>{rule.name}</span>
                      <span style={{
                        fontSize: '10px', padding: '2px 8px', borderRadius: '12px',
                        background: rule.rule_type === 'surge_period' ? '#fef3c7' :
                          rule.rule_type === 'peak_hours' ? '#dbeafe' :
                            rule.rule_type === 'weekend' ? '#f3e8ff' : '#f0fdf4',
                        color: rule.rule_type === 'surge_period' ? '#92400e' :
                          rule.rule_type === 'peak_hours' ? '#1e40af' :
                            rule.rule_type === 'weekend' ? '#6b21a8' : '#166534',
                      }}>
                        {RULE_TYPE_LABELS[rule.rule_type]}
                      </span>
                      {!rule.is_active && (
                        <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '12px', background: '#fee2e2', color: '#dc2626' }}>
                          Inactive
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '13px', color: '#4b5563', marginBottom: '4px' }}>
                      {describeRule(rule)}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', fontSize: '12px', color: '#6b7280' }}>
                      <span>Base ×{rule.base_multiplier.toFixed(2)}</span>
                      {cm && Object.entries(cm).map(([cls, mult]) => (
                        <span key={cls}>{cls} ×{(mult as number).toFixed(2)}</span>
                      ))}
                      <span>Priority {rule.priority}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginLeft: '12px' }}>
                    <button onClick={() => openEditForm(rule)}
                      style={{ background: '#f1f5f9', border: '1px solid #d1d5db', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px' }}>
                      Edit
                    </button>
                    <button onClick={() => handleDelete(rule.id, rule.name)}
                      style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px' }}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
