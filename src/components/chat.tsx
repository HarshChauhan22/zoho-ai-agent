'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useRef, useState } from 'react';
import { REPORT_TOOL, finalReportSchema } from '@/lib/report';
import { TABLE_TOOL, tableResultSchema } from '@/lib/response';
import { ChatText } from './chat-text';
import { TableCard } from './table-card';
import { ReportCard } from './report-card';

const SUGGESTIONS = [
  'Report on my open deals by stage and expected close month',
  'Which leads were created this week and who owns them?',
  'Status report for all active projects: overdue tasks and owners',
];

const transport = new DefaultChatTransport({ api: '/api/chat' });

export function Chat() {
  const { messages, sendMessage, regenerate, status, stop, error } = useChat({ transport });
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  function submit(text: string) {
    if (!text.trim() || busy) return;
    sendMessage({ text });
    setInput('');
  }

  return (
    <main className="shell">
      <header>
        <h1>Zoho Agent</h1>
        <span>CRM + Projects, in plain English</span>
      </header>

      <div className="thread">
        {messages.length === 0 && (
          <div className="empty">
            <p>Ask about your CRM or projects. Ask for a report to get a structured one.</p>
            {SUGGESTIONS.map(s => (
              <button key={s} className="chip" onClick={() => submit(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map(m => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.parts.map((part, i) => {
              if (part.type === 'text') return m.role === 'user' ? <p key={i} className="pre">{part.text}</p> : <ChatText key={i} text={part.text} />;

              if (part.type === `tool-${TABLE_TOOL}`) {
                if (part.state === 'output-error') {
                  return <div key={i} className="tool error">Couldn't build the table. Please try again.</div>;
                }
                if (part.state !== 'output-available') {
                  return <div key={i} className="tool">Building table…</div>;
                }
                const table = tableResultSchema.safeParse(part.output);
                return table.success ? (
                  <TableCard key={i} result={table.data} />
                ) : (
                  <div key={i} className="tool error">Table came back malformed.</div>
                );
              }

              if (part.type === `tool-${REPORT_TOOL}`) {
                if (part.state !== 'output-available') {
                  return <div key={i} className="tool">Writing report…</div>;
                }
                const report = finalReportSchema.safeParse(part.output);
                return report.success ? (
                  <ReportCard key={i} report={report.data} />
                ) : (
                  <div key={i} className="tool error">Report came back malformed.</div>
                );
              }

              if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
                const name =
                  part.type === 'dynamic-tool'
                    ? (part as { toolName: string }).toolName
                    : part.type.slice(5);
                const { state, output } = part as { state: string; output?: { harnessStatus?: string } };
                const empty = state === 'output-available' && output?.harnessStatus === 'empty';
                const icon =
                  state === 'output-error' ? '✕' : empty ? '∅' : state === 'output-available' ? '✓' : '…';
                return (
                  <div key={i} className={`tool ${state === 'output-error' ? 'error' : ''}`}>
                    {icon} {name}
                    {empty && ' – no records'}
                    {state === 'output-error' && ' – failed'}
                  </div>
                );
              }
              return null;
            })}
          </div>
        ))}

        {status === 'submitted' && <div className="tool">Thinking…</div>}
        {error && (
          <div className="tool error">
            {error.message}{' '}
            <button type="button" className="ghost" onClick={() => regenerate()}>
              Retry
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={e => {
          e.preventDefault();
          submit(input);
        }}
      >
        <input
          aria-label="Message"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask about deals, leads, tasks, projects…"
          autoFocus
        />
        {busy ? (
          <button type="button" onClick={stop}>Stop</button>
        ) : (
          <button type="submit" disabled={!input.trim()}>Send</button>
        )}
      </form>
    </main>
  );
}
