// What the dependency CodeLens says over a heading: what holds it up (orgs'
// /insights/deps) and how its schedule is going (/gantt/tasks, laid out the
// way worg's gantt chart lays it out: gantt.ts ganttFromTasks, criticalPath,
// healthOf). No vscode here; src/dep-lens.ts draws it.
//
// The schedule is the plan of one file's tasks (plus whatever they come
// AFTER in other files, which the server pulls in), so "on the critical path"
// means critical to that file's plan.

// -- Wire types ----------------------------------------------------------------

export interface DepHeading {
    Hash: string;
    Headline: string;
    Filename: string;
    LineNum: number;
    Status: string;
    Done: boolean;
    Via?: string;
    After?: string;
    NoBlocking?: string;
    Chained?: boolean;
}

export type DepKind = 'cycle' | 'waiting-on-done' | 'blocked-chain' | 'dangling' | 'ordered-stuck' | string;
export type Severity = 'error' | 'warn' | 'info' | string;

export interface DepProblem {
    Kind: DepKind;
    Severity: Severity;
    Title: string;
    Suggestion: string;
    Chain: DepHeading[] | null;
    Length?: number;
    Held?: number;
    Missing?: string;
}

export interface DepReport { Ok: boolean; Msg?: string; Query: string; Checked: number; Problems: DepProblem[] | null; }

// One heading as /gantt/tasks gives it (common.GanttTask), the fields used here.
export interface GanttServerTask {
    Hash: string;
    Headline: string;
    Filename: string;
    LineNum: number;
    Section: string;
    Props: { [k: string]: string } | null;
    Start: string;
    End: string;
    EffortDays: number;
    After: string;
    Percent: number;
    Order: number;
    HasOrder: boolean;
    Done: boolean;
    Milestone: boolean;
    Mark: boolean;
    Implied: boolean;
}

export interface GanttData { Ok: boolean; Msg: string; Query: string; Tasks: GanttServerTask[] | null; }

// -- Asking ------------------------------------------------------------------

// A regular expression for exactly this path, with no backslashes in it: the
// query language's strings eat them, so special characters go in [].
export function pathRegex(file: string): string {
    return '^' + file.replace(/[.*+?${}()|\\^\[\]"]/g, c => /[\\^\[\]"]/.test(c) ? '.' : `[${c}]`) + '$';
}

// The gantt query for one file's tasks: anything with a keyword, done ones
// too, so a finished task still holds its place in the plan.
export function fileQuery(file: string): string {
    return `HasAStatus() && !IsArchived() && InFile("${pathRegex(file)}")`;
}

// -- Laying the plan out (worg's gantt.ts) --------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlannedTask {
    hash: string;
    name: string;
    filename: string;
    lineNum: number;
    start: Date;
    end: Date;
    after: string[];
    done: boolean;
    mark: boolean;
    milestone: boolean;
    implied: boolean;
    percent: number;
    props: { [k: string]: string };
}

export function startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

// Local time: a task on the 3rd is on the 3rd whatever the timezone.
export function parseDay(s: string): Date | null {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}

function weekend(d: Date): boolean {
    return d.getDay() === 0 || d.getDay() === 6;
}

// A duration walked forward over working days: two days started on a Friday
// end on Tuesday.
export function addWorkingTime(start: Date, ms: number): Date {
    let cur = new Date(start.getTime());
    let left = ms;
    for (let guard = 0; guard < 20000 && left > 0; guard++) {
        const next = addDays(startOfDay(cur), 1);
        if (weekend(cur)) {
            cur = next;
            continue;
        }
        const take = Math.min(left, next.getTime() - cur.getTime());
        cur = new Date(cur.getTime() + take);
        left -= take;
    }
    return cur;
}

function toWorkingDay(d: Date): Date {
    let cur = d;
    for (let guard = 0; guard < 14 && weekend(cur); guard++) {
        cur = addDays(startOfDay(cur), 1);
    }
    return cur;
}

