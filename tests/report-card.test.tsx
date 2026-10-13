import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportCard } from '../src/components/report-card';
import { finalReportSchema } from '../src/lib/report';

const base = { title: 'Pipeline', summary: 'Three deals.', metrics: [], sections: [], insights: [], caveats: [] };

test('report card: CSV and PDF buttons appear for a report with content', () => {
  const html = renderToStaticMarkup(<ReportCard report={finalReportSchema.parse(base)} />);
  assert.match(html, /Download CSV/);
  assert.match(html, /Download PDF/);
  assert.doesNotMatch(html, /No report data to export/);
});

test('report card: no CSV/PDF buttons, and a clear note, when there is nothing to export', () => {
  for (const r of [
    finalReportSchema.parse({ ...base, status: 'no_data' }),
    finalReportSchema.parse({ ...base, summary: ' ' }),
  ]) {
    const html = renderToStaticMarkup(<ReportCard report={r} />);
    assert.doesNotMatch(html, /Download CSV|Download PDF/);
    assert.match(html, /No report data to export/);
  }
});
