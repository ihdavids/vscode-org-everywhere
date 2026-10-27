// The day planner's arithmetic, ported from worg/src/planner.ts: minutes,
// snapping, how full a day is, where a block sits beside the ones it
// overlaps, and the optimistic edits the view makes before the server has
// answered.
//
// The server works the day out (GET /plan/day, internal/app/orgs/planner.go)
// and is the truth after every write. The load, overlap and free-gap rules
// are said again here (dayLoad, overlapPairs, freeSlot ↔ planLoad,
// planOverlaps, planFreeSlot in planner.go, the same cases in
// planner.test.ts and planner_test.go) because a drag has to show the day
// it would make while the pointer is still moving, and a placement with the
// keyboard has to land where the server would have put it.

// No vscode import: this runs under plain node (test/planner.test.ts, the
// same cases as worg's planner.test.ts and the server's planner_test.go).

// ── Fuzzy matching (worg/src/fuzzy.ts, after orgs' dnd/fuzzy.go) ──

// How good a subsequence match `pattern` is for `text`: adjacent letters,
// word starts and the front count for more, gaps for less. null when absent.
export function fuzzyScore(pattern: string, text: string): number | null {
    if (pattern === '') return 0;
    const pat = Array.from(pattern.toLowerCase());
    const txt = Array.from(text.toLowerCase());
    let score = 0;
    let pi = 0;
    let last = -1;
    for (let ti = 0; ti < txt.length && pi < pat.length; ti++) {
        if (txt[ti] !== pat[pi]) continue;
        score += 10;
        if (ti === 0) score += 20;
        else if (last === ti - 1) score += 12;
        else if (' -_/(),.\':'.includes(txt[ti - 1])) score += 10;
        if (last >= 0 && ti - last > 1) score -= Math.min(ti - last - 1, 6);
        last = ti;
        pi++;
    }
    if (pi < pat.length) return null;
    score -= Math.floor(txt.length / 12);
    return score;
}

// Every term must match: loosely on the name, as a whole substring on the
// rest of the label, because fuzzy over a sentence matches almost anything.
export function fuzzyScoreAll(terms: string[], name: string, label: string): number | null {
    let rest = label.toLowerCase();
    const at = rest.indexOf(name.toLowerCase());
    if (at >= 0) rest = rest.slice(at + name.length);
    let total = 0;
    for (const t of terms) {
        const n = fuzzyScore(t, name);
        if (n !== null) { total += n * 2; continue; }
        const i = rest.indexOf(t);
        if (i >= 0) { total += 20 - Math.floor(i / 8); continue; }
        return null;
    }
    return total;
}

export function fuzzyTerms(filter: string): string[] {
    return filter.trim().toLowerCase().split(/\s+/).filter(t => t !== '');
}

// ── The wire types (internal/common/plan.go) ──

export type PlanBlock = {
    Hash: string;
    Headline: string;
    Filename: string;
    LineNum: number;
    Status: string;
    Priority: string;
    Tags: string[];
    Kind: 'scheduled' | 'timestamp' | 'deadline' | string;
    Start: string; // HH:MM
    End: string;
    Mins: number;
    Implied: boolean;
    Movable: boolean;
    Repeat: boolean;
    Repeater: string;
    Done: boolean;
    Stamp: string;
    EffortMins: number;
    DueIn: number;
    Late: number;
    // Set by the view while a write for it is on its way.
    Pending?: boolean;
};

export type PlanTask = {
    Hash: string;
    Headline: string;
    Filename: string;
    LineNum: number;
    Status: string;
    Priority: string;
    Tags: string[];
    Effort: string;
    EffortMins: number;
    Scheduled: string;
    Deadline: string;
    Late: number;
    DueIn: number;
    Repeater: string;
};

export type PlanLoad = {
    WindowMins: number;
    PlannedMins: number;
    FreeMins: number;
    DoubleMins: number;
    OutsideMins: number;
    BacklogMins: number;
    BacklogNoEst: number;
};

export type PlanDay = {
    Ok: boolean;
    Msg: string;
    Date: string;
    Today: string;
    DayStart: string;
    DayEnd: string;
    Query: string;
    Blocks: PlanBlock[];
    AllDay: PlanBlock[];
    Tasks: PlanTask[];
    Load: PlanLoad;
    Overlaps: [number, number][];
    DefaultMins: number;
};

export type PlanWrite = { Ok: boolean; Msg: string; Hash: string; Stamp: string; Start: string; End: string };

export const DAY_MINS = 24 * 60;
export const SNAP = 15;
export const DEFAULT_MINS = 60;

// ── Minutes ──

// "09:05" → 545; -1 when it is not a time.
export function clockMins(s: string): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim());
    if (!m) return -1;
    const h = Number(m[1]), mi = Number(m[2]);
    if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return -1;
    return h * 60 + mi;
}