// The chart's row order: lanes in the order met, GANTT_ORDER within a lane,
// then file and line. It matters because a task with no date and nothing to
// come after starts when the row above it ends.
export function sortTasks(rows: GanttServerTask[]): GanttServerTask[] {
    const lane = new Map<string, number>();
    rows.forEach(r => {
        const s = r.Section || 'main';
        if (!lane.has(s)) {
            lane.set(s, lane.size);
        }
    });
    return rows.slice().sort((a, b) => {
        const la = lane.get(a.Section || 'main') as number, lb = lane.get(b.Section || 'main') as number;
        if (la !== lb) {
            return la - lb;
        }
        const oa = a.HasOrder ? a.Order : Number.MAX_SAFE_INTEGER, ob = b.HasOrder ? b.Order : Number.MAX_SAFE_INTEGER;
        if (oa !== ob) {
            return oa - ob;
        }
        if (a.Filename !== b.Filename) {
            return a.Filename < b.Filename ? -1 : 1;
        }
        return a.LineNum - b.LineNum;
    });
}

// When each task starts and ends: its own date; else when what it comes
// after ends; else when the row above ends; the first row starts today.
// Resolved until nothing moves, since each answer waits on others; whatever
// never resolves (a cycle) starts today.
export function schedule(rows: GanttServerTask[], now: Date): PlannedTask[] {
    const sorted = sortTasks(rows);
    const known = new Set(sorted.map(r => r.Hash));
    const byId = new Map<string, number>();
    sorted.forEach((r, i) => byId.set(r.Hash, i));
    const start: (Date | null)[] = sorted.map(() => null);
    const end: (Date | null)[] = sorted.map(() => null);
    const after = sorted.map(r => r.After && known.has(r.After) ? [r.After] : []);
    const durOf = (r: GanttServerTask) => r.EffortDays > 0 ? r.EffortDays * DAY_MS : DAY_MS;
    const one = (i: number): boolean => {
        const r = sorted[i];
        let s: Date | null = r.Start ? parseDay(r.Start) : null;
        if (!s && after[i].length) {
            for (const id of after[i]) {
                const e = end[byId.get(id) as number];
                if (!e) {
                    return false;
                }
                if (!s || e > s) {
                    s = e;
                }
            }
        }
        if (!s) {
            if (i > 0) {
                if (!end[i - 1]) {
                    return false;
                }
                s = end[i - 1];
            } else {
                s = startOfDay(now);
            }
        }
        const point = r.Milestone || r.Mark;
        if (!point) {
            s = toWorkingDay(s as Date);
        }
        const until = r.End ? parseDay(r.End) : null;
        start[i] = s;
        end[i] = point ? new Date((s as Date).getTime()) : until && until > (s as Date) ? until : addWorkingTime(s as Date, durOf(r));
        return true;
    };
    let pending = sorted.map((_, i) => i);
    for (let pass = 0; pass <= sorted.length && pending.length; pass++) {
        const before = pending.length;
        pending = pending.filter(i => !one(i));
        if (pending.length === before) {
            break;
        }
    }
    for (const i of pending) {
        start[i] = startOfDay(now);
        end[i] = addWorkingTime(start[i] as Date, durOf(sorted[i]));
    }
    return sorted.map((r, i) => ({
        hash: r.Hash, name: r.Headline, filename: r.Filename, lineNum: r.LineNum,
        start: start[i] as Date, end: end[i] as Date, after: after[i],
        done: !!r.Done, mark: !!r.Mark, milestone: !!r.Milestone, implied: !!r.Implied,
        percent: r.Percent || 0, props: r.Props || {},
    }));
}

// The latest moment each task can end without moving the end of the plan.
export function latestFinish(tasks: PlannedTask[]): Map<string, number> {
    const ts = tasks.filter(t => !t.mark);
    const latest = new Map<string, number>();
    if (!ts.length) {
        return latest;
    }
    const byId = new Map(ts.map(t => [t.hash, t] as [string, PlannedTask]));
    const waiters = new Map<string, PlannedTask[]>();
    for (const t of ts) {
        for (const a of t.after) {
            if (byId.has(a)) {
                waiters.set(a, (waiters.get(a) || []).concat([t]));
            }
        }
    }
    const projectEnd = Math.max(...ts.map(t => t.end.getTime()));
    const visiting = new Set<string>();
    const lf = (t: PlannedTask): number => {
        const known = latest.get(t.hash);
        if (known !== undefined) {
            return known;
        }
        if (visiting.has(t.hash)) {
            return projectEnd;
        }
        visiting.add(t.hash);
        let v = projectEnd;
        for (const w of waiters.get(t.hash) || []) {
            v = Math.min(v, lf(w) - (w.end.getTime() - w.start.getTime()));
        }
        visiting.delete(t.hash);
        latest.set(t.hash, v);
        return v;
    };
    ts.forEach(lf);
    return latest;
}

