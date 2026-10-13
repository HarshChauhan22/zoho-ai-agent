import { tableToReport, type DisplayTable } from '@/lib/table';
import type { TableResult } from '@/lib/response';
import { ExportActions } from './export-actions';
import { ResultTable } from './result-table';

/** Summary (if any) above a real table, with notes, sources and CSV/PDF downloads of exactly what is shown. */
export function TableCard({ result }: { result: TableResult }) {
  const table: DisplayTable = { columns: result.columns, rows: result.rows };
  const ok = result.status === 'ok' && result.rows.length > 0;
  const report = tableToReport({
    title: result.title,
    summary: result.summary,
    table,
    notes: result.notes,
    sources: result.sources,
    generatedAt: result.generatedAt,
    status: ok ? 'complete' : 'no_data',
  });

  return (
    <article className={`report ${ok ? '' : 'no-data'}`}>
      <h2>{result.title}</h2>
      {result.summary && <p className="lede">{result.summary}</p>}
      {ok ? <ResultTable table={table} /> : <p className="lede">{result.message ?? 'There is no data to show.'}</p>}
      {result.notes.length > 0 && (
        <section className="caveats">
          <ul>
            {result.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}
      {result.sources.length > 0 && (
        <footer className="sources">
          Data from Zoho:{' '}
          {result.sources
            .map(s => `${s.tool} (${s.ok} ok${s.empty ? `, ${s.empty} empty` : ''}${s.failed ? `, ${s.failed} failed` : ''})`)
            .join(' · ')}
        </footer>
      )}
      {ok && <ExportActions report={report} />}
    </article>
  );
}
