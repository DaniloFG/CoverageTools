import { ReportParseError } from './types';

export interface XmlHandler {
  open(name: string, attrs: Record<string, string>): void;
  text(t: string): void;
  close(name: string): void;
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);
/** Longest reference worth looking at (`&#x10FFFF;` is 10 characters before the `;`). */
const MAX_REFERENCE = 10;

/** Decodes the five named entities and numeric character references; unknown references stay as written. */
export function decodeEntities(s: string): string {
  let amp = s.indexOf('&');
  if (amp < 0) return s;
  let out = '';
  let from = 0;
  while (amp >= 0) {
    // Look for the ';' only within the longest possible reference, so runs of '&' stay linear.
    const limit = Math.min(s.length, amp + 2 + MAX_REFERENCE);
    let semi = amp + 1;
    while (semi < limit && s.charCodeAt(semi) !== 59 /* ; */) semi++;
    const ref = semi < limit ? s.slice(amp + 1, semi) : '';
    let decoded: string | undefined;
    if (ref.charCodeAt(0) === 35 /* # */) {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (code >= 0 && code <= 0x10ffff) decoded = String.fromCodePoint(code);
    } else {
      decoded = NAMED_ENTITIES.get(ref);
    }
    if (decoded !== undefined) {
      out += s.slice(from, amp) + decoded;
      from = semi + 1;
    }
    amp = s.indexOf('&', decoded !== undefined ? semi + 1 : amp + 1);
  }
  return out + s.slice(from);
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** Ends a name: whitespace, '/', '>' or '='. */
function isNameEnd(c: number): boolean {
  return isSpace(c) || c === 47 || c === 62 || c === 61;
}

function truncated(what: string): never {
  throw new ReportParseError(`Malformed or truncated XML: ${what}`);
}

/**
 * A minimal streaming XML scanner: reports element opens (with decoded attributes), text and closes.
 * Skips the prolog, processing instructions, comments and DOCTYPE; reports CDATA content as text.
 * Whitespace-only text is not reported. Throws ReportParseError on truncated or mismatched input.
 */
export function scanXml(xml: string, h: XmlHandler): void {
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: string[] = [];
  let sawRoot = false;

  const skipPast = (end: string, from: number, what: string): number => {
    const at = xml.indexOf(end, from);
    if (at < 0) truncated(what);
    return at + end.length;
  };

  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i && stack.length > 0) {
      let blank = true;
      for (let k = i; k < textEnd; k++) if (!isSpace(xml.charCodeAt(k))) { blank = false; break; }
      if (!blank) h.text(decodeEntities(xml.slice(i, textEnd)));
    }
    if (lt < 0) break;
    i = lt + 1;
    const c = xml.charCodeAt(i);

    if (c === 63 /* ? */) {
      i = skipPast('?>', i, 'processing instruction');
    } else if (c === 33 /* ! */) {
      if (xml.startsWith('!--', i)) {
        i = skipPast('-->', i + 3, 'comment');
      } else if (xml.startsWith('![CDATA[', i)) {
        const end = xml.indexOf(']]>', i + 8);
        if (end < 0) truncated('CDATA section');
        if (stack.length > 0 && end > i + 8) h.text(xml.slice(i + 8, end));
        i = end + 3;
      } else {
        i = skipDeclaration(xml, i);
      }
    } else if (c === 47 /* / */) {
      const gt = xml.indexOf('>', i);
      if (gt < 0) truncated('closing tag');
      const name = xml.slice(i + 1, gt).trim();
      const expected = stack.pop();
      if (name !== expected) throw new ReportParseError(`Malformed XML: </${name}> does not close <${expected ?? ''}>`);
      h.close(name);
      i = gt + 1;
    } else {
      i = scanOpenTag(xml, i, h, stack);
      sawRoot = true;
    }
  }
  if (stack.length > 0) truncated(`<${stack[stack.length - 1]}> is not closed`);
  if (!sawRoot) truncated('no root element');
}

/** Skips `<!DOCTYPE ...>` (and other `<!` declarations), including quoted strings and an internal subset. */
function skipDeclaration(xml: string, i: number): number {
  let bracket = 0;
  for (; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (c === 34 || c === 39) {
      const close = xml.indexOf(xml[i], i + 1);
      if (close < 0) break;
      i = close;
    } else if (c === 91 /* [ */) bracket++;
    else if (c === 93 /* ] */) bracket--;
    else if (c === 62 /* > */ && bracket <= 0) return i + 1;
  }
  return truncated('declaration');
}

/** Scans an opening tag starting at its name; returns the index after `>`. */
function scanOpenTag(xml: string, i: number, h: XmlHandler, stack: string[]): number {
  const n = xml.length;
  const start = i;
  while (i < n && !isNameEnd(xml.charCodeAt(i))) i++;
  if (i === start || i >= n) truncated('opening tag');
  const name = xml.slice(start, i);
  const attrs: Record<string, string> = {};
  for (;;) {
    while (i < n && isSpace(xml.charCodeAt(i))) i++;
    if (i >= n) truncated(`<${name}>`);
    const c = xml.charCodeAt(i);
    if (c === 62 /* > */) {
      h.open(name, attrs);
      stack.push(name);
      return i + 1;
    }
    if (c === 47 /* / */) {
      if (xml.charCodeAt(i + 1) !== 62) truncated(`<${name}>`);
      h.open(name, attrs);
      h.close(name);
      return i + 2;
    }
    const attrStart = i;
    while (i < n && !isNameEnd(xml.charCodeAt(i))) i++;
    const attr = xml.slice(attrStart, i);
    while (i < n && isSpace(xml.charCodeAt(i))) i++;
    if (attr === '' || xml.charCodeAt(i) !== 61 /* = */) truncated(`attribute in <${name}>`);
    i++;
    while (i < n && isSpace(xml.charCodeAt(i))) i++;
    const q = xml.charCodeAt(i);
    if (q !== 34 && q !== 39) truncated(`attribute value in <${name}>`);
    const end = xml.indexOf(q === 34 ? '"' : "'", i + 1);
    if (end < 0) truncated(`attribute value in <${name}>`);
    attrs[attr] = decodeEntities(xml.slice(i + 1, end));
    i = end + 1;
  }
}
