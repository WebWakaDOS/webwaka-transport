/**
 * C-003: Conflict Resolution UI
 * Shows unresolved sync conflicts with Accept Server / Retry / Discard actions.
 * Visible only to STAFF, SUPERVISOR, TENANT_ADMIN roles.
 * Invariants: Offline-First, Mobile-First
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { ConflictRecord } from '../core/offline/db';
import { getConflicts, resolveConflict } from '../core/offline/db';

// ============================================================
// Styles
// ============================================================

const containerStyle: React.CSSProperties = {
  padding: '16px',
  maxWidth: 600,
  margin: '0 auto',
};

const headerStyle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 18,
  marginBottom: 16,
  color: '#0f172a',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #fca5a5',
  borderRadius: 10,
  padding: '14px 16px',
  marginBottom: 12,
};

const metaStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#64748b',
  marginBottom: 6,
};

const diffStyle: React.CSSProperties = {
  fontSize: 11,
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: 6,
  padding: '6px 10px',
  marginBottom: 10,
  overflow: 'auto',
  maxHeight: 120,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

const btnGroupStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
};

function actionBtn(color: string, bg: string): React.CSSProperties {
  return {
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 6,
    border: `1px solid ${color}`,
    background: bg,
    color: color,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  };
}

// ============================================================
// Component
// ============================================================

interface ConflictLogProps {
  onClose?: () => void;
}

export function ConflictLog({ onClose }: ConflictLogProps) {
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getConflicts();
      setConflicts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conflicts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleResolve = async (
    conflictId: number,
    resolution: 'accept_server' | 'retry' | 'discard'
  ) => {
    setResolving(prev => new Set([...prev, conflictId]));
    try {
      await resolveConflict(conflictId, resolution);
      setConflicts(prev => prev.filter(c => c.id !== conflictId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve conflict');
    } finally {
      setResolving(prev => {
        const next = new Set(prev);
        next.delete(conflictId);
        return next;
      });
    }
  };

  const formatDate = (ts: number) => new Date(ts).toLocaleString('en-NG');

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span style={{ color: '#dc2626' }}>⚠</span>
        Sync Conflicts
        {onClose && (
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#64748b' }}
          >
            ×
          </button>
        )}
      </div>

      {loading && (
        <div style={{ textAlign: 'center', color: '#64748b', padding: 32 }}>Loading conflicts…</div>
      )}

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#b91c1c', marginBottom: 12 }}>
          {error}
        </div>
      )}

      {!loading && conflicts.length === 0 && (
        <div style={{ textAlign: 'center', color: '#16a34a', padding: 32 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
          No unresolved conflicts
        </div>
      )}

      {conflicts.map(conflict => {
        const id = conflict.id!;
        const busy = resolving.has(id);
        return (
          <div key={id} style={cardStyle}>
            <div style={metaStyle}>
              <strong>{conflict.entity_type}</strong> · {formatDate(conflict.created_at)}
              <span style={{ marginLeft: 8, color: '#dc2626' }}>HTTP {conflict.http_status}</span>
            </div>

            <div style={metaStyle}>Entity ID: <code>{conflict.entity_id}</code></div>

            <div style={{ ...metaStyle, marginBottom: 4 }}>Local payload:</div>
            <div style={diffStyle}>{JSON.stringify(conflict.local_payload, null, 2)}</div>

            {Object.keys(conflict.server_payload).length > 0 && (
              <>
                <div style={{ ...metaStyle, marginBottom: 4 }}>Server response:</div>
                <div style={diffStyle}>{JSON.stringify(conflict.server_payload, null, 2)}</div>
              </>
            )}

            <div style={btnGroupStyle}>
              <button
                disabled={busy}
                onClick={() => handleResolve(id, 'accept_server')}
                style={actionBtn('#16a34a', busy ? '#f1f5f9' : '#f0fdf4')}
                title="Mark resolved — use the server's version"
              >
                Accept Server
              </button>
              <button
                disabled={busy}
                onClick={() => handleResolve(id, 'retry')}
                style={actionBtn('#2563eb', busy ? '#f1f5f9' : '#eff6ff')}
                title="Re-queue this mutation for another sync attempt"
              >
                Retry
              </button>
              <button
                disabled={busy}
                onClick={() => handleResolve(id, 'discard')}
                style={actionBtn('#64748b', busy ? '#f1f5f9' : '#f8fafc')}
                title="Discard this change — local change is abandoned"
              >
                Discard
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
