import type { Report } from '../report';
import { reportToCsv } from './csv';
import { exportFileName, hasExportableContent } from './model';

/** Browser-only: turns an export into a file download. */

export type ExportFormat = 'csv' | 'pdf';

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Throws an Error with a user-readable message on any failure. */
export async function downloadReport(report: Report, format: ExportFormat): Promise<void> {
  if (!hasExportableContent(report)) throw new Error('There is no report data to export.');
  try {
    if (format === 'csv') {
      save(new Blob([reportToCsv(report)], { type: 'text/csv;charset=utf-8' }), exportFileName(report, 'csv'));
    } else {
      const { reportToPdf } = await import('./pdf');
      const bytes = await reportToPdf(report);
      save(new Blob([bytes as BlobPart], { type: 'application/pdf' }), exportFileName(report, 'pdf'));
    }
  } catch (err) {
    console.error(`[export:${format}]`, err);
    throw new Error(`Couldn't create the ${format.toUpperCase()} file. Please try again.`);
  }
}