// The tasks with less than half a day of room: the ones that decide when the
// plan ends.
export function criticalPath(tasks: PlannedTask[]): Set<string> {
    const out = new Set<string>();
    const lf = latestFinish(tasks);
    for (const t of tasks) {
        if (t.mark || t.done || t.implied) {
            continue;
        }
        const v = lf.get(t.hash);
        if (v !== undefined && v - t.end.getTime() < DAY_MS / 2) {
            out.add(t.hash);
        }
    }
    return out;
}

// Overdue: not finished and its last day has gone. Slipping: it records its
// progress, has started, and is more than a fifth behind where it should be.
export function healthOf(t: PlannedTask, now: Date): { kind: 'overdue' | 'slipping'; note: string } | null {
    if (t.mark || t.done || t.implied) {
        return null;
    }
    const today = startOfDay(now);
    const lastDay = startOfDay(new Date(t.end.getTime() - 1));
    if (lastDay < today) {
        return { kind: 'overdue', note: `overdue ${Math.round((today.getTime() - lastDay.getTime()) / DAY_MS)}d` };
    }
    const tracked = Object.keys(t.props).some(k => k.toUpperCase() === 'PERCENTDONE') || t.percent > 0;
    const span = t.end.getTime() - t.start.getTime();
    if (tracked && t.start <= now && span > 0) {
        const expected = Math.min(100, ((now.getTime() - t.start.getTime()) / span) * 100);
        if (expected - t.percent > 20) {
            return { kind: 'slipping', note: `slipping: ${Math.round(t.percent)}% done, ${Math.round(expected)}% due` };
        }
    }
    return null;
}

// -- The lens ------------------------------------------------------------------

export interface HeadingLens {
    line: number;
    parts: string[];
    severity: 'error' | 'warn' | 'info';
    // Where clicking goes: what holds it up, worst first.
    targets: DepHeading[];
    tooltip: string;
}

const RANK: { [s: string]: number } = { error: 0, warn: 1, info: 2 };

function heading(line: string): { level: number; title: string } | null {
    const m = /^(\*+)\s+(.*?)\s*$/.exec(line);
    return m ? { level: m[1].length, title: m[2] } : null;
}

