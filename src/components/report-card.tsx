import type { Report } from '@/lib/report';
import { ExportActions } from './export-actions';
import { ResultTable } from './result-table';

export function ReportCard({ report }: { report: Report }) {
  return (
    <article className={`report ${report.status === 'no_data' ? 'no-data' : ''}`}>
      <h2>{report.title}</h2>
      <p className="lede">{report.summary}</p>

      {report.metrics.length > 0 && (
        <dl className="metrics">
          {report.metrics.map((m, i) => (
            <div key={i}>
              <dt>{m.label}</dt>
              <dd>{m.value}</dd>
              {m.note && <small>{m.note}</small>}
            </div>
          ))}
        </dl>
      )}

      {report.sections.map((s, i) => (
        <section key={i}>
          <h3>{s.heading}</h3>
          {s.body && <p className="pre">{s.body}</p>}
          {s.table && (
            <ResultTable
              table={{
                columns: s.table.columns.map(label => ({ label, align: 'left' as const })),
                rows: s.table.rows.map(cells => ({ kind: 'data' as const, cells })),
              }}
            />
          )}
        </section>
      ))}

      {report.insights.length > 0 && (
        <section>
          <h3>Insights</h3>
          <ul>{report.insights.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </section>
      )}

      {report.caveats.length > 0 && (
        <section className="caveats">
          <h3>Caveats</h3>
          <ul>{report.caveats.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </section>
      )}

      {report.sources.length > 0 && (
        <footer className="sources">
          Data from Zoho:{' '}
          {report.sources
            .map(
              s =>
                `${s.tool} (${s.ok} ok${s.empty ? `, ${s.empty} empty` : ''}${s.failed ? `, ${s.failed} failed` : ''})`,
            )
            .join(' · ')}
        </footer>
      )}

      <ExportActions report={report} json />
    </article>
  );
}
