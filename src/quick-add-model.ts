// Adding a task in one line. No vscode here.
//
//   NEXT Write the spec 3d @Sam #design ^fri >kickoff !A RISK=high
//
// is a NEXT called "Write the spec", three days of EFFORT, ASSIGNEE Sam, tagged
// :design:, scheduled on Friday, waiting on the task called something like
// "kickoff", priority A, with a RISK property. Anything not recognised is the
// title. The grammar is worg's (parseQuickAdd in worg/src/ganttquick.ts) and
// orgs' (ParseQuick in cmd/oc/commands/cols/model.go), said again here; the
// one addition is ^^date for a DEADLINE, which neither of them reads.
//
// What the line becomes in the file is the server's ganttNewLines (POST
// /gantt/add), also said again, so a task added without the server reads the
// same as one added through it.

import { parseWhen, parseOrgDate, dayKey } from './when-model';
import { headingLevel, subtreeEnd } from './outline/model';

export interface QuickLine {
    headline: string;
    status: string;
    tags: string[];
    person: string;
    // As typed, for EFFORT: "3d", "1.5d", "2w", "4h".
    effort: string;
    start: Date | null;
    // ^^date: not in worg's grammar, the DEADLINE.
    deadline: Date | null;
    // What the task waits on, as typed after ">".
    after: string;
    priority: string;
    props: Record<string, string>;
}

const COMMON_STATUSES = ['TODO', 'NEXT', 'DOING', 'IN-PROGRESS', 'WAITING', 'BLOCKED', 'DONE'];

// A token's underscores are spaces: @Ian_Davids is the person "Ian Davids".
const spaced = (s: string) => s.replace(/_/g, ' ').trim();

// A day for ^: worg's reader, then orgs' (which also knows eow, tmr, a bare
// 15, and a time). The two agree wherever both read a word.
export function quickDay(s: string, now: Date): Date | null {
    const w = parseWhen(s, now);
    if (w) {
        return w;
    }
    const r = parseOrgDate(s, now);
    if (r.set && r.date && !r.error && !r.date.raw) {
        return new Date(r.date.day.getFullYear(), r.date.day.getMonth(), r.date.day.getDate());
    }
    return null;
}