// The line of a heading the server named, in the editor's lines: its own line
// when that still is the heading, else the heading of that title nearest it.
export function placeOf(lines: string[], lineNum: number, headline: string): number {
    const want = headline.trim().toLowerCase();
    // The title alone: keyword, priority and tags aside.
    const bare = (t: string) => t.replace(/^[A-Z][A-Z-]+\s+/, '').replace(/^\[#.\]\s*/, '').replace(/\s+:[\w@#%:]+:$/, '').trim().toLowerCase();
    const titleAt = (i: number) => {
        const h = i >= 0 && i < lines.length ? heading(lines[i]) : null;
        return h ? h.title : null;
    };
    const has = (i: number) => {
        const t = titleAt(i);
        return t !== null && bare(t) === want;
    };
    // Its own line, still a heading that says as much, is taken loosely.
    const own = titleAt(lineNum);
    if (own !== null && (bare(own) === want || own.toLowerCase().indexOf(want) >= 0)) {
        return lineNum;
    }
    for (let d = 1; d < lines.length; d++) {
        if (has(lineNum - d)) {
            return lineNum - d;
        }
        if (has(lineNum + d)) {
            return lineNum + d;
        }
    }
    return -1;
}

function samePath(a: string, b: string): boolean {
    return a === b || a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

// What one problem says about one heading in its chain, and where it points.
function phrase(p: DepProblem, i: number): { text: string; to: DepHeading[] } | null {
    const chain = p.Chain || [];
    const me = chain[i];
    const others = chain.filter((_, j) => j !== i);
    switch (p.Kind) {
        case 'blocked-chain':
            if (i === 0) {
                return { text: `holding up ${p.Held || chain.length - 1}`, to: [] };
            }
            // The root blocker first, then the heading straight before it.
            return { text: `blocked by ${chain[0].Headline}`, to: i > 1 ? [chain[0], chain[i - 1]] : [chain[0]] };
        case 'waiting-on-done':
            return i === 0 ? null : { text: `${me.Status} on done ${chain[i - 1].Headline}`, to: [chain[i - 1]] };
        case 'cycle':
            return { text: `in a cycle with ${Array.from(new Set(others.filter(o => o.Hash !== me.Hash).map(o => o.Headline))).join(', ')}`, to: others.filter(o => o.Hash !== me.Hash) };
        case 'dangling':
            if (chain.length === 1) {
                return { text: `AFTER "${p.Missing || ''}" names nothing`, to: [] };
            }
            return i === 0 ? { text: 'archived, still waited on', to: chain.slice(1) } : { text: `after archived ${chain[0].Headline}`, to: [chain[0]] };
        case 'ordered-stuck':
            return i === 0 ? { text: 'stuck step of an ORDERED project', to: [] } : { text: `held by ${chain[0].Headline}`, to: [chain[0]] };
    }
    return { text: p.Title, to: others };
}

// The lenses for one file: a heading's dependency problems first, then its
// schedule (overdue / slipping / critical).
export function lensesFor(file: string, lines: string[], report: DepReport | undefined, tasks: PlannedTask[], now: Date): HeadingLens[] {
    const by = new Map<number, HeadingLens & { tips: string[] }>();
    const at = (line: number) => {
        let l = by.get(line);
        if (!l) {
            l = { line, parts: [], severity: 'info', targets: [], tooltip: '', tips: [] };
            by.set(line, l);
        }
        return l;
    };
    const add = (l: HeadingLens & { tips: string[] }, text: string, sev: string, to: DepHeading[], tip: string) => {
        if (l.parts.indexOf(text) < 0) {
            l.parts.push(text);
        }
        if ((RANK[sev] ?? 2) < RANK[l.severity]) {
            l.severity = sev as HeadingLens['severity'];
        }
        for (const t of to) {
            if (!l.targets.some(x => x.Hash === t.Hash)) {
                l.targets.push(t);
            }
        }
        if (tip && l.tips.indexOf(tip) < 0) {
            l.tips.push(tip);
        }
    };
    const problems = ((report && report.Problems) || []).slice().sort((a, b) => (RANK[a.Severity] ?? 2) - (RANK[b.Severity] ?? 2));
    for (const p of problems) {
        (p.Chain || []).forEach((h, i) => {
            if (!samePath(h.Filename, file)) {
                return;
            }
            const line = placeOf(lines, h.LineNum, h.Headline);
            const said = line >= 0 ? phrase(p, i) : null;
            if (said) {
                add(at(line), said.text, p.Severity, said.to, `${p.Title}. ${p.Suggestion}`);
            }
        });
    }
    const crit = criticalPath(tasks);
    for (const t of tasks) {
        if (!samePath(t.filename, file) || t.implied) {
            continue;
        }
        const health = healthOf(t, now);
        const critical = crit.has(t.hash) && tasks.length > 1;
        if (!health && !critical) {
            continue;
        }
        const line = placeOf(lines, t.lineNum, t.name);
        if (line < 0) {
            continue;
        }
        const l = at(line);
        if (health) {
            add(l, health.note, health.kind === 'overdue' ? 'warn' : 'info', [], '');
        }
        if (critical) {
            add(l, 'on critical path', 'info', [], 'No room to move: when this ends decides when the file\'s plan ends.');
        }
    }
    return Array.from(by.values()).sort((a, b) => a.line - b.line).map(l => ({
        line: l.line, parts: l.parts, severity: l.severity, targets: l.targets, tooltip: l.tips.join('\n'),
    }));
}

export function lensTitle(l: HeadingLens): string {
    const icon = l.severity === 'error' ? '$(error)' : l.severity === 'warn' ? '$(warning)' : '$(info)';
    return `${icon} ${l.parts.join(' · ')}`;
}
