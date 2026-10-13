'use client';

import { useState } from 'react';
import { downloadReport, type ExportFormat } from '@/lib/export/download';
import { hasExportableContent } from '@/lib/export/model';
import type { Report } from '@/lib/report';

/** Download CSV / PDF (and optionally JSON) for whatever is on screen. Hidden when there is nothing to export. */
export function ExportActions({ report, json = false }: { report: Report; json?: boolean }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exportable = hasExportableContent(report);

  async function run(format: ExportFormat) {
    setError(null);
    setBusy(format);
    try {
      await downloadReport(report, format);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="actions">
        {exportable && (
          <>
            <button className="ghost" disabled={busy !== null} onClick={() => run('csv')}>
              {busy === 'csv' ? 'Preparing CSV…' : 'Download CSV'}
            </button>
            <button className="ghost" disabled={busy !== null} onClick={() => run('pdf')}>
              {busy === 'pdf' ? 'Preparing PDF…' : 'Download PDF'}
            </button>
          </>
        )}
        {json && (
          <button className="ghost" onClick={() => downloadJson(report)}>
            Download JSON
          </button>
        )}
      </div>
      {!exportable && <p className="export-note">No report data to export.</p>}
      {error && (
        <p className="tool error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function downloadJson(report: Report) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
