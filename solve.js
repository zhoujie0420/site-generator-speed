// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the answer makefun-site 1.0.0's build returns for one site:
// the output tree as a JSON object of every path it writes and that file's text, byte for byte.
// Written from the dialect's stated rules (front matter, template dialect, Markdown subset, slug
// rule, report) and the reference's observable behaviour. Nothing here is copied from the
// reference's code, from a baseline, or from a public generator: every function below is my own.
//
// Where the speed comes from: the reference renders inline Markdown one character at a time,
// calling a regex escape per character, and counts a body's words with a regex match that builds
// an array of every word. This file instead scans inline text for its next special character and
// escapes the plain runs between them in one regex pass, counts words with a regex exec loop that
// allocates nothing, and fuses Markdown lexing and rendering into a single pass over the lines.
// Templates are parsed once into the same node tree the dialect defines and rendered by a small
// interpreter that reuses its loop scopes instead of allocating one per item.

// --------------------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  let out = '';
  let last = 0;
  ESC_RE.lastIndex = 0;
  let m;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESC[m[0]];
    last = m.index + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const NON_ASCII = /[^\x00-\x7F]/;
const MARK_RE = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other
 * than a-z and 0-9 one "-", none at either end, at most SLUG_MAX characters (a "-" left at the cut
 * dropped), and "untitled" when nothing is left. Pure ASCII text takes a fast path that skips the
 * normalisation and the mark strip entirely (both are the identity on ASCII).
 */