export function clock(m: number): string {
    const v = Math.max(0, Math.min(DAY_MINS, Math.round(m)));
    return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

// A length the way the planner says one: 45m, 2h, 1h30.
export function lengthText(m: number): string {
    const v = Math.max(0, Math.round(m));
    if (v < 60) return `${v}m`;
    if (v % 60 === 0) return `${v / 60}h`;
    return `${Math.floor(v / 60)}h${String(v % 60).padStart(2, '0')}`;
}

export function snap(m: number, step = SNAP): number {
    return Math.round(m / step) * step;
}

// Where a block may go: inside the day, no shorter than one step, and never
// past 23:59, the last minute org can write.
export function clampBlock(start: number, len: number, step = SNAP): { start: number; end: number } {
    const l = Math.max(step, len);
    let s = Math.max(0, start);
    if (s + l > DAY_MINS - 1) s = Math.max(0, DAY_MINS - 1 - l);
    return { start: s, end: Math.min(DAY_MINS - 1, s + l) };
}

// How long a task is when it is dropped: its EFFORT, else the default, made a
// whole number of steps so it ends on the grid it started on.
export function taskLength(effortMins: number, def = DEFAULT_MINS, step = SNAP): number {
    const m = effortMins > 0 ? effortMins : def;
    return Math.max(step, Math.ceil(m / step) * step);
}

// ── Load, overlaps, free time (said again in planner.go) ──

export type Span = { start: number; end: number };

export function spanOf(b: PlanBlock): Span {
    const s = clockMins(b.Start);
    const e = clockMins(b.End);
    return { start: s, end: e < 0 ? s : e };
}

// Minutes inside [ds, de) covered once or more and twice or more, and
// covered outside it. A minute at a time, as the server counts.
export function dayLoad(spans: Span[], ds: number, de: number): { planned: number; double: number; outside: number } {
    const cover = new Array<number>(DAY_MINS).fill(0);
    for (const s of spans) {
        const a = Math.max(0, s.start), b = Math.min(DAY_MINS, s.end);
        for (let m = a; m < b; m++) cover[m]++;
    }
    let planned = 0, double = 0, outside = 0;
    for (let m = 0; m < DAY_MINS; m++) {
        const inside = m >= ds && m < de;
        if (inside && cover[m] >= 2) { planned++; double++; }
        else if (inside && cover[m] === 1) planned++;
        else if (!inside && cover[m] >= 1) outside++;
    }
    return { planned, double, outside };
}

export function overlapPairs(spans: Span[]): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < spans.length; i++) {
        for (let j = i + 1; j < spans.length; j++) {
            const a = spans[i], b = spans[j];
            if (a.end > a.start && b.end > b.start && a.start < b.end && b.start < a.end) out.push([i, j]);
        }
    }
    return out;
}

// The first gap of at least `length` minutes inside [ds, de), from `from` on;
// null when there is none.
export function freeSlot(spans: Span[], ds: number, de: number, from: number, length: number): number | null {
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    let start = Math.max(ds, from);
    for (const s of sorted) {
        if (s.end <= s.start || s.end <= start) continue;
        if (s.start - start >= length) break;
        start = s.end;
    }
    return start + length <= de ? start : null;
}

// Where "the next free slot" starts looking: now (up to the next quarter
// hour) on today, the start of the working day otherwise.
export function searchFrom(day: PlanDay, now: Date, ds: number): number {
    if (day.Date !== ymd(now)) return ds;
    const n = Math.ceil((now.getHours() * 60 + now.getMinutes()) / SNAP) * SNAP;
    return Math.max(ds, n);
}

export function ymd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The load and overlaps of a day whose blocks the view has changed.
export function recompute(day: PlanDay): PlanDay {
    const ds = clockMins(day.DayStart), de = clockMins(day.DayEnd);
    const spans = day.Blocks.map(spanOf);
    const { planned, double, outside } = dayLoad(spans, ds, de);
    let backlog = 0, noEst = 0;
    for (const t of day.Tasks) {
        if (t.EffortMins > 0) backlog += t.EffortMins; else noEst++;
    }
    return {
        ...day,
        Load: {
            WindowMins: de - ds, PlannedMins: planned, FreeMins: de - ds - planned, DoubleMins: double,
            OutsideMins: outside, BacklogMins: backlog, BacklogNoEst: noEst,
        },
        Overlaps: overlapPairs(spans),
    };
}

// ── Laying blocks side by side ──

export type Lane = { lane: number; lanes: number };

