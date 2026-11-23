// mend v2: one command-line tool that applies the edits AI models write, in four
// formats, to a tree of text files. SPEC.md is the whole contract. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// Every edit changes every file or none. The tool reads a patch in one of four
// formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls),
// finds the lines each edit names at the first of three matching tiers (exact,
// then trailing-whitespace tolerant, then indentation tolerant), and prints what
// it changed or why it failed. Deterministic: the same check gives the same exit
// code, stdout and files every run.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An error that ends the run with exit 2 and one line on stdout. */
class ParseError {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: a code and the path it concerns. */
class EditFailure {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed per line, and the empty
 * piece after a final \n dropped. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 * and none of its /-separated segments is empty, . or ... */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** A file's line break: CRLF when its first line feed follows a carriage
 * return, LF otherwise (a file with no line feed at all reads as LF). */
function fileBreak(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

interface SplitFile {
  lines: string[];
  br: string;
  final: boolean;
}

/** Split a file's text into its lines, its line break, and whether it ends
 * with that break. An empty file has no lines and no final break. */
function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const br = fileBreak(text);
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

/** Join lines back with a file's break, ending with it exactly when `final`. */
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: paths changed so far in `now` (null means
 * deleted), everything else read from disk on demand. Moves are recorded so
 * the report can print one R line for a move instead of a D and an A line. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }

  set(p: string, text: string): void {
    this.now.set(p, text);
  }

  remove(p: string): void {
    this.now.set(p, null);
  }

