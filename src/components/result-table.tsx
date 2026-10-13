import type { DisplayTable } from '@/lib/table';

/** A real HTML table (one <th> per column). Empty cells show a dash. */
export function ResultTable({ table }: { table: DisplayTable }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th key={i} scope="col" className={c.align === 'right' ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r} className={row.kind === 'data' ? undefined : row.kind}>
              {row.cells.map((cell, c) => (
                <td key={c} className={table.columns[c]?.align === 'right' ? 'num' : undefined}>
                  {cell === '' ? <span className="dash">—</span> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
