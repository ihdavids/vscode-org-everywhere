// Which text in an org file is prose, as paragraphs that remember where each
// character came from, and what Harper's answers mean. Pure (no vscode), a
// port of worg's writing.ts (proseSpans, paragraphAt, proseOf), the line
// tokens it reads (components/OrgSource.tsx) and harper.ts; tested by
// test/prose.test.ts. The rules themselves are prose-rules-model.ts.
//
// - Prose is body text, heading titles, emphasis and a link's description.
//   Not verbatim or code, link targets, timestamps, tags, keywords, drawers,
//   properties, planning lines, comments (so revision notes), tables, or
//   anything in a source, example or export block.
// - A paragraph is a run of non-blank lines; a heading and a list item are
//   paragraphs of their own. Its prose is one text: lines joined with a
//   newline, and org between two pieces of a line (a timestamp, a link's
//   target) as one OBJ character, so a rule can read across a wrapped line.

export type TodoStates = { active: Set<string>; done: Set<string> };

const DEFAULT_TODO_STATES = 'TODO INPROGRESS IN-PROGRESS NEXT BLOCKED PAUSED WAITING PHONE MEETING BACKLOG | DONE CANCELLED';

function parseTodoStates(spec: string): { active: string[]; done: string[] } {
    const words = spec.split(/\s+/).map(w => w.replace(/\([^)]*\)$/, '')).filter(w => w !== '');
    const bar = words.indexOf('|');
    if (bar >= 0) { return { active: words.slice(0, bar), done: words.slice(bar + 1) }; }
    if (words.length === 0) { return { active: [], done: [] }; }
    return { active: words.slice(0, -1), done: words.slice(-1) };
}

// The keywords a file uses: the server's defaults, the user's own, and any
// #+TODO lines in it. Only needed to keep a keyword out of a heading's prose.
export function todoStates(text: string, extraActive: string[] = [], extraDone: string[] = []): TodoStates {
    const active = new Set<string>();
    const done = new Set<string>();
    const add = (spec: string) => {
        const p = parseTodoStates(spec);
        p.active.forEach(w => active.add(w));
        p.done.forEach(w => done.add(w));
    };
    add(DEFAULT_TODO_STATES);
    extraActive.filter(Boolean).forEach(w => active.add(w));
    extraDone.filter(Boolean).forEach(w => done.add(w));
    const re = /^#\+(?:TODO|SEQ_TODO|TYP_TODO):(.*)$/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) { add(m[1]); }
    done.forEach(w => active.delete(w));
    return { active, done };
}

// ---------------------------------------------------------------------------
// Line tokens: enough of worg's highlighter to tell prose from org
// ---------------------------------------------------------------------------

type Tok = { c: string; s: string };

function push(out: Tok[], c: string, s: string) {
    if (s !== '') { out.push({ c, s }); }
}