  move(from: string, to: string, text: string): void {
    this.now.set(from, null);
    this.now.set(to, text);
    this.moves.push({ from, to });
  }
}

type Edit = (tree: Tree) => void;

/** One tier's key for a line: tier 0 exact, tier 1 trailing spaces/tabs
 * removed, tier 2 leading and trailing spaces/tabs removed. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All 0-based positions where `old` occurs in `file` at one tier. */
function occurrencesAt(file: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > file.length) return out;
  const fk = file.map((l) => tierKey(l, tier));
  const ok = old.map((l) => tierKey(l, tier));
  for (let i = 0; i + old.length <= file.length; i += 1) {
    if (fk[i] !== ok[0]) continue;
    let good = true;
    for (let j = 1; j < old.length; j += 1) {
      if (fk[i + j] !== ok[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2, or none) at which `old` occurs in `file`, with
 * its positions. With `strict` only tier 0 is tried. */
function findTier(
  file: string[],
  old: string[],
  strict: boolean,
): { tier: number; at: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const at = occurrencesAt(file, old, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The leading spaces and tabs of a line. */
function leadWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/**
 * Build the lines that replace a matched block.
 *
 * `n` holds the new lines in order; `isCtx[k]` says whether n[k] is a context
 * line (a line of both O and N) and, when it is, `ctxAt[k]` is its index into
 * O, so it is written as the file's own matched line at that position. The
 * other lines are the patch's own lines: at tier 2 they are re-indented from
 * O's first line's leading whitespace P to the file's first matched line's
 * leading whitespace F; at tiers 0 and 1 they are written as they are.
 */
function buildNew(
  file: string[],
  at: number,
  old: string[],
  n: string[],
  isCtx: boolean[],
  ctxAt: number[],
  tier: number,
): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && old.length > 0) {
    p = leadWs(old[0] as string);
    f = leadWs(file[at] as string);
  }
  for (let k = 0; k < n.length; k += 1) {
    if (isCtx[k] as boolean) {
      out.push(file[at + (ctxAt[k] as number)] as string);
      continue;
    }
    const line = n[k] as string;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) {
      out.push(f + line.slice(p.length));
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Replace file lines [at, at + old.length) with `replacement`, keeping the
 * file's final break as `final` says. */
function spliceLines(
  file: string[],
  at: number,
  oldLen: number,
  replacement: string[],
): string[] {
  return [...file.slice(0, at), ...replacement, ...file.slice(at + oldLen)];
}

/** Format detection (section 4): the first of v4a, json, search-replace,
 * unified that holds, or null. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafe(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const crlf = fileBreak(before) === '\r\n';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      if (!isSafe(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const { lines, br, final } = splitFile(before);
      if (line < 0 || line > lines.length) throw new EditFailure('no-match', p);
      lines.splice(line, 0, ...add);
      tree.set(p, joinFile(lines, br, final));
    };
  }

  return null;
}

/** Read a patch's JSON edits (section 9). */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseError(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseError(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseError(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk: its old start line A (1-based), its old lines O (context
 * plus `-` lines), its new lines N (context plus `+` lines), which N lines
 * are context lines and their index into O, and whether a `\` line follows
 * the hunk's last context or `+` line. */
interface Hunk {
  a: number;
  o: string[];
  n: string[];
  isCtx: boolean[];
  ctxAt: number[];
  noEol: boolean;
}

/** A unified section: its old and new path (null is /dev/null), whether it
 * creates or deletes, and its hunks. */
interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

type BodyItem =
  | { kind: 'ctx'; text: string }
  | { kind: 'old'; text: string }
  | { kind: 'new'; text: string }
  | { kind: 'noeol' };

/** The path a `---` or `+++` header line names: the text after the four
 * characters, up to the first tab, with surrounding spaces removed. */
function headerPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  return rest.trim();
}

/** A header path with /dev/null turned into null and a leading a/ or b/
 * removed. */
function cleanHeaderPath(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Read a hunk body starting at index `j`: the body items and the index just
 * past the body. Empty lines at the end of a body are not part of it. */
function readHunkBody(lines: string[], j: number): { items: BodyItem[]; next: number } {
  const items: BodyItem[] = [];
  let k = j;
  while (k < lines.length) {
    const l = lines[k] as string;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '' });
      k += 1;
      continue;
    }
    const c = l[0] as string;
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1) });
      k += 1;
      continue;
    }
    if (c === '-') {
      items.push({ kind: 'old', text: l.slice(1) });
      k += 1;
      continue;
    }
    if (c === '+') {
      items.push({ kind: 'new', text: l.slice(1) });
      k += 1;
      continue;
    }
    if (c === '\\') {
      items.push({ kind: 'noeol' });
      k += 1;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1] as BodyItem;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  return { items, next: k };
}

/** Build a hunk from its old start line and its body items. */
function buildHunk(a: number, items: BodyItem[]): Hunk {
  const o: string[] = [];
  const n: string[] = [];
  const isCtx: boolean[] = [];
  const ctxAt: number[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push(it.text);
      isCtx.push(true);
      ctxAt.push(o.length - 1);
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      n.push(it.text);
      isCtx.push(false);
      ctxAt.push(-1);
    }
  }
  let noEol = false;
  let lastCN = -1;
  for (let t = 0; t < items.length; t += 1) {
    if (items[t]?.kind === 'ctx' || items[t]?.kind === 'new') lastCN = t;
  }
  if (lastCN >= 0 && lastCN + 1 < items.length && items[lastCN + 1]?.kind === 'noeol') {
    noEol = true;
  }
  return { a, o, n, isCtx, ctxAt, noEol };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/**
 * Parse one unified section starting at index `start` (a `diff --git` line,
 * or a bare `---` line whose next line is `+++`). Returns the section and
 * the index just past it.
 */
function parseSection(
  lines: string[],
  start: number,
  diffOld: string | null,
  diffNew: string | null,
): { section: Section; next: number } {
  let oldPath = diffOld;
  let newPath = diffNew;
  let isCreate = false;
  let isDelete = false;
  let sawPair = false;
  let j = start;
  if (diffOld === null && diffNew === null) {
    // A bare section: its first two lines are the ---/+++ pair.
    oldPath = cleanHeaderPath(headerPath(lines[j] as string));
    newPath = cleanHeaderPath(headerPath(lines[j + 1] as string));
    sawPair = true;
    j += 2;
  } else {
    // A diff --git section: skip its own line, or the header loop below
    // would stop on it at once and the section would never advance.
    j += 1;
  }
  // The header, before the first hunk.
  while (j < lines.length) {
    const l = lines[j] as string;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[j + 1] ?? '').startsWith('+++ ')) {
        oldPath = cleanHeaderPath(headerPath(l));
        newPath = cleanHeaderPath(headerPath(lines[j + 1] as string));
        sawPair = true;
        j += 2;
        continue;
      }
      throw new ParseError(`error: parse ${j + 2}`);
    }
    if (l.startsWith('rename from ')) {
      if (!sawPair) oldPath = l.slice('rename from '.length).trim();
      j += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!sawPair) newPath = l.slice('rename to '.length).trim();
      j += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      isCreate = true;
      j += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      isDelete = true;
      j += 1;
      continue;
    }
    j += 1;
  }
  // The hunks.
  const hunks: Hunk[] = [];
  while (j < lines.length) {
    const l = lines[j] as string;
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new ParseError(`error: parse ${j + 1}`);
      const a = parseInt(m[1] as string, 10);
      j += 1;
      const body = readHunkBody(lines, j);
      hunks.push(buildHunk(a, body.items));
      j = body.next;
      continue;
    }
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    j += 1;
  }
  return { section: { oldPath, newPath, isCreate, isDelete, hunks }, next: j };
}

/** Read a patch's unified sections (section 6). */
function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i] as string;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new ParseError(`error: parse ${i + 1}`);
      const r = parseSection(lines, i, m[1] as string, m[2] as string);
      sections.push(r.section);
      i = r.next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const r = parseSection(lines, i, null, null);
      sections.push(r.section);
      i = r.next;
      continue;
    }
    if (l.startsWith('@@')) throw new ParseError(`error: parse ${i + 1}`);
    i += 1;
  }
  return sections;
}

/**
 * Apply a section's hunks to a file's lines, in order, each to the result of
 * the ones before it. Returns the new lines and whether the result ends with
 * a line break. Throws EditFailure on a hunk that does not match.
 */
function applyHunks(
  lines: string[],
  hunks: Hunk[],
  strict: boolean,
  final: boolean,
  path: string,
): { lines: string[]; final: boolean } {
  let cur = [...lines];
  let curFinal = final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const idx = Math.min(h.a + d, cur.length);
      const atEnd = idx === cur.length;
      cur = [...cur.slice(0, idx), ...h.n, ...cur.slice(idx)];
      if (atEnd && h.n.length > 0) curFinal = !h.noEol;
      d += h.n.length;
      continue;
    }
    const found = findTier(cur, h.o, strict);
    if (found === null) throw new EditFailure('no-match', path);
    const target = h.a - 1 + d;
    let best = found.at[0] as number;
    let bestDist = Math.abs(best - target);
    for (const pos of found.at) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const replacement = buildNew(cur, best, h.o, h.n, h.isCtx, h.ctxAt, found.tier);
    const runsToEnd = best + h.o.length === cur.length;
    cur = spliceLines(cur, best, h.o.length, replacement);
    if (runsToEnd) curFinal = !h.noEol;
    d += h.n.length - h.o.length;
  }
  return { lines: cur, final: curFinal };
}

/** One unified section as an edit (section 6). */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      if (newP === null) return;
      if (!isSafe(newP)) throw new EditFailure('unsafe', newP);
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.n.length; k += 1) {
          if (!(h.isCtx[k] as boolean)) plus.push(h.n[k] as string);
        }
      }
      for (let s = sec.hunks.length - 1; s >= 0; s -= 1) {
        const h = sec.hunks[s] as Hunk;
        if (h.n.some((_, k) => !(h.isCtx[k] as boolean))) {
          noEol = h.noEol;
          break;
        }
      }
      tree.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (!isSafe(oldP)) throw new EditFailure('unsafe', oldP);
      if (tree.get(oldP) === null) throw new EditFailure('missing', oldP);
      tree.remove(oldP);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!isSafe(oldP)) throw new EditFailure('unsafe', oldP);
      if (!isSafe(newP)) throw new EditFailure('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new EditFailure('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const { lines, br, final } = splitFile(before);
      const out = applyHunks(lines, sec.hunks, strict, final, oldP);
      tree.move(oldP, newP, joinFile(out.lines, br, out.final));
      return;
    }
    const p = (oldP ?? newP) as string;
    if (!isSafe(p)) throw new EditFailure('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new EditFailure('missing', p);
    const { lines, br, final } = splitFile(before);
    const out = applyHunks(lines, sec.hunks, strict, final, p);
    tree.set(p, joinFile(out.lines, br, out.final));
  };
}

/** Read a patch's unified edits (section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((s) => unifiedEdit(s, strict));
}

/** Read a patch's SEARCH/REPLACE edits (section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i] as string;
    if (l.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // The path: the nearest line before SEARCH, after the previous block's
    // end, that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k -= 1) {
      const cand = lines[k] as string;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseError(`error: parse ${searchLine}`);
    // Find ======= after SEARCH, stopping at another SEARCH line or at a
    // >>>>>>> REPLACE line: a block whose >>>>>>> comes before its =======
    // is a parse error (section 7: a SEARCH line with no ======= and then
    // >>>>>>> REPLACE after it).
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if ((lines[k] as string).trimEnd() === '<<<<<<< SEARCH') break;
      if ((lines[k] as string).trimEnd() === '>>>>>>> REPLACE') break;
      if ((lines[k] as string).trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new ParseError(`error: parse ${searchLine}`);
    // Find >>>>>>> REPLACE after =======, stopping at another SEARCH line.
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if ((lines[k] as string).trimEnd() === '<<<<<<< SEARCH') break;
      if ((lines[k] as string).trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseError(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!isSafe(p)) throw new EditFailure('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new EditFailure('exists', p);
        tree.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const { lines: file, br, final } = splitFile(before);
      const found = findTier(file, oldLines, strict);
      if (found === null) throw new EditFailure('no-match', p);
      if (found.at.length > 1) throw new EditFailure('ambiguous', p);
      const at = found.at[0] as number;
      const replacement = buildNew(file, at, oldLines, newLines, newLines.map(() => false), [], found.tier);
      tree.set(p, joinFile(spliceLines(file, at, oldLines.length, replacement), br, final));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null is none), its old and new lines, which
 * new lines are context lines and their index into O, and whether it is an
 * end-of-file chunk. */
interface VChunk {
  anchor: string | null;
  o: string[];
  n: string[];
  isCtx: boolean[];
  ctxAt: number[];
  eof: boolean;
}

/** One V4A section: its kind, its path, its move target, its lines (Add
 * File) or its chunks (Update File). */
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
}

/** Build a V4A chunk from its anchor, its body items and its end-of-file
 * flag. Body items are lines starting with ' ', '-' or '+', or empty. */
function buildVChunk(anchor: string | null, body: string[], eof: boolean): VChunk {
  const o: string[] = [];
  const n: string[] = [];
  const isCtx: boolean[] = [];
  const ctxAt: number[] = [];
  for (const l of body) {
    if (l === '') {
      o.push('');
      n.push('');
      isCtx.push(true);
      ctxAt.push(o.length - 1);
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push(t);
      isCtx.push(true);
      ctxAt.push(o.length - 1);
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push(l.slice(1));
      isCtx.push(false);
      ctxAt.push(-1);
    }
  }
  return { anchor, o, n, isCtx, ctxAt, eof };
}

/** Read a patch's V4A edits (section 8). With --strict only tier 0 is tried
 * for anchors and chunk matches (section 5). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') {
    throw new ParseError(`error: parse ${first + 1}`);
  }
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if (last < 0 || (lines[last] as string).trim() !== '*** End Patch') {
    throw new ParseError(`error: parse ${lines.length + 1}`);
  }

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i] as string;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const body: string[] = [];
      i += 1;
      while (i < last) {
        const b = lines[i] as string;
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ') || b.trim() === '*** End Patch') break;
        if (b === '' || b.startsWith('+')) {
          body.push(b === '' ? '' : b.slice(1));
          i += 1;
          continue;
        }
        throw new ParseError(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sections.push({ kind: 'add', path, moveTo: null, lines: body, chunks: [] });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [] });
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && (lines[i] as string).startsWith('*** Move to: ')) {
        moveTo = (lines[i] as string).slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let chunkAnchor: string | null = null;
      let chunkBody: string[] = [];
      let chunkEof = false;
      let inChunk = false;
      // Section 8: a chunk starts at an @@ line or, for the first chunk,
      // at a body line. Once a chunk has been seen, a later body line
      // cannot start another chunk.
      let seenChunk = false;
      const flush = (): void => {
        if (!inChunk) return;
        chunks.push(buildVChunk(chunkAnchor, chunkBody, chunkEof));
        inChunk = false;
        chunkBody = [];
        chunkEof = false;
      };
      while (i < last) {
        const b = lines[i] as string;
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ') || b.trim() === '*** End Patch') break;
        if (b.startsWith('@@')) {
          flush();
          const anchor = b.slice(2).trim();
          chunkAnchor = anchor === '' ? null : anchor;
          chunkBody = [];
          chunkEof = false;
          inChunk = true;
          seenChunk = true;
          i += 1;
          continue;
        }
        if (b.trim() === '*** End of File') {
          if (!inChunk) throw new ParseError(`error: parse ${i + 1}`);
          chunkEof = true;
          flush();
          i += 1;
          continue;
        }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (!inChunk) {
            // A blank line after a chunk has ended is a trailing blank of
            // the section, not a new chunk (section 8).
            if (seenChunk && b === '') {
              i += 1;
              continue;
            }
            // A non-empty body line may only start the first chunk.
            if (seenChunk) throw new ParseError(`error: parse ${i + 1}`);
            chunkAnchor = null;
            chunkBody = [];
            chunkEof = false;
            inChunk = true;
            seenChunk = true;
          }
          chunkBody.push(b);
          i += 1;
          continue;
        }
        throw new ParseError(`error: parse ${i + 1}`);
      }
      flush();
      // Blank lines at the end of a section are not part of it.
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1] as VChunk;
        while (lastChunk.o.length > 0 && lastChunk.o[lastChunk.o.length - 1] === '' && lastChunk.n.length > 0 && lastChunk.n[lastChunk.n.length - 1] === '') {
          lastChunk.o.pop();
          lastChunk.n.pop();
          lastChunk.isCtx.pop();
          lastChunk.ctxAt.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) {
        throw new ParseError(`error: parse ${updateLine}`);
      }
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks });
      continue;
    }
    throw new ParseError(`error: parse ${i + 1}`);
  }

  return sections.map((sec) => {
    if (sec.kind === 'add') {
      return (tree: Tree): void => {
        if (!isSafe(sec.path)) throw new EditFailure('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new EditFailure('exists', sec.path);
        tree.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree): void => {
        if (!isSafe(sec.path)) throw new EditFailure('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new EditFailure('missing', sec.path);
        tree.remove(sec.path);
      };
    }
    return (tree: Tree): void => {
      if (!isSafe(sec.path)) throw new EditFailure('unsafe', sec.path);
      if (sec.moveTo !== null && !isSafe(sec.moveTo)) throw new EditFailure('unsafe', sec.moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new EditFailure('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new EditFailure('exists', sec.moveTo);
      const { lines, br, final } = splitFile(before);
      let cur = [...lines];
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          // Find the first line at or after the cursor equal to the anchor,
          // at the first tier where one is. With --strict only tier 0.
          let foundAt = -1;
          const maxTier = strict ? 0 : 2;
          for (let tier = 0; tier <= maxTier; tier += 1) {
            const key = tierKey(ch.anchor, tier);
            for (let k = cursor; k < cur.length; k += 1) {
              if (tierKey(cur[k] as string, tier) === key) {
                foundAt = k;
                break;
              }
            }
            if (foundAt >= 0) break;
          }
          if (foundAt < 0) throw new EditFailure('no-match', sec.path);
          cursor = foundAt + 1;
        }
        if (ch.o.length === 0) {
          const idx = ch.eof ? cur.length : cursor;
          cur = [...cur.slice(0, idx), ...ch.n, ...cur.slice(idx)];
          cursor = idx + ch.n.length;
          continue;
        }
        // Find O's first occurrence at or after the cursor, at the first
        // tier with one; an end-of-file chunk takes only one that ends at
        // the file's last line. With --strict only tier 0 is tried.
        let pick: { tier: number; at: number } | null = null;
        const maxTier = strict ? 0 : 2;
        for (let tier = 0; tier <= maxTier; tier += 1) {
          const at = occurrencesAt(cur, ch.o, tier).filter((pos) => pos >= cursor);
          if (ch.eof) {
            const end = at.filter((pos) => pos + ch.o.length === cur.length);
            if (end.length > 0) {
              pick = { tier, at: end[0] as number };
              break;
            }
          } else if (at.length > 0) {
            pick = { tier, at: at[0] as number };
            break;
          }
        }
        if (pick === null) throw new EditFailure('no-match', sec.path);
        const replacement = buildNew(cur, pick.at, ch.o, ch.n, ch.isCtx, ch.ctxAt, pick.tier);
        cur = spliceLines(cur, pick.at, ch.o.length, replacement);
        cursor = pick.at + replacement.length;
      }
      const out = joinFile(cur, br, final);
      if (sec.moveTo !== null) tree.move(sec.path, sec.moveTo, out);
      else tree.set(sec.path, out);
    };
  });
}

/** Byte order of two paths, as UTF-8. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Run the CLI once over `args`. Returns the exit code and the stdout lines. */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string);
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new ParseError('error: parse 1');
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }

  // The changed paths, with moves folded into one R line each.
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const rLines: Array<{ key: string; line: string }> = [];
  for (const m of tree.moves) {
    const fromC = changed.get(m.from);
    const toC = changed.get(m.to);
    if (
      fromC !== undefined &&
      fromC.was !== null &&
      fromC.now === null &&
      toC !== undefined &&
      toC.was === null &&
      toC.now !== null
    ) {
      changed.delete(m.from);
      changed.delete(m.to);
      rLines.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
    }
  }
  const rows: Array<{ key: string; line: string }> = [...rLines];
  for (const [p, c] of changed) {
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));

  if (!check) {
    const toDelete: string[] = [];
    const toWrite: string[] = [];
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p) as string | null;
      if (was === now) continue;
      if (now === null) toDelete.push(p);
      else toWrite.push(p);
    }
    for (const p of toDelete) rmSync(p, { force: true });
    for (const p of toWrite) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, tree.now.get(p) as string);
    }
  }
  return {
    code: 0,
    out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
