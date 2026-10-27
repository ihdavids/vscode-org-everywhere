// Focus sessions (pomodoros run by the orgs server): the arithmetic and the
// wording, ported from worg's focus.ts so the status bar here reads as worg's
// header chip does. Pure, for test/focus.test.ts. The timer itself runs on the
// server (orgs/internal/app/orgs/focus.go); focus.ts only counts down between
// the server's answers.

export type FocusPhase = 'work' | 'break' | 'idle';

export type FocusSettings = {
    Work: number;
    Short: number;
    Long: number;
    LongEvery: number;
    AutoNext: boolean;
};

export type FocusState = {
    Ok: boolean;
    Msg?: string;
    Phase: FocusPhase;
    LongBreak?: boolean;
    Hash?: string;
    Title?: string;
    File?: string;
    Started?: string;
    Ends?: string;
    Remaining: number;
    Total: number;
    Now: string;
    Streak: number;
    Today: number;
    TodayMinutes: number;
    Settings: FocusSettings;
};

export type FocusRecord = {
    Hash: string;
    Title: string;
    File: string;
    Start: string;
    End: string;
    Minutes: number;
    Completed: boolean;
    Break?: number;
    LongBreak?: boolean;
};

export type FocusHistory = {
    Ok: boolean;
    Today: number;
    TodayMinutes: number;
    Records: FocusRecord[];
};

export const IDLE: FocusState = {
    Ok: true, Phase: 'idle', Remaining: 0, Total: 0, Now: '', Streak: 0, Today: 0, TodayMinutes: 0,
    Settings: { Work: 25, Short: 5, Long: 15, LongEvery: 4, AutoNext: false },
};

export const NO_ANSWER = 'The server did not answer.';

// What a request answered, made into a state: one that says so when the
// request itself failed, rather than something every caller checks the shape of.
export function asFocusState(s: any): FocusState {
    if (!s || Array.isArray(s) || !s.Phase) {
        return { ...IDLE, Ok: false, Msg: (s && (s.Msg || s.msg)) || NO_ANSWER };
    }
    return s as FocusState;
}

export function asFocusHistory(h: any): FocusHistory {
    return h && Array.isArray(h.Records) ? h : { Ok: false, Today: 0, TodayMinutes: 0, Records: [] };
}

// Seconds as a clock face: 4:07, 25:00, 1:02:03. Rounded up, so the last
// second reads 0:01 while there is still time left - a timer showing 0:00 that
// has not finished looks stuck.
export function formatCountdown(secs: number): string {
    let n = Math.ceil(secs);
    if (!(n > 0)) {
        n = 0;
    }
    const h = Math.floor(n / 3600), m = Math.floor(n / 60) % 60, s = n % 60;
    const ss = String(s).padStart(2, '0');
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    }
    return `${m}:${ss}`;
}

// Minutes as a person says them: 25 min, 1h 40m.
export function formatMinutes(m: number): string {
    if (m < 60) {
        return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
    }
    const n = Math.round(m);
    return `${Math.floor(n / 60)}h ${String(n % 60).padStart(2, '0')}m`;
}

// When the phase ends on this machine's clock, from the server's Remaining and
// the moment the answer arrived. The server's own Ends is not used: a laptop
// whose clock is two minutes out would count down two minutes wrong.
export function localEnd(state: FocusState, receivedAt: number): number {
    return receivedAt + Math.max(0, state.Remaining) * 1000;
}

export function remainingAt(end: number, now: number): number {
    return Math.max(0, (end - now) / 1000);
}

export function isRunning(state: FocusState | null | undefined): boolean {
    return !!state && (state.Phase === 'work' || state.Phase === 'break');
}

export function phaseLabel(state: FocusState): string {
    if (state.Phase === 'break') {
        return state.LongBreak ? 'Long break' : 'Break';
    }
    if (state.Phase === 'work') {
        return 'Focus';
    }
    return 'Idle';
}

export function phaseGlyph(phase: FocusPhase): string {
    return phase === 'work' ? '🍅' : phase === 'break' ? '☕' : '';
}

// The status bar's words, as worg's header chip has them: glyph, countdown,
// and the task while working or the phase on a break - "🍅 12:31 Write the
// report", "☕ 4:59 break". Empty when idle. A long title is cut so the
// status bar keeps room for everything else.
export function statusText(state: FocusState, remaining: number, max = 40): string {
    if (!isRunning(state)) {
        return '';
    }
    let what = state.Phase === 'work' ? (state.Title || '') : phaseLabel(state).toLowerCase();
    if (what.length > max) {
        what = what.slice(0, max - 1) + '…';
    }
    return `${phaseGlyph(state.Phase)} ${formatCountdown(remaining)}${what ? ' ' + what : ''}`;
}

