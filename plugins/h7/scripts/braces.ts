const NUMERIC = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/;
const ALPHA = /^([a-zA-Z])\.\.([a-zA-Z])$/;

export const MAX_EXPANSIONS = 256;
export const MAX_WORD_LENGTH = 1024;
export const MAX_GROUPS = 16;
const MAX_DIGITS = 9;

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

function boundedInteger(text: string | undefined, fallback: number): number | null {
  if (text === undefined) return fallback;
  if (text.replace('-', '').length > MAX_DIGITS) return null;
  return Number(text);
}

function sequence(body: string): string[] | null | undefined {
  const numeric = NUMERIC.exec(body);
  if (numeric) {
    const from = boundedInteger(numeric[1], 0);
    const to = boundedInteger(numeric[2], 0);
    const rawStep = boundedInteger(numeric[3], 1);
    if (from === null || to === null || rawStep === null) return null;
    const step = Math.abs(rawStep) || 1;
    if (Math.abs(to - from) / step + 1 > MAX_EXPANSIONS) return null;
    const out: string[] = [];
    for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) {
      out.push(String(n));
    }
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

function expand(word: string): string[] | null {
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
      const inner = expand(prefix + alternative + suffix);
      if (inner === null) return null;
      results.push(...inner);
      if (results.length > MAX_EXPANSIONS) return null;
    }
    return results;
  }
  return [word];
}

export function expandBraces(word: string): string[] | null {
  if (!word.includes('{')) return [word];
  if (word.length > MAX_WORD_LENGTH || word.split('{').length - 1 > MAX_GROUPS) return null;
  return expand(word);
}
