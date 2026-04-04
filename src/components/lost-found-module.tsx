/**
 * WebWaka Transport — Lost & Found Portal
 *
 * Allows passengers, drivers, and staff to:
 *   - Report a lost or found item
 *   - Search the registry by description or category
 *   - Initiate a claim for a found item
 *   - Track claim status
 *
 * Nigeria-First: clear, simple UI optimized for low-literacy contexts.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../core/auth/context';
import { useOnlineStatus } from '../core/offline/hooks';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', border: '1px solid #e2e8f0',
  borderRadius: 8, fontSize: 14, boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  width: '100%', padding: '12px 0', background: '#1e40af', color: '#fff',
  border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer',
};

const pillStyle = (active: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: 20,
  border: `1px solid ${active ? '#1e40af' : '#e2e8f0'}`,
  background: active ? '#eff6ff' : '#fff',
  color: active ? '#1e40af' : '#64748b',
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
});

const CATEGORIES = ['bag', 'phone', 'wallet', 'clothing', 'documents', 'electronics', 'other'] as const;

type LostFoundItem = {
  id: string; reporter_name: string; reporter_phone: string;
  item_description: string; item_category: string | null;
  status: string; created_at: number; found_at: string | null;
  storage_location: string | null;
};

export function LostFoundModule() {
  const { user } = useAuth();
  const online = useOnlineStatus();
  const [tab, setTab] = useState<'report' | 'search' | 'claim'>('search');
  const [items, setItems] = useState<LostFoundItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [selectedItem, setSelectedItem] = useState<LostFoundItem | null>(null);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  // Report form
  const [reportForm, setReportForm] = useState({
    reporter_name: user?.name ?? '',
    reporter_phone: '',
    reporter_type: 'passenger' as 'passenger' | 'driver' | 'staff',
    item_description: '',
    item_category: '',
    found_at: '',
    trip_id: '',
    notes: '',
  });

  // Claim form
  const [claimForm, setClaimForm] = useState({ claimant_name: '', claimant_phone: '' });
  const [claiming, setClaiming] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listLostFound({
        status: filterStatus || undefined,
        category: filterCategory || undefined,
        search: search || undefined,
      });
      setItems(res as LostFoundItem[]);
    } catch { setError('Failed to load items'); }
    finally { setLoading(false); }
  }, [filterStatus, filterCategory, search]);

  useEffect(() => { if (tab === 'search' || tab === 'claim') void loadItems(); }, [tab, loadItems]);

  const report = async () => {
    if (!reportForm.reporter_name || !reportForm.reporter_phone || !reportForm.item_description) {
      setError('Name, phone, and item description are required'); return;
    }
    setLoading(true); setError('');
    try {
      const res = await api.reportLostFound({
        operator_id: user?.operator_id ?? 'public',
        reporter_type: reportForm.reporter_type,
        reporter_name: reportForm.reporter_name,
        reporter_phone: reportForm.reporter_phone,
        item_description: reportForm.item_description,
        item_category: reportForm.item_category || undefined,
        found_at: reportForm.found_at || undefined,
        trip_id: reportForm.trip_id || undefined,
        notes: reportForm.notes || undefined,
      });
      setSuccess(`Item reported! Reference: ${res.item_id}`);
      setReportForm(f => ({ ...f, item_description: '', found_at: '', trip_id: '', notes: '', item_category: '' }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to report item');
    } finally { setLoading(false); }
  };

  const claim = async () => {
    if (!selectedItem || !claimForm.claimant_name || !claimForm.claimant_phone) return;
    setClaiming(true); setError('');
    try {
      await api.claimLostFoundItem(selectedItem.id, claimForm);
      setSuccess('Claim submitted! Contact the operator to collect your item.');
      setSelectedItem(null);
      setTab('search');
      void loadItems();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to submit claim');
    } finally { setClaiming(false); }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'reported': return { bg: '#fef3c7', text: '#92400e' };
      case 'stored': return { bg: '#dbeafe', text: '#1e40af' };
      case 'claimed': return { bg: '#dcfce7', text: '#166534' };
      case 'disposed': return { bg: '#f1f5f9', text: '#64748b' };
      default: return { bg: '#f1f5f9', text: '#64748b' };
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🔍 Lost & Found</h2>
        {!online && <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>OFFLINE</span>}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'search' as const, label: '🔍 Browse Items' },
          { key: 'report' as const, label: '📝 Report Item' },
          { key: 'claim' as const, label: '🙋 Claim Item' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={pillStyle(tab === t.key)}>{t.label}</button>
        ))}
      </div>

      {success && <div style={{ padding: '10px 14px', background: '#dcfce7', borderRadius: 8, color: '#166534', fontSize: 13, marginBottom: 12 }}>{success}</div>}
      {error && <div style={{ padding: '10px 14px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {/* Search/Browse Tab */}
      {(tab === 'search' || tab === 'claim') && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            <button onClick={() => void loadItems()} style={{ padding: '10px 16px', background: '#1e40af', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>Go</button>
          </div>
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10 }}>
            <button onClick={() => setFilterCategory('')} style={pillStyle(!filterCategory)}>All</button>
            {CATEGORIES.map(c => (
              <button key={c} onClick={() => setFilterCategory(c)} style={pillStyle(filterCategory === c)}>
                {c}
              </button>
            ))}
          </div>

          {loading && <div style={{ textAlign: 'center', color: '#94a3b8', padding: 20 }}>Loading…</div>}

          {!loading && items.length === 0 && (
            <div style={{ textAlign: 'center', color: '#94a3b8', padding: 32, fontSize: 14 }}>
              No items found. {tab === 'report' ? '' : 'Try adjusting filters or report your lost item.'}
            </div>
          )}

          {items.map(item => {
            const sc = statusColor(item.status);
            return (
              <div key={item.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, paddingRight: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{item.item_description}</div>
                    {item.item_category && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>Category: {item.item_category}</div>}
                    {item.found_at && <div style={{ fontSize: 12, color: '#64748b' }}>Found at: {item.found_at}</div>}
                    {item.storage_location && <div style={{ fontSize: 12, color: '#64748b' }}>Stored: {item.storage_location}</div>}
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                      Reported {new Date(item.created_at).toLocaleDateString('en-NG')}
                    </div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: 12, background: sc.bg, color: sc.text, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {item.status}
                  </span>
                </div>
                {tab === 'claim' && (item.status === 'reported' || item.status === 'stored') && (
                  <button
                    onClick={() => { setSelectedItem(item); setError(''); }}
                    style={{ marginTop: 10, width: '100%', padding: '8px 0', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}
                  >
                    🙋 Claim This Item
                  </button>
                )}
              </div>
            );
          })}

          {/* Claim Modal */}
          {selectedItem && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', zIndex: 9999 }}>
              <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', padding: 24, maxWidth: 480, margin: '0 auto' }}>
                <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Claim: {selectedItem.item_description}</div>
                <div style={{ fontSize: 13, color: '#64748b', marginBottom: 14 }}>Provide your details to initiate a claim.</div>
                <input placeholder="Your full name" value={claimForm.claimant_name} onChange={e => setClaimForm(f => ({ ...f, claimant_name: e.target.value }))} style={{ ...inputStyle, marginBottom: 8 }} />
                <input placeholder="Your phone number" value={claimForm.claimant_phone} onChange={e => setClaimForm(f => ({ ...f, claimant_phone: e.target.value }))} style={{ ...inputStyle, marginBottom: 14 }} />
                {error && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{error}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setSelectedItem(null)} style={{ flex: 1, padding: '12px 0', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={() => void claim()} disabled={claiming} style={{ ...primaryBtnStyle, flex: 2 }}>{claiming ? 'Submitting…' : 'Submit Claim'}</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Report Tab */}
      {tab === 'report' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {(['passenger', 'driver', 'staff'] as const).map(t => (
              <button key={t} onClick={() => setReportForm(f => ({ ...f, reporter_type: t }))} style={pillStyle(reportForm.reporter_type === t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input placeholder="Your full name" value={reportForm.reporter_name} onChange={e => setReportForm(f => ({ ...f, reporter_name: e.target.value }))} style={inputStyle} />
            <input placeholder="Your phone number" value={reportForm.reporter_phone} onChange={e => setReportForm(f => ({ ...f, reporter_phone: e.target.value }))} style={inputStyle} />
            <textarea placeholder="Describe the item (colour, size, brand, contents…)" value={reportForm.item_description} onChange={e => setReportForm(f => ({ ...f, item_description: e.target.value }))} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            <select value={reportForm.item_category} onChange={e => setReportForm(f => ({ ...f, item_category: e.target.value }))} style={inputStyle}>
              <option value="">Select category (optional)</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input placeholder="Where was it found / lost? (e.g. Bus Park Yaba, Lagos)" value={reportForm.found_at} onChange={e => setReportForm(f => ({ ...f, found_at: e.target.value }))} style={inputStyle} />
            <input placeholder="Trip ID (if known)" value={reportForm.trip_id} onChange={e => setReportForm(f => ({ ...f, trip_id: e.target.value }))} style={inputStyle} />
            <textarea placeholder="Additional notes" value={reportForm.notes} onChange={e => setReportForm(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />

            <button onClick={() => void report()} disabled={loading || !online} style={primaryBtnStyle}>
              {loading ? 'Submitting…' : !online ? 'Offline — cannot submit' : '📝 Submit Report'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
