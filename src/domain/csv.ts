/** Minimal RFC 4180-ish CSV encoder — no external dependency for a handful of columns. */

function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render rows as CSV text using an explicit column list, so the shape stays stable even when a field is missing on some rows. */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(row[c])).join(','));
  }
  return lines.join('\n');
}
