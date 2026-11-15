export interface Frontmatter {
  fields: Map<string, string>;
  lines: Map<string, number>;
}

export function parseFrontmatter(text: string): Frontmatter | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
  if (end === -1) return null;
  const fields = new Map<string, string>();
  const lineOf = new Map<string, number>();
  let key: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i] as string;
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) {
      key = top[1] as string;
      fields.set(key, unquote(top[2] as string));
      lineOf.set(key, i + 1);
    } else if (key !== null && /^\s+\S/.test(line)) {
      const previous = fields.get(key) as string;
      fields.set(key, `${previous} ${line.trim()}`.trim());
    }
  }
  return { fields, lines: lineOf };
}

function unquote(value: string): string {
  const v = value.trim();
  if (/^[>|][+-]?$/.test(v)) return '';
  const quote = v[0];
  if ((quote === '"' || quote === "'") && v.length >= 2 && v.endsWith(quote)) {
    return v.slice(1, -1);
  }
  return v;
}
