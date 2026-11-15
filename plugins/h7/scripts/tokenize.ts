export type Dialect = 'sh' | 'ps';

export interface Tokenized {
  segments: string[][];
  nested: string[];
}

interface Heredoc {
  delimiter: string;
  strip: boolean;
  quoted: boolean;
}

const SH_ESCAPABLE = new Set([' ', '\t', "'", '"', '\\', '$', '`', ';', '|', '&', '(', ')', '<', '>', '#', '!', ']', '{', '}', '~']);
const REDIRECT = /^(?:\d+|&)?(<<<|>>|>\||<&|>&|>|<)(.*)$/s;
const PROBE = /^[ \t]*\r?\n/;

export function tokenize(input: string, dialect: Dialect = 'sh'): Tokenized {
  const ps = dialect === 'ps';
  const segments: string[][] = [];
  const nested: string[] = [];
  const heredocs: Heredoc[] = [];
  let segment: string[] = [];
  let current: string | null = null;
  let quoted = false;
  let dropNext = false;
  let literalBraces = 0;
  let i = 0;
  const n = input.length;

  const append = (text: string): void => {
    current = (current ?? '') + text;
  };

  const flush = (): void => {
    if (current === null) return;
    const word = current;
    const wasQuoted = quoted;
    current = null;
    quoted = false;
    if (dropNext) {
      dropNext = false;
      return;
    }
    if (!wasQuoted) {
      const redirect = REDIRECT.exec(word);
      if (redirect) {
        dropNext = redirect[2] === '';
        return;
      }
    }
    segment.push(word);
  };

  const endSegment = (): void => {
    flush();
    dropNext = false;
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  const readParen = (start: number): [string, number] => {
    let depth = 1;
    let j = start;
    while (j < n) {
      const ch = input[j] as string;
      if ((ch === '\\' && !ps) || (ch === '`' && ps)) {
        j += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        j++;
        while (j < n && input[j] !== ch) {
          j += (input[j] === '\\' && !ps && ch === '"') || (input[j] === '`' && ps && ch === '"') ? 2 : 1;
        }
        j++;
        continue;
      }
      if (ch === '(') depth++;
      if (ch === ')') {
        depth--;
        if (depth === 0) return [input.slice(start, j), j + 1];
      }
      j++;
    }
    return [input.slice(start), n];
  };

  const readBacktick = (start: number): [string, number] => {
    let j = start;
    while (j < n) {
      if (input[j] === '\\') {
        j += 2;
        continue;
      }
      if (input[j] === '`') return [input.slice(start, j), j + 1];
      j++;
    }
    return [input.slice(start), n];
  };

  const readDouble = (start: number): number => {
    let j = start;
    let out = '';
    while (j < n) {
      const ch = input[j] as string;
      const next = input[j + 1];
      if (ch === '"') {
        if (ps && next === '"') {
          out += '"';
          j += 2;
          continue;
        }
        break;
      }
      if (ch === '\\' && !ps) {
        if (next === '\n') {
          j += 2;
        } else if (next !== undefined && '"\\$`'.includes(next)) {
          out += next;
          j += 2;
        } else {
          out += ch;
          j++;
        }
        continue;
      }
      if (ch === '`' && ps) {
        out += next ?? '';
        j += 2;
        continue;
      }
      if (ch === '`') {
        const [content, end] = readBacktick(j + 1);
        nested.push(content);
        out += input.slice(j, end);
        j = end;
        continue;
      }
      if (ch === '$' && next === '(') {
        const [content, end] = readParen(j + 2);
        nested.push(content);
        out += input.slice(j, end);
        j = end;
        continue;
      }
      out += ch;
      j++;
    }
    append(out);
    return j + 1;
  };

  const readSingle = (start: number): number => {
    let j = start;
    let out = '';
    while (j < n) {
      if (input[j] === "'") {
        if (ps && input[j + 1] === "'") {
          out += "'";
          j += 2;
          continue;
        }
        break;
      }
      out += input[j];
      j++;
    }
    append(out);
    return j + 1;
  };

  const substitutionsOf = (body: string, kind: Dialect): void => {
    const escaped = kind === 'ps' ? body.replaceAll('"', '""') : body.replaceAll('"', '\\"');
    nested.push(...tokenize(`"${escaped} "`, kind).nested);
  };

  const readHeredocDelimiter = (start: number): number => {
    let j = start;
    const strip = input[j] === '-';
    if (strip) j++;
    while (input[j] === ' ' || input[j] === '\t') j++;
    let delimiter = '';
    let isQuoted = false;
    while (j < n) {
      const ch = input[j] as string;
      if (ch === "'" || ch === '"') {
        isQuoted = true;
        const close = input.indexOf(ch, j + 1);
        const end = close === -1 ? n : close;
        delimiter += input.slice(j + 1, end);
        j = end + 1;
      } else if (ch === '\\') {
        isQuoted = true;
        delimiter += input[j + 1] ?? '';
        j += 2;
      } else if (/[\s;|&()<>]/.test(ch)) {
        break;
      } else {
        delimiter += ch;
        j++;
      }
    }
    heredocs.push({ delimiter, strip, quoted: isQuoted });
    return j;
  };

  const consumeHeredocs = (start: number): number => {
    let j = start;
    for (const heredoc of heredocs.splice(0)) {
      const body: string[] = [];
      while (j < n) {
        const lineEnd = input.indexOf('\n', j);
        const line = input.slice(j, lineEnd === -1 ? n : lineEnd).replace(/\r$/, '');
        j = lineEnd === -1 ? n : lineEnd + 1;
        if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
        body.push(line);
      }
      if (!heredoc.quoted) substitutionsOf(body.join('\n'), 'sh');
    }
    return j;
  };

  const readHereString = (start: number): number => {
    const quote = input[start + 1] as string;
    const bodyStart = input.indexOf('\n', start) + 1;
    const close = input.indexOf(`\n${quote}@`, bodyStart - 1);
    const body = close === -1 ? input.slice(bodyStart) : input.slice(bodyStart, close);
    if (quote === '"') substitutionsOf(body, 'ps');
    append(body);
    quoted = true;
    return close === -1 ? n : close + 3;
  };

  while (i < n) {
    const c = input[i] as string;
    const next = input[i + 1];
    if (c === '\n') {
      endSegment();
      i++;
      if (heredocs.length > 0) i = consumeHeredocs(i);
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
    } else if (c === '#' && current === null) {
      const eol = input.indexOf('\n', i);
      i = eol === -1 ? n : eol;
    } else if (c === '\\' && !ps) {
      if (next === undefined) {
        append('\\');
        i++;
      } else if (next === '\n') {
        i += 2;
      } else if (next === '\r' && input[i + 2] === '\n') {
        i += 3;
      } else if (SH_ESCAPABLE.has(next) && !(/^[A-Za-z]:$/.test(current ?? '') && (next === ' ' || next === '\t'))) {
        append(next);
        quoted = true;
        i += 2;
      } else {
        append('\\');
        i++;
      }
    } else if (c === '`' && ps) {
      if (next === '\n') {
        i += 2;
      } else {
        append(next ?? '');
        quoted = true;
        i += 2;
      }
    } else if (c === "'") {
      quoted = true;
      append('');
      i = readSingle(i + 1);
    } else if (c === '"') {
      quoted = true;
      append('');
      i = readDouble(i + 1);
    } else if (c === '$' && next === '(') {
      const [content, end] = readParen(i + 2);
      nested.push(content);
      append(input.slice(i, end));
      i = end;
    } else if (c === '`') {
      const [content, end] = readBacktick(i + 1);
      nested.push(content);
      append(input.slice(i, end));
      i = end;
    } else if (c === '|' && input[i - 1] === '>' && current !== null) {
      append(c);
      i++;
    } else if (c === ';' || c === '|' || c === '(' || c === ')') {
      endSegment();
      i++;
    } else if (c === '&') {
      if (next === '>' || (current !== null && (input[i - 1] === '>' || input[i - 1] === '<'))) {
        append('&');
      } else if (ps && current === null && segment.length === 0 && next !== '&') {
        // PowerShell call operator, not a separator
      } else {
        endSegment();
      }
      i++;
    } else if (ps && (c === '{' || c === '}')) {
      const literal = c === '{' ? input[i - 1] === '$' || input[i - 1] === '@' : literalBraces > 0;
      if (literal) {
        literalBraces += c === '{' ? 1 : -1;
        append(c);
      } else {
        endSegment();
      }
      i++;
    } else if (!ps && c === '<' && next === '<' && input[i + 2] !== '<' && input[i - 1] !== '<') {
      flush();
      i = readHeredocDelimiter(i + 2);
    } else if (ps && c === '@' && current === null && (next === "'" || next === '"') && PROBE.test(input.slice(i + 2, i + 2 + 40))) {
      i = readHereString(i);
    } else {
      append(c);
      i++;
    }
  }
  endSegment();
  return { segments, nested };
}
