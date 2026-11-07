import { useMemo } from 'react';

/**
 * CSV as the agent writes it: quoted cells may hold commas, quotes ("") and
 * line breaks. The separator is whichever of , ; or tab the first line uses most.
 * Null for one column: that is a list, not a table.
 */
export function readCsv(content: string): { columns: string[]; rows: unknown[][] } | null {
  const text = content.replace(/^﻿/, '');
  const head = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].reduce((a, b) => (head.split(b).length > head.split(a).length ? b : a));
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  if (rows.length < 2 || rows[0].length < 2) return null;
  return { columns: rows[0], rows: rows.slice(1) };
}

/** Accept the same three JSON shapes as artifact export, or CSV. Keep every column. */
function readTable(content: string): { columns: string[]; rows: unknown[][] } | null {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return readCsv(content); }
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(value)) {
    if (!value.length) return { columns: [], rows: [] };
    if (value.every(Array.isArray)) return { columns: value[0].map(String), rows: value.slice(1) };
    if (value.every(record)) {
      const columns = Array.from(new Set(value.flatMap(Object.keys)));
      return { columns, rows: value.map((row) => columns.map((key) => row[key])) };
    }
  } else if (record(value) && Array.isArray(value.columns) && Array.isArray(value.rows)) {
    const columns = value.columns.map(String);
    if (!value.rows.every((row) => Array.isArray(row) || record(row))) return null;
    return { columns, rows: value.rows.map((row) => Array.isArray(row) ? row : columns.map((key) => row[key])) };
  }
  return null;
}

function cell(value: unknown): string {
  return value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function TablePreview({ title, content }: { title: string; content: string }) {
  const table = useMemo(() => readTable(content), [content]);
  if (!table) return <div className="min-h-0 flex-1 overflow-auto p-4">
    <p role="status" className="mb-3 text-sm text-text-muted">This data cannot be displayed as a table. Its source is shown below.</p>
    <pre className="whitespace-pre-wrap break-words text-xs">{content}</pre>
  </div>;
  if (!table.columns.length) return <p className="p-6 text-sm text-text-muted">This table is empty.</p>;
  return <div className="min-h-0 flex-1 overflow-auto thin-scrollbar" tabIndex={0} aria-label={`${title} table viewer`}>
    <table aria-label={title} className="w-full border-collapse text-left text-sm text-text-primary">
      <thead className="sticky top-0 bg-bg-elevated">
        <tr>{table.columns.map((column, i) => <th key={i} scope="col" className="border-b border-border-default px-4 py-3 font-medium whitespace-nowrap">{column}</th>)}</tr>
      </thead>
      <tbody>{table.rows.map((row, i) => <tr key={i} className="even:bg-bg-elevated/40 hover:bg-bg-hover">
        {table.columns.map((_, j) => <td key={j} className="max-w-96 whitespace-pre-wrap break-words border-b border-border-subtle px-4 py-3 tabular-nums align-top">{cell(row[j])}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}