// Blocks that overlap go side by side: each takes the first lane free at its
// start, and every block in a run of overlapping ones is as narrow as that
// run's widest moment needs. A moment (a deadline) is not given a lane; it is
// drawn as a line across the day.
export function layoutLanes(spans: Span[]): Lane[] {
    const out: Lane[] = spans.map(() => ({ lane: 0, lanes: 1 }));
    const order = spans.map((_, i) => i)
        .filter(i => spans[i].end > spans[i].start)
        .sort((a, b) => spans[a].start - spans[b].start || spans[b].end - spans[a].end);
    let cluster: number[] = [];
    let clusterEnd = -1;
    let laneEnds: number[] = [];
    const close = () => {
        const n = Math.max(1, laneEnds.length);
        for (const i of cluster) out[i].lanes = n;
        cluster = [];
        laneEnds = [];
    };
    for (const i of order) {
        const s = spans[i];
        if (cluster.length > 0 && s.start >= clusterEnd) close();
        let lane = laneEnds.findIndex(e => e <= s.start);
        if (lane < 0) { lane = laneEnds.length; laneEnds.push(s.end); } else laneEnds[lane] = s.end;
        out[i].lane = lane;
        cluster.push(i);
        clusterEnd = Math.max(cluster.length === 1 ? s.end : clusterEnd, s.end);
    }
    close();
    return out;
}

// ── Optimistic edits ──

function blockFromTask(t: PlanTask, start: number, end: number): PlanBlock {
    return {
        Hash: t.Hash, Headline: t.Headline, Filename: t.Filename, LineNum: t.LineNum, Status: t.Status,
        Priority: t.Priority, Tags: t.Tags, Kind: 'scheduled', Start: clock(start), End: clock(end),
        Mins: end - start, Implied: false, Movable: true, Repeat: false, Repeater: t.Repeater, Done: false,
        Stamp: '', EffortMins: t.EffortMins, DueIn: -1, Late: 0, Pending: true,
    };
}

function taskFromBlock(b: PlanBlock, date: string): PlanTask {
    // A repeating block keeps its date when it comes off (the server's rule),
    // so it comes back as due today rather than unscheduled.
    const keeps = !!b.Repeater;
    return {
        Hash: b.Hash, Headline: b.Headline, Filename: b.Filename, LineNum: b.LineNum, Status: b.Status,
        Priority: b.Priority, Tags: b.Tags, Effort: '', EffortMins: b.EffortMins,
        Scheduled: keeps ? date : '', Deadline: '', Late: keeps ? 0 : -1, DueIn: 0, Repeater: b.Repeater,
    };
}

// The day as it will be once hash is at [start, end): a task taken off the
// list onto the grid, or a block moved or resized.
export function placeLocally(day: PlanDay, hash: string, start: number, end: number): PlanDay {
    const at = day.Blocks.findIndex(b => b.Hash === hash && b.Movable);
    let blocks = day.Blocks;
    let tasks = day.Tasks;
    if (at >= 0) {
        blocks = blocks.map((b, i) => i === at ? { ...b, Start: clock(start), End: clock(end), Mins: end - start, Implied: false, Pending: true } : b);
    } else {
        const t = tasks.find(x => x.Hash === hash);
        if (!t) return day;
        tasks = tasks.filter(x => x.Hash !== hash);
        blocks = [...blocks, blockFromTask(t, start, end)];
    }
    blocks = [...blocks].sort((a, b) => clockMins(a.Start) - clockMins(b.Start));
    return recompute({ ...day, Blocks: blocks, Tasks: tasks });
}

// The day once hash is off the grid and back on the list.
export function unplanLocally(day: PlanDay, hash: string): PlanDay {
    const b = day.Blocks.find(x => x.Hash === hash && x.Movable);
    if (!b) return day;
    return recompute({
        ...day,
        Blocks: day.Blocks.filter(x => x !== b),
        Tasks: [taskFromBlock(b, day.Date), ...day.Tasks],
    });
}

// ── The list ──

// The tasks a filter leaves, best first. Terms match the headline loosely
// and the keyword, tags and file's base name as whole words (fuzzy.ts's rule),
// so "rep" finds the report and "home" finds what is in home.org.
export function filterTasks(tasks: PlanTask[], filter: string): PlanTask[] {
    const terms = fuzzyTerms(filter);
    if (terms.length === 0) return tasks;
    const scored: { t: PlanTask; s: number; i: number }[] = [];
    tasks.forEach((t, i) => {
        const base = t.Filename.split('/').pop() || '';
        const label = `${t.Headline} ${t.Status} ${t.Tags.join(' ')} ${base}`;
        const s = fuzzyScoreAll(terms, t.Headline, label);
        if (s !== null) scored.push({ t, s, i });
    });
    scored.sort((a, b) => b.s - a.s || a.i - b.i);
    return scored.map(x => x.t);
}

// What the list says beside a task: how late, or when it is due.
export function taskNote(t: PlanTask): string {
    if (t.Late > 0) return `${t.Late}d late`;
    if (t.Late === 0) return 'today';
    if (t.Deadline && t.DueIn < 0) return `due ${-t.DueIn}d ago`;
    if (t.Deadline && t.DueIn === 0) return 'due today';
    if (t.Deadline) return `due in ${t.DueIn}d`;
    return '';
}
