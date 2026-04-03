/**
 * T-TRN-02: ManifestExportButtons
 * Provides CSV and PDF download buttons for the trip passenger manifest.
 * PDF is generated server-side via the core PDF utility (A4, FRSC-compliant).
 * All data is fetched by the parent — this component only needs the tripId.
 */
import { useState } from 'react';
import { api, ApiError } from '../api/client';

interface Props {
  tripId: string;
  tripLabel?: string;
}

const btnBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 14px',
  borderRadius: 8,
  border: '1px solid',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'opacity .15s',
  textDecoration: 'none',
};

const btnCsv: React.CSSProperties = {
  ...btnBase,
  background: '#f1f5f9',
  borderColor: '#cbd5e1',
  color: '#334155',
};

const btnPdf: React.CSSProperties = {
  ...btnBase,
  background: '#1e3a5f',
  borderColor: '#1e3a5f',
  color: '#fff',
};

const errStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: '#b91c1c',
};

export function ManifestExportButtons({ tripId, tripLabel }: Props) {
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const handleCsvDownload = () => {
    const token = localStorage.getItem('ww_token') ?? '';
    const a = document.createElement('a');
    a.href = `/api/operator/trips/${tripId}/manifest`;
    a.download = `manifest_${tripLabel ?? tripId}.csv`;
    // The CSV route checks Accept header — trigger via anchor will get JSON.
    // So we must do a fetch + blob approach for CSV too.
    setPdfError(null);
    fetch(`/api/operator/trips/${tripId}/manifest`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/csv' },
    })
      .then(async r => {
        if (!r.ok) throw new Error(`CSV download failed (${r.status})`);
        return r.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      })
      .catch(err => setPdfError(err instanceof Error ? err.message : 'CSV download failed'));
  };

  const handlePdfDownload = async () => {
    setPdfError(null);
    setPdfLoading(true);
    try {
      const blob = await api.downloadManifestPdf(tripId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `manifest_${tripLabel ?? tripId}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setPdfError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'PDF download failed');
    } finally {
      setPdfLoading(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={btnCsv} onClick={handleCsvDownload} title="Download passenger list as CSV">
          <span>⬇</span> CSV
        </button>
        <button
          style={{ ...btnPdf, opacity: pdfLoading ? 0.7 : 1 }}
          onClick={handlePdfDownload}
          disabled={pdfLoading}
          title="Download FRSC-compliant PDF manifest"
        >
          {pdfLoading ? '…' : <span>⬇</span>} {pdfLoading ? 'Generating PDF…' : 'PDF Manifest'}
        </button>
      </div>
      {pdfError && <div style={errStyle}>{pdfError}</div>}
    </div>
  );
}