function slugify(text) {
  if (!NON_ASCII.test(text)) {
    let out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    out = out.slice(0, SLUG_MAX);
    if (out.charCodeAt(out.length - 1) === 45) out = out.replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  do {
    out = `${slug}-${n++}`;
  } while (taken.has(out));
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether `c` (a code unit) is whitespace in the regex sense (\s). */
function isWsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 ||
    c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 ||
    c === 12288 || c === 65279;
}

/** Whether `l` continues a list item: two or more spaces, then a non-space character. */
function isContinued(l) {
  let s = 0;
  while (s < l.length && l.charCodeAt(s) === 32) s++;
  return s >= 2 && s < l.length && !isWsCode(l.charCodeAt(s));
}

const WS8 = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS8[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 ? WS8[c] === 1 : isWsCode(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `s` with spaces and tabs at its end dropped. */
function stripTrailing(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return e === s.length ? s : s.slice(0, e);
}

// --------------------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether every character of `s` is a-z, 0-9 or `-`. */
function isName(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug (a-z and 0-9, single `-` between), at most 64 characters. */
function isSlug(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      let y = 0;
      let mo = 0;
      let d = 0;
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
        if (i < 4) y = y * 10 + (c - 48);
        else if (i < 7) mo = mo * 10 + (c - 48);
        else d = d * 10 + (c - 48);
      }
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. Only the front matter itself is split into lines; the body is sliced
 * out whole, since the Markdown pass splits it again anyway.
 */
export function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  let closeDash = -1;
  let pos = firstNl === -1 ? text.length : firstNl;
  while (true) {
    const at = text.indexOf('\n---', pos);
    if (at === -1) break;
    const after = at + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeDash = at + 1;
      break;
    }
    pos = at + 1;
  }
  if (closeDash === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const fm = firstNl === -1 ? '' : text.slice(firstNl + 1, closeDash - 1);
  const lines = fm === '' ? [] : fm.split('\n');
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (line === '' || isBlank(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon < 1) return { error: `line ${j + 2} is not "key: value"` };
    let ok = true;
    for (let k = 0; k < colon; k++) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) {
        ok = false;
        break;
      }
    }
    if (!ok) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, colon);
    let raw;
    if (colon + 1 === line.length) raw = '';
    else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    raw = stripTrailing(raw);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const afterClose = closeDash + 3;
  const body = afterClose === text.length ? '' : text.slice(afterClose + 1);
  return { data, body };
}

// --------------------------------------------------------------------------- markdown

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  let lang = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) {
      lang += line[i];
      i++;
    } else break;
  }
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let i = n;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i >= line.length) return null;
  let e = line.length;
  while (e > i && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return { depth: n, text: line.slice(i, e) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line === '---' || line === '***') return true;
  if (line.startsWith('---') || line.startsWith('***')) {
    for (let i = 3; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  return false;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
  if (c0 === -1 || c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** An ordered list's start number, or null when `line` does not open one. */
function orderedStart(line) {
  let d = 0;
  while (d < 9 && d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d >= 1 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) return Number(line.slice(0, d));
  return null;
}

/** The characters a backslash escapes. */
function isEscapableCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 ||
    c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;
const SPECIAL_RE = /[\\`*\[]/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
export function inline(s, env) {
  let out = '';
  const n = s.length;
  let chunk = 0;
  SPECIAL_RE.lastIndex = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && isEscapableCode(s.charCodeAt(j + 1))) {
        if (j > chunk) out += escapeHtml(s.slice(chunk, j));
        const next = s[j + 1];
        out += ESC[next] ?? next;
        chunk = j + 2;
        SPECIAL_RE.lastIndex = chunk;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > chunk) out += escapeHtml(s.slice(chunk, j));
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        chunk = k + 1;
        SPECIAL_RE.lastIndex = chunk;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > chunk) out += escapeHtml(s.slice(chunk, j));
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          chunk = k + 2;
          SPECIAL_RE.lastIndex = chunk;
        } else SPECIAL_RE.lastIndex = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > chunk) out += escapeHtml(s.slice(chunk, j));
        out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        chunk = k + 1;
        SPECIAL_RE.lastIndex = chunk;
      }
      continue;
    }
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !WS_RE.test(target)) {
      if (j > chunk) out += escapeHtml(s.slice(chunk, j));
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
      chunk = mm + 1;
      SPECIAL_RE.lastIndex = chunk;
    }
  }
  if (n > chunk) out += escapeHtml(s.slice(chunk, n));
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        const code = body.length === 0 ? '' : escapeHtml(`${body.join('\n')}\n`);
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          if (l.startsWith('- ') || l.startsWith('* ')) {
            items.push([trimLine(l.slice(2))]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        let inner = '';
        for (const parts of items) inner += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        blocks.push(`<ul>\n${inner}</ul>`);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(l);
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const start = orderedStart(line);
      if (start !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const s = orderedStart(l);
          if (s !== null) {
            let d = 0;
            while (d < 9 && d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
            items.push([trimLine(l.slice(d + 2))]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let inner = '';
        for (const parts of items) inner += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        blocks.push(`${open}\n${inner}</ol>`);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// --------------------------------------------------------------------------- template compiler
//
// A template compiles to a function ($S, $D, $T) -> string, generated once per template source
// and cached. $S is the scope: a null-prototype object whose prototype chain is the enclosing
// scopes (the root scope holds site, tags, recent and the render's values). A for loop's element
// and loop record are plain locals in the generated code — the compiler resolves each path's first
// name to its binding at compile time (innermost loop first, else the scope object) — so rendering
// a page is straight-line code with native ifs and fors, no tree walk and no node dispatch.
// Includes call the included template's compiled function with the same scope and depth + 1.
// All generated names start with $, which a template path can never hold, so nothing collides.

/** A value's own property, or undefined: `lk(v, 'k')` is the `k` step of a path. */
function lk(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/** The generated expression for the value at `path` in the compile context `ctx`. */
function valueExpr(path, ctx) {
  let e;
  for (let i = ctx.bindings.length - 1; i >= 0; i--) {
    if (ctx.bindings[i].name === path[0]) {
      e = ctx.bindings[i].local;
      break;
    }
  }
  if (e === undefined) e = `${ctx.scopeVar}.${path[0]}`;
  for (let k = 1; k < path.length; k++) e = `lk(${e},${JSON.stringify(path[k])})`;
  return e;
}

/** `nodes` compiled to JavaScript source in the compile context `ctx`. */
function compileNodes(nodes, ctx) {
  let src = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      src += `out+=${JSON.stringify(n.text)};`;
    } else if (n.kind === 'var' || n.kind === 'raw') {
      const id = ctx.uid++;
      const e = valueExpr(n.path, ctx);
      src += `const $t${id}=${e};`;
      src += n.kind === 'var'
        ? `out+=esc(typeof $t${id}==='string'?$t${id}:txt($t${id}));`
        : `out+=typeof $t${id}==='string'?$t${id}:txt($t${id});`;
    } else if (n.kind === 'if') {
      src += `if(tru(${valueExpr(n.path, ctx)})!==${n.not}){${compileNodes(n.then, ctx)}}`;
      if (n.else !== null) src += `else{${compileNodes(n.else, ctx)}}`;
    } else if (n.kind === 'for') {
      const id = ctx.uid++;
      const xs = `$x${id}`;
      const v = `$v${id}`;
      const l = `$l${id}`;
      const s = `$s${id}`;
      const k = `$k${id}`;
      const inner = {
        scopeVar: s,
        bindings: [...ctx.bindings, { name: n.name, local: v }, { name: 'loop', local: l }],
        uid: ctx.uid,
      };
      src += `const ${xs}=${valueExpr(n.path, ctx)};`;
      src += `if(Array.isArray(${xs})){const ${s}=Object.create(${ctx.scopeVar});`;
      src += `const ${l}={index:1,first:true,last:${xs}.length===1,length:${xs}.length};${s}.loop=${l};`;
      src += `for(let ${k}=0;${k}<${xs}.length;${k}++){const ${v}=${xs}[${k}];${s}.${n.name}=${v};`;
      src += `${l}.index=${k}+1;${l}.first=${k}===0;${l}.last=${k}===${xs}.length-1;`;
      src += `${compileNodes(n.body, inner)}}}`;
      ctx.uid = inner.uid;
    } else if (n.kind === 'include') {
      const id = ctx.uid++;
      src += `{const $f${id}=$T.get(${JSON.stringify(n.name)});if($f${id}!==undefined&&$D<${INCLUDE_DEPTH})out+=$f${id}(${ctx.scopeVar},$D+1,$T);}`;
    }
  }
  return src;
}

/** `nodes` compiled to a render function ($S, $D, $T) -> string. */
export function compileTemplate(nodes) {
  const ctx = { scopeVar: '$S', bindings: [], uid: 0 };
  const body = `let out='';${compileNodes(nodes, ctx)}return out;`;
  const maker = new Function('esc', 'txt', 'tru', 'lk', `return function($S,$D,$T){${body}}`);
  return maker(escapeHtml, textOf, truthy, lk);
}

// --------------------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const src = input.templates[name];
      templates.set(name, compileTemplate(parseTemplate(name, src)));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();
  const slug = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugify(text);
      slugCache.set(text, s);
    }
    return s;
  };
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  const output = {};
  const cards = new Map();
  const cardOf = (s) => {
    let c = cards.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cards.set(s, c);
    }
    return c;
  };
  for (const p of posts) cardOf(p);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const indexFn = templates.get('index');
  const tagFn = templates.get('tag');
  const tagsFn = templates.get('tags');
  const pageScope = Object.assign(Object.create(null), { site, tags: allTags, recent, page: null });
  const indexScope = Object.assign(Object.create(null), { site, tags: allTags, recent, posts: null, pager: null });
  const tagScope = Object.assign(Object.create(null), { site, tags: allTags, recent, tag: null });
  const tagsScope = Object.assign(Object.create(null), { site, tags: allTags, recent });
  const renderInto = (fn, scope) => (fn === undefined ? null : fn(scope, 0, templates));
  for (const s of kept) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    pageScope.page = page;
    output[`${s.outDir}/index.html`] = renderInto(templates.get(s.layout), pageScope);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    indexScope.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    indexScope.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = renderInto(indexFn, indexScope);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    tagScope.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = renderInto(tagFn, tagScope);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderInto(tagsFn, tagsScope);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}

