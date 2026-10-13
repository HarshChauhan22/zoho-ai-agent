import type { Report } from '../report';
import { columnTotals, formatGeneratedAt, normalizedRows } from './model';

/**
 * Professional PDF of a Report (title, generation date, summary, metrics, tables with calculated
 * totals, insights, caveats, sources). jsPDF is loaded on demand so it stays out of the main bundle.
 *
 * jsPDF's built-in fonts only cover Latin-1, so other characters are transliterated; anything
 * unknown becomes "?" (the CSV export keeps the original text).
 */

const REPLACEMENTS: Record<string, string> = {
  '₹': 'Rs ', '€': 'EUR ', '£': 'GBP ', '¥': 'JPY ', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"',
  '…': '...', '•': '-', '→': '->', '×': 'x', '✓': 'OK', '✕': 'X', ' ': ' ', ' ': ' ', ' ': ' ',
};

export function pdfSafe(text: string): string {
  return Array.from(text.normalize('NFC'))
    .map(ch => REPLACEMENTS[ch] ?? (/[\n\t\x20-\x7e¡-ÿ]/.test(ch) ? ch : '?'))
    .join('');
}

const INK: [number, number, number] = [28, 28, 26];
const MUTED: [number, number, number] = [107, 107, 102];
const ACCENT: [number, number, number] = [31, 94, 255];

export async function reportToPdf(report: Report, now = new Date()): Promise<Uint8Array> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);

  const widest = Math.max(0, ...report.sections.map(s => s.table?.columns.length ?? 0));
  const doc = new jsPDF({ orientation: widest > 6 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4', compress: false });
  doc.setProperties({ title: pdfSafe(report.title), subject: 'Zoho report', creator: 'Zoho Agent' });

  const margin = 40;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const contentW = pageW - margin * 2;
  let y = margin;

  const ensure = (needed: number) => {
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };
  const paragraph = (text: string, size = 10, color = INK, indent = 0) => {
    doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(...color);
    for (const line of doc.splitTextToSize(pdfSafe(text), contentW - indent) as string[]) {
      ensure(size * 1.4);
      doc.text(line, margin + indent, (y += size * 1.4));
    }
    y += 4;
  };
  const heading = (text: string) => {
    ensure(34);
    y += 10;
    doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(...ACCENT);
    doc.text(pdfSafe(text), margin, (y += 14));
    y += 4;
  };
  const table = (head: string[], body: string[][], foot?: string[]) => {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin, bottom: margin },
      head: [head.map(pdfSafe)],
      body: body.map(r => r.map(pdfSafe)),
      foot: foot ? [foot.map(pdfSafe)] : undefined,
      showFoot: 'lastPage',
      theme: 'striped',
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, overflow: 'linebreak', textColor: INK },
      headStyles: { fillColor: ACCENT, textColor: [255, 255, 255], fontStyle: 'bold' },
      footStyles: { fillColor: [235, 238, 245], textColor: INK, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [247, 247, 245] },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  };

  // Title block
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...INK);
  for (const line of doc.splitTextToSize(pdfSafe(report.title), contentW) as string[]) doc.text(line, margin, (y += 24));
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...MUTED);
  doc.text(`Generated ${formatGeneratedAt(report, now)}  |  Source: Zoho`, margin, (y += 16));
  doc.setDrawColor(...MUTED).setLineWidth(0.5).line(margin, (y += 8), pageW - margin, y);

  if (report.summary.trim()) {
    heading('Summary');
    paragraph(report.summary, 10.5);
  }
  if (report.metrics.length) {
    heading('Key metrics');
    table(['Metric', 'Value', 'Note'], report.metrics.map(m => [m.label, m.value, m.note ?? '']));
  }
  for (const s of report.sections) {
    heading(s.heading);
    if (s.body?.trim()) paragraph(s.body);
    if (s.table?.columns.length) table(s.table.columns, normalizedRows(s.table), columnTotals(s.table));
  }
  if (report.insights.length) {
    heading('Insights');
    report.insights.forEach(t => paragraph(`-  ${t}`, 10, INK, 6));
  }
  if (report.caveats.length) {
    heading('Caveats');
    report.caveats.forEach(t => paragraph(`-  ${t}`, 9, MUTED, 6));
  }
  if (report.sources.length) {
    heading('Sources');
    table(['Zoho tool', 'OK', 'Empty', 'Failed'], report.sources.map(s => [s.tool, String(s.ok), String(s.empty), String(s.failed)]));
  }

  // Footer on every page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i).setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
    doc.text(`Page ${i} of ${pages}`, pageW - margin, pageH - 18, { align: 'right' });
    doc.text(pdfSafe(report.title).slice(0, 80), margin, pageH - 18);
  }

  return new Uint8Array(doc.output('arraybuffer'));
}