export function parseQuickAdd(line: string, statuses: string[] = [], now: Date = new Date()): QuickLine {
    const out: QuickLine = {
        headline: '', status: '', tags: [], person: '', effort: '', start: null, deadline: null, after: '', priority: '', props: {},
    };
    const known = new Set([...statuses, ...COMMON_STATUSES]);
    const words: string[] = [];
    // A quoted run is one token, so @"Ian Davids" and >"design review" work.
    const tokens: string[] = line.match(/[@>#^]?"[^"]*"|\S+/g) || [];
    tokens.forEach((raw, i) => {
        const tok = raw.replace(/^([@>#^]?)"([^"]*)"$/, '$1$2');
        if (i === 0 && known.has(tok)) { out.status = tok; return; }
        if (/^#[^\s#]+$/.test(tok)) {
            tok.slice(1).split(':').filter(Boolean).forEach(t => { if (out.tags.indexOf(t) < 0) { out.tags.push(t); } });
            return;
        }
        if (/^@.+/.test(tok)) { out.person = spaced(tok.slice(1)); return; }
        if (/^\^\^.+/.test(tok)) {
            const d = quickDay(tok.slice(2), now);
            if (d) { out.deadline = d; return; }
        }
        if (/^\^.+/.test(tok)) {
            const d = quickDay(tok.slice(1), now);
            if (d) { out.start = d; return; }
        }
        if (/^>.+/.test(tok)) { out.after = spaced(tok.slice(1)); return; }
        if (/^![A-Za-z]$/.test(tok)) { out.priority = tok.slice(1).toUpperCase(); return; }
        if (/^\d+(\.\d+)?[hdwm]$/i.test(tok)) { out.effort = tok.toLowerCase(); return; }
        const kv = tok.match(/^([A-Za-z_][\w-]*)=(.+)$/);
        if (kv) { out.props[kv[1].toUpperCase()] = spaced(kv[2]); return; }
        words.push(raw);
    });
    out.headline = words.join(' ').trim();
    return out;
}

// --- what goes to the server, or into the file ------------------------------

// common.GanttAdd, the body of POST /gantt/add.
export interface GanttAdd {
    AfterHash?: string;
    ParentHash?: string;
    Filename?: string;
    Headline: string;
    Status: string;
    Start?: string;
    DateKind?: string;
    Effort?: string;
    Tags: string[];
    Props: Record<string, string>;
}

// The request for a parsed line, the way worg's column view and `orgs cols`
// build theirs: the person under the person property, the priority in front
// of the title. A task with no keyword typed is a TODO (this is "add a task").
// With both dates the request carries the SCHEDULED one and the DEADLINE is
// written after.
export function addRequest(q: QuickLine, opts: { personProp?: string, status?: string, afterId?: string } = {}): GanttAdd {
    const props: Record<string, string> = { ...q.props };
    if (q.person) {
        props[(opts.personProp || 'ASSIGNEE').toUpperCase()] = q.person;
    }
    if (opts.afterId) {
        props.AFTER = opts.afterId;
    }
    const add: GanttAdd = {
        Headline: q.priority ? `[#${q.priority}] ${q.headline}` : q.headline,
        Status: q.status || (opts.status === undefined ? 'TODO' : opts.status),
        Effort: q.effort,
        Tags: q.tags,
        Props: props,
    };
    if (q.start) {
        add.Start = dayKey(q.start);
        add.DateKind = 'SCHEDULED';
    } else if (q.deadline) {
        add.Start = dayKey(q.deadline);
        add.DateKind = 'DEADLINE';
    }
    return add;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "2026-01-05" as org writes a date (ganttStamp); anything else as it is.
export function ganttStamp(day: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
    if (!m) {
        return day;
    }
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return `<${day.trim()} ${DAYS[d.getDay()]}>`;
}

// The lines of a new heading (ganttNewLines): the stars, the keyword and the
// title, then the date under it and a property drawer. `deadline` is ours:
// it joins the planning line the way org writes both.
export function newHeadingLines(level: number, a: GanttAdd, deadline?: string): string[] {
    let head = '*'.repeat(level);
    if (a.Status) {
        head += ' ' + a.Status;
    }
    head += ' ' + a.Headline.trim();
    if (a.Tags.length > 0) {
        head += '  :' + a.Tags.join(':') + ':';
    }
    const lines = [head];
    const indent = ' '.repeat(level + 1);
    const planning: string[] = [];
    if (a.Start) {
        const kind = a.DateKind || 'SCHEDULED';
        if (kind === 'TIMESTAMP') {
            lines.push(indent + ganttStamp(a.Start));
        } else {
            planning.push(kind + ': ' + ganttStamp(a.Start));
        }
    }
    if (deadline && a.DateKind !== 'DEADLINE') {
        planning.push('DEADLINE: ' + ganttStamp(deadline));
    }
    if (planning.length) {
        lines.push(indent + planning.join(' '));
    }
    const props: [string, string][] = [];
    if (a.Effort) {
        props.push(['EFFORT', a.Effort]);
    }
    for (const k of Object.keys(a.Props)) {
        if (a.Props[k] !== '') {
            props.push([k.toUpperCase(), a.Props[k]]);
        }
    }
    if (props.length) {
        lines.push(indent + ':PROPERTIES:');
        props.forEach(p => lines.push(`${indent}  :${p[0]}: ${p[1]}`));
        lines.push(indent + ':END:');
    }
    return lines;
}

// --- into the file, without the server --------------------------------------

// Where a new heading goes: the last child of the heading at `parent` (or the
// end of the file, at level one, for -1), before the blank lines that close
// that subtree, so the gap stays before the next heading.
export function insertPoint(lines: string[], parent: number): { row: number, level: number } {
    const level = parent < 0 ? 1 : headingLevel(lines[parent]) + 1;
    let row = parent < 0 ? lines.length : subtreeEnd(lines, parent);
    while (row - 1 > parent && row > 0 && lines[row - 1].trim() === '') {
        row--;
    }
    return { row, level };
}

// The new heading put in, and optionally another heading's lines rewritten
// (an ID given to what it waits on), as one block to replace: [start, end) of
// the old lines becomes `lines`. `heading` is the new heading's line after.
export function insertTask(old: string[], row: number, add: string[], edit?: { start: number, end: number, lines: string[] }):
        { start: number, end: number, lines: string[], heading: number } {
    const next = old.slice();
    let heading = row;
    if (edit && edit.start >= row) {
        next.splice(edit.start, edit.end - edit.start, ...edit.lines);
        next.splice(row, 0, ...add);
    } else {
        next.splice(row, 0, ...add);
        if (edit) {
            next.splice(edit.start, edit.end - edit.start, ...edit.lines);
            heading += edit.lines.length - (edit.end - edit.start);
        }
    }
    const start = edit ? Math.min(edit.start, row) : row;
    const end = edit ? Math.max(edit.end, row) : row;
    return { start, end, lines: next.slice(start, end + (next.length - old.length)), heading };
}

// --- what it waits on -------------------------------------------------------

// The heading a fuzzy name means (worg's findTask): a whole-name match before
// a part-name one, the shortest name before a longer one.
export function findByName<T extends { title: string }>(items: T[], name: string): T | null {
    const want = name.trim().toLowerCase();
    if (!want) {
        return null;
    }
    const exact = items.find(t => t.title.toLowerCase() === want);
    if (exact) {
        return exact;
    }
    const hits = items.filter(t => t.title.toLowerCase().indexOf(want) >= 0);
    if (hits.length === 0) {
        return null;
    }
    return hits.sort((a, b) => a.title.length - b.title.length)[0];
}

// A readable id for a heading that has none (worg's idFor, orgs' ganttIdFor):
// its own words, plus enough of its hash to keep two of the same name apart.
export function idFor(title: string, hash: string = ''): string {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'task';
    const tail = (hash || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase();
    return tail ? `${slug}-${tail}` : slug;
}

// --- the preview ------------------------------------------------------------

// The parsed line said back, for the input box as it is typed:
// "TODO Write spec · @ian · scheduled Fri 9 Jan · 3h · after design".
export function describeQuick(q: QuickLine, opts: { personProp?: string } = {}): string {
    const bits: string[] = [];
    const day = (d: Date) => `${DAYS[d.getDay()]} ${dayKey(d)}`;
    bits.push(`${q.status || 'TODO'}${q.priority ? ` [#${q.priority}]` : ''} ${q.headline || '(no title yet)'}`);
    if (q.tags.length) { bits.push(':' + q.tags.join(':') + ':'); }
    if (q.person) { bits.push(`${(opts.personProp || 'ASSIGNEE').toUpperCase()} ${q.person}`); }
    if (q.start) { bits.push('scheduled ' + day(q.start)); }
    if (q.deadline) { bits.push('deadline ' + day(q.deadline)); }
    if (q.effort) { bits.push('effort ' + q.effort); }
    if (q.after) { bits.push('after ' + q.after); }
    Object.keys(q.props).forEach(k => bits.push(`${k}=${q.props[k]}`));
    return bits.join(' · ');
}