// The hover over it: "Focus · Write the report · 2 of 4 · 3 today".
export function statusTooltip(state: FocusState): string {
    const pos = setPosition(state);
    return [phaseLabel(state), state.Title, `${pos.n} of ${pos.of}`, `${state.Today} today`].filter(s => s).join(' · ');
}

// What to tell somebody when the session moves on by itself, or null when the
// change is not worth interrupting for (or was their own doing - a stop).
export function transitionNotice(prev: FocusState, next: FocusState): { title: string; body: string } | null {
    if (prev.Phase === next.Phase && prev.Started === next.Started) {
        return null;
    }
    if (prev.Phase === 'work' && next.Phase === 'break') {
        const mins = next.Total / 60;
        return {
            title: 'Pomodoro done',
            body: `${next.Title || ''} · ${next.LongBreak ? 'long break' : 'break'}, ${formatMinutes(round1(mins))}`.replace(/^ · /, ''),
        };
    }
    if (prev.Phase === 'break' && next.Phase === 'idle') {
        return { title: 'Break over', body: next.Title ? `Another on ${next.Title}?` : 'Ready for the next one?' };
    }
    if (prev.Phase === 'break' && next.Phase === 'work') {
        return { title: 'Back to work', body: next.Title || '' };
    }
    return null;
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

// A task that can be picked: what /search answers, cut down.
export type FocusTask = { Hash: string; Headline: string; Filename: string; Status?: string; Priority?: string };

// The hashes of recent tasks, newest first, each once.
export function recentHashes(records: FocusRecord[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of records) {
        if (r.Hash && !seen.has(r.Hash)) {
            seen.add(r.Hash);
            out.push(r.Hash);
        }
    }
    return out;
}

// The task list as the picker shows it: recent tasks first in the order they
// were worked on, then the rest as the server gave them. (The quick pick does
// its own fuzzy matching on what is typed.)
export function orderTasks(tasks: FocusTask[], recent: string[]): FocusTask[] {
    const rank = new Map<string, number>();
    recent.forEach((h, i) => rank.set(h, i));
    const idx = new Map<FocusTask, number>();
    tasks.forEach((t, i) => idx.set(t, i));
    return [...tasks].sort((a, b) => {
        const ra = rank.has(a.Hash) ? rank.get(a.Hash) : Infinity;
        const rb = rank.has(b.Hash) ? rank.get(b.Hash) : Infinity;
        if (ra !== rb) {
            return ra < rb ? -1 : 1;
        }
        return idx.get(a) - idx.get(b);
    });
}

// Today's records only: the history endpoint answers by day already, but a
// window left open over midnight holds yesterday's.
export function todaysRecords(records: FocusRecord[], now: Date): FocusRecord[] {
    return records.filter(r => {
        const d = new Date(r.End);
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    });
}

// "pomodoro 2 of 4": where in the set of four the running one is.
export function setPosition(state: FocusState): { n: number; of: number } {
    const of = state.Settings && state.Settings.LongEvery || 4;
    const n = state.Phase === 'work' ? state.Streak + 1 : state.Streak === 0 && state.LongBreak ? of : state.Streak;
    return { n: Math.min(Math.max(n, 0), of), of };
}

// One line of history: "14:05–14:30  25 min  Write the report" with a mark
// for a pomodoro stopped before its end.
export function recordLine(r: FocusRecord): { label: string; description: string } {
    const hm = (s: string) => {
        const d = new Date(s);
        return isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    return {
        label: `${r.Completed ? '🍅' : '◌'} ${r.Title || '(no task)'}`,
        description: `${hm(r.Start)}–${hm(r.End)} · ${formatMinutes(round1(r.Minutes))}${r.Completed ? '' : ' · stopped'}`,
    };
}

// What a start sends: only what was said, so the server's settings fill the rest.
export type StartOptions = {
    hash?: string; target?: { Filename: string; Id: string; Type: string };
    work?: number; short?: number; long?: number; longEvery?: number; autoNext?: boolean;
};

export function startBody(o: StartOptions): any {
    const body: any = {};
    if (o.hash) {
        body.Hash = o.hash;
    }
    if (o.target) {
        body.Target = o.target;
    }
    if (o.work) {
        body.Work = o.work;
    }
    if (o.short) {
        body.Short = o.short;
    }
    if (o.long) {
        body.Long = o.long;
    }
    if (o.longEvery) {
        body.LongEvery = o.longEvery;
    }
    if (o.autoNext !== undefined) {
        body.AutoNext = o.autoNext;
    }
    return body;
}
