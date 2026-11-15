const NUMERIC = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/;
const ALPHA = /^([a-zA-Z])\.\.([a-zA-Z])$/;

export const MAX_EXPANSIONS = 256;

function matchingClose(word: string, open: number): number {
  let depth = 0;
  for (let i = open; i < word.length; i++) {
    if (word[i] === '{') depth++;
    if (word[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') depth++;
    if (body[i] === '}') depth--;
    if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function sequence(body: string): string[] | null | undefined {
  const numeric = NUMERIC.exec(body);
  if (numeric) {
    const from = Number(numeric[1]);
    const to = Number(numeric[2]);
    const step = Math.abs(Number(numeric[3] ?? 1)) || 1;
    if (Math.abs(to - from) / step + 1 > MAX_EXPANSIONS) return null;
    const out: string[] = [];
    for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) out.push(String(n));
    return out;
  }
  const alpha = ALPHA.exec(body);
  if (alpha) {
    const from = (alpha[1] as string).charCodeAt(0);
    const to = (alpha[2] as string).charCodeAt(0);
    const out: string[] = [];
    for (let c = from; from <= to ? c <= to : c >= to; c += from <= to ? 1 : -1) out.push(String.fromCharCode(c));
    return out;
  }
  return undefined;
}

export function expandBraces(word: string): string[] | null {
  for (let open = word.indexOf('{'); open !== -1; open = word.indexOf('{', open + 1)) {
    if (word[open - 1] === '$') continue;
    const close = matchingClose(word, open);
    if (close === -1) continue;
    const body = word.slice(open + 1, close);
    const parts = splitTopLevel(body);
    const alternatives = parts.length > 1 ? parts : sequence(body);
    if (alternatives === undefined) continue;
    if (alternatives === null) return null;
    const prefix = word.slice(0, open);
    const suffix = word.slice(close + 1);
    const results: string[] = [];
    for (const alternative of alternatives) {
      const inner = expandBraces(prefix + alternative + suffix);
      if (inner === null) return null;
      results.push(...inner);
      if (results.length > MAX_EXPANSIONS) return null;
    }
    return results;
  }
  return [word];
}
