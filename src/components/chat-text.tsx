'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitMarkdownTables } from '@/lib/markdown-tables';
import { tableToReport } from '@/lib/table';
import { ExportActions } from './export-actions';
import { ResultTable } from './result-table';

/**
 * Renders assistant text as formatted Markdown (bold, lists, links), never as raw syntax.
 * Any Markdown table the model wrote is detected by its structure and shown as a real table with
 * the same CSV/PDF downloads as a structured table.
 */
export function ChatText({ text }: { text: string }) {
  return (
    <>
      {splitMarkdownTables(text).map((seg, i) =>
        seg.type === 'text' ? (
          <div key={i} className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
          </div>
        ) : (
          <article key={i} className="report table-only">
            <ResultTable table={seg.table} />
            <ExportActions report={tableToReport({ title: 'Table', table: seg.table })} />
          </article>
        ),
      )}
    </>
  );
}