const TS = /([[<])(\d{4}-\d{2}-\d{2})([^\]>\n]*)([\]>])(--)?/;
const LINK = /\[\[([^\]]*?)\](?:\[([^\]]*?)\])?\]/;
const EMPH = /(^|[\s(['"{-])([*/_+=~])([^\s](?:[^\n]*?[^\s])?)\2(?=$|[\s.,:;!?')\]}"-])/;
const EMPH_CLASS: Record<string, string> = { '*': 'bold', '/': 'italic', '_': 'underline', '+': 'strike', '=': 'verbatim', '~': 'code' };
const FOOTNOTE = /\[fn:[^\]\s]*/;

function inline(text: string, base: string, out: Tok[]) {
    let rest = text;
    let guard = 0;
    while (rest !== '' && guard++ < 4000) {
        const found: [RegExpExecArray | null, string][] = [[LINK.exec(rest), 'link'], [TS.exec(rest), 'ts'], [EMPH.exec(rest), 'emph'], [FOOTNOTE.exec(rest), 'fn']];
        let best: [RegExpExecArray, string] | null = null;
        for (const [m, kind] of found) {
            if (m && (!best || m.index < best[0].index)) { best = [m, kind]; }
        }
        if (!best) { break; }
        const [m, kind] = best;
        push(out, base, rest.slice(0, m.index));
        if (kind === 'link') {
            push(out, 'linkPunct', '[[');
            push(out, 'linkTarget', m[1]);
            if (m[2] !== undefined) {
                push(out, 'linkPunct', '][');
                push(out, 'linkDesc', m[2]);
            }
            push(out, 'linkPunct', ']]');
        } else if (kind === 'ts') {
            push(out, 'ts', m[0]);
        } else if (kind === 'fn') {
            push(out, 'footnote', m[0]);
        } else {
            push(out, base, m[1]);
            push(out, 'markup', m[2]);
            push(out, EMPH_CLASS[m[2]], m[3]);
            push(out, 'markup', m[2]);
        }
        rest = rest.slice(m.index + m[0].length);
    }
    push(out, base, rest);
}

export const HEADING = /^(\*+)(\s+)(.*)$/;
const KEYWORD = /^(\s*)(#\+[A-Za-z0-9_@-]+:?)(.*)$/;
const BLOCK_BEGIN = /^(\s*)(#\+(?:BEGIN|begin)_([A-Za-z0-9_-]+))(.*)$/;
const BLOCK_END = /^(\s*)(#\+(?:END|end)_([A-Za-z0-9_-]+))\s*$/;
const DRAWER_OPEN = /^(\s*)(:[A-Za-z0-9_@#%-]+:)\s*$/;
const DRAWER_END = /^(\s*):(?:END|end):\s*$/;
const PLANNING = /^(\s*)((?:SCHEDULED|DEADLINE|CLOSED|CLOCK):)(.*)$/;
const LIST = /^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/;
const CHECKBOX = /^(\[[ xX-]\])(\s*)/;
const TABLE = /^\s*\|/;
const HRULE = /^\s*-{5,}\s*$/;
const COMMENT = /^(\s*)(#(?:\s.*|)?)$/;
const TAGS = /\s+(:(?:[^\s:]+:)+)$/;
const PRIORITY = /^(\[#[A-Za-z0-9]\])(\s*)/;
// Blocks whose body is not org.
const OPAQUE_BLOCKS = new Set(['src', 'example', 'export', 'verse', 'ascii', 'comment']);

// The block and drawer each line is read in.
export type LineState = { block: string; drawer: boolean };

export function walk(lines: string[]): LineState[] {
    const states: LineState[] = [];
    let block = '';
    let drawer = false;
    for (const line of lines) {
        states.push({ block, drawer });
        if (block !== '') {
            const end = BLOCK_END.exec(line);
            if (end !== null && end[3].toLowerCase() === block) { block = ''; }
            continue;
        }
        const begin = BLOCK_BEGIN.exec(line);
        if (begin !== null) { block = begin[3].toLowerCase(); continue; }
        if (drawer) {
            if (DRAWER_END.test(line) || HEADING.test(line)) { drawer = false; }
            continue;
        }
        if (DRAWER_OPEN.test(line) && !DRAWER_END.test(line)) { drawer = true; }
    }
    return states;
}

function lineTokens(line: string, todo: TodoStates, st: LineState): Tok[] {
    const out: Tok[] = [];
    if (st.block !== '' && OPAQUE_BLOCKS.has(st.block)) {
        push(out, 'blockBody', line);
        return out;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
        const level = heading[1].length;
        push(out, 'stars', heading[1]);
        push(out, 'fg', heading[2]);
        let title = heading[3];
        let tagPart = '';
        const tags = TAGS.exec(title);
        if (tags !== null) {
            tagPart = title.slice(tags.index);
            title = title.slice(0, tags.index);
        }
        const first = /^([A-Za-z][A-Za-z0-9_@-]*)(\s+|$)/.exec(title);
        if (first !== null && (todo.active.has(first[1]) || todo.done.has(first[1]))) {
            push(out, 'todo', first[1]);
            push(out, 'fg', first[2]);
            title = title.slice(first[0].length);
        }
        if (title.startsWith('COMMENT ')) {
            push(out, 'comment', 'COMMENT ');
            title = title.slice('COMMENT '.length);
        }
        const prio = PRIORITY.exec(title);
        if (prio !== null) {
            push(out, 'priority', prio[1]);
            push(out, 'fg', prio[2]);
            title = title.slice(prio[0].length);
        }
        inline(title, 'h' + (((level - 1) % 6) + 1), out);
        push(out, 'tag', tagPart);
        return out;
    }
    if (DRAWER_END.test(line) || DRAWER_OPEN.test(line) || st.drawer) {
        push(out, 'drawer', line);
        return out;
    }
    if (PLANNING.test(line) || BLOCK_BEGIN.test(line) || BLOCK_END.test(line) || COMMENT.test(line)
        || KEYWORD.test(line) || HRULE.test(line) || TABLE.test(line)) {
        // Bookkeeping, or a table: worg reads a table's cells, but a cell is
        // seldom a sentence and the rules mostly complain about it.
        push(out, 'org', line);
        return out;
    }
    const list = LIST.exec(line);
    if (list !== null) {
        push(out, 'fg', list[1]);
        push(out, 'bullet', list[2]);
        push(out, 'fg', list[3]);
        let body = list[4];
        const box = CHECKBOX.exec(body);
        if (box !== null) {
            push(out, 'check', box[1]);
            push(out, 'fg', box[2]);
            body = body.slice(box[0].length);
        }
        const dt = /^(.+?)\s+::\s/.exec(body);
        if (dt !== null) {
            inline(dt[1], 'fg', out);
            push(out, 'markup', body.slice(dt[1].length, dt[0].length));
            body = body.slice(dt[0].length);
        }
        inline(body, 'fg', out);
        return out;
    }
    inline(line, 'fg', out);
    return out;
}

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

const PROSE = /^(fg|h\d|bold|italic|underline|strike|linkDesc)$/;

export type Span = { from: number; to: number };

// The prose in one line, as offsets into it.
export function proseSpans(text: string, st: LineState, todo: TodoStates): Span[] {
    if (st.drawer || (st.block !== '' && st.block !== 'quote' && st.block !== 'verse' && st.block !== 'center')) { return []; }
    if (/^\s*#\+/.test(text) || /^\s*:[\w-]+:/.test(text) || /^\s*(SCHEDULED|DEADLINE|CLOSED):/.test(text)) { return []; }
    const out: Span[] = [];
    let at = 0;
    for (const t of lineTokens(text, todo, st)) {
        const end = at + t.s.length;
        if (PROSE.test(t.c)) {
            const prev = out[out.length - 1];
            if (prev && prev.to === at) { prev.to = end; } else { out.push({ from: at, to: end }); }
        }
        at = end;
    }
    // A bare url is not prose either.
    const urls: Span[] = [];
    const re = /\b(?:https?|ftp|file|mailto):[^\s\][<>"]+|\b[\w.+-]+@[\w-]+\.[\w.-]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) { urls.push({ from: m.index, to: m.index + m[0].length }); }
    const spans = urls.length === 0 ? out : cut(out, urls);
    // Nothing but spaces is not worth a piece of its own.
    return spans.filter(s => text.slice(s.from, s.to).trim() !== '');
}

function cut(spans: Span[], holes: Span[]): Span[] {
    const out: Span[] = [];
    for (const s of spans) {
        let pieces = [s];
        for (const h of holes) {
            pieces = pieces.flatMap(p => (h.to <= p.from || h.from >= p.to) ? [p]
                : [{ from: p.from, to: h.from }, { from: h.to, to: p.to }].filter(x => x.to > x.from));
        }
        out.push(...pieces);
    }
    return out;
}

// The paragraph the line is in, as [first, last] lines. A heading is a
// paragraph of its own, and so is a list item.
export function paragraphAt(lines: string[], line: number): [number, number] {
    if (line < 0 || line >= lines.length || lines[line].trim() === '') { return [line, line]; }
    const own = (l: string) => HEADING.test(l) || /^\s*(?:[-+]|\d+[.)])\s/.test(l) || /^\s*#\+/.test(l);
    if (HEADING.test(lines[line])) { return [line, line]; }
    let a = line;
    while (a > 0 && lines[a - 1].trim() !== '' && !HEADING.test(lines[a - 1]) && !own(lines[a])) { a--; }
    let b = line;
    while (b + 1 < lines.length && lines[b + 1].trim() !== '' && !own(lines[b + 1])) { b++; }
    return [a, b];
}

export const OBJ = '￼';
export type Pos = { line: number; col: number };
// One paragraph's prose: its text, where each character came from, and the
// lines it covers.
export type Prose = { text: string; map: Pos[]; first: number; last: number };

export function proseOf(lines: string[], states: LineState[], todo: TodoStates, first: number, last: number): Prose {
    let text = '';
    const map: Pos[] = [];
    for (let k = first; k <= last; k++) {
        const l = lines[k];
        const spans = proseSpans(l, states[k], todo);
        // The space after a bullet or a heading's stars, and at the end of
        // the line, is not part of the sentence.
        if (spans.length) {
            const a = spans[0], z = spans[spans.length - 1];
            while (a.from < a.to && /\s/.test(l[a.from])) { a.from++; }
            while (z.to > z.from && /\s/.test(l[z.to - 1])) { z.to--; }
        }
        spans.filter(s => s.to > s.from).forEach((s, j, all) => {
            // Emphasis markers between two pieces (*bold* words) are no gap.
            const joined = j > 0 && /^[*/_+=~]+$/.test(l.slice(all[j - 1].to, s.from));
            if (text !== '' && !joined) {
                text += j === 0 ? '\n' : OBJ;
                map.push({ line: k, col: s.from });
            }
            for (let c = s.from; c < s.to; c++) {
                text += lines[k][c];
                map.push({ line: k, col: c });
            }
        });
    }
    return { text, map, first, last };
}

// Every paragraph with prose in it, or only those touching [from, to].
export function paragraphs(lines: string[], states: LineState[], todo: TodoStates, from = 0, to = lines.length - 1): Prose[] {
    const out: Prose[] = [];
    let n = Math.max(0, from);
    // Start at the top of the paragraph `from` is in.
    if (n < lines.length && lines[n].trim() !== '') { n = paragraphAt(lines, n)[0]; }
    for (; n < lines.length && n <= to; n++) {
        if (lines[n].trim() === '') { continue; }
        const [a, b] = paragraphAt(lines, n);
        const p = proseOf(lines, states, todo, a, b);
        if (p.text.trim() !== '') { out.push(p); }
        n = Math.max(n, b);
    }
    return out;
}

// Where an issue at [from, to) in a paragraph's text is in the file.
export function issueRange(p: Prose, from: number, to: number): { start: Pos; end: Pos } | null {
    if (to <= from || to > p.map.length) { return null; }
    const a = p.map[from];
    const b = p.map[to - 1];
    return { start: a, end: { line: b.line, col: b.col + 1 } };
}

// ---------------------------------------------------------------------------
// Issues, and Harper's
// ---------------------------------------------------------------------------

export type IssueKind = 'spell' | 'grammar' | 'style';
export type Issue = { from: number; to: number; kind: IssueKind; msg: string; fixes: string[]; rule: string };

// A lint as POST /harper/lint returns it (orgs' harper.go HarperLint).
export type HarperLint = { rule: string; kind: string; start: number; end: number; msg: string; fixes: string[] };

const SPELL = new Set(['Spelling', 'Typo']);
const STYLE = new Set(['Style', 'Readability', 'Redundancy', 'Repetition', 'WordChoice', 'Enhancement', 'Regionalism', 'Formatting', 'Miscellaneous']);

export function harperKind(k: string): IssueKind {
    return SPELL.has(k) ? 'spell' : STYLE.has(k) ? 'style' : 'grammar';
}

export function harperIssues(lints: HarperLint[]): Issue[] {
    return (lints || [])
        .filter(l => l.end > l.start)
        .map(l => ({
            from: l.start, to: l.end, kind: harperKind(l.kind),
            // Harper writes `code` round words; a diagnostic is plain text.
            msg: (l.msg || '').replace(/`([^`]*)`/g, '“$1”'),
            fixes: Array.from(new Set(l.fixes || [])).slice(0, 8),
            rule: `harper:${l.rule}`,
        }));
}

// The built-in issues and Harper's together: anything built in is kept unless
// Harper has already marked the same words. A spelling complaint about a
// name the file uses often (skipSpell) is dropped.
export function mergeHarper(local: Issue[], harper: Issue[], skipSpell: (from: number, to: number) => boolean): Issue[] {
    const theirs = harper.filter(h => !(h.kind === 'spell' && skipSpell(h.from, h.to)));
    const overlaps = (i: Issue) => theirs.some(h => h.from < i.to && i.from < h.to);
    const mine = local.filter(i => !overlaps(i));
    return [...theirs, ...mine].sort((a, b) => a.from - b.from || a.to - b.to);
}

// The rule as it is ignored: Harper's by its own name (what /harper/lint
// takes in Off), the built-in ones by theirs.
export function ruleName(rule: string): string {
    return rule.replace(/^harper:/, '');
}

// Whether an issue survives what the user has said to ignore.
export function kept(i: Issue, word: string, ignoreWords: string[], ignoreRules: string[]): boolean {
    if (ignoreRules.includes(ruleName(i.rule)) || ignoreRules.includes(i.rule)) { return false; }
    if (i.kind === 'spell' && ignoreWords.some(w => w.toLowerCase() === word.toLowerCase())) { return false; }
    return true;
}

// The cache key for one paragraph's Harper answer: everything that changes it.
export function harperKey(dialect: string, off: string[], text: string): string {
    return `${dialect}|${off.slice().sort().join(',')}\n${text}`;
}

// Harper is sent plain prose: the OBJ marks are spaces to it.
export function harperText(text: string): string {
    return text.split(OBJ).join(' ');
}
