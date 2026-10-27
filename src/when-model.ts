// Dates the way people type them: today, tomorrow, fri, +2w, 2026-10-01,
// fri 14:00, mon +1w. No vscode here.
//
// Two readers, both said again from elsewhere (see orgs' CLAUDE.md, "logic
// said twice"), so a date typed here means what it means in worg and in
// `orgs sched`:
//
//   parseWhen   - worg's (worg/src/ganttquick.ts): a day, or null.
//   parseOrgDate - orgs' internal/orgdate: a day with an optional time, range
//                  and repeater, a clear, or a reason it could not be read.
//
// Everything is wall-clock: a Date here is local midnight (or local hh:mm) of
// the day meant, read with getFullYear/getMonth/getDate, never as an instant.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

export function startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// 2026-10-01.
export function dayKey(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- worg's parseWhen -------------------------------------------------------

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// A day from what somebody typed: today, tomorrow, a weekday (the next one,
// today included), +3d / +2w / +1m / -2d, 2026-10-12 or 10-12 (this year, or
// next once it has passed). Null when it is none of those.
export function parseWhen(s: string, now: Date = new Date()): Date | null {
    const t = s.trim().toLowerCase();
    const today = startOfDay(now);
    const plus = (days: number, months = 0) =>
        new Date(today.getFullYear(), today.getMonth() + months, today.getDate() + days);
    if (t === 'today' || t === 'tod' || t === 'now') { return today; }
    if (t === 'tomorrow' || t === 'tom') { return plus(1); }
    if (t === 'yesterday') { return plus(-1); }
    const wd = WEEKDAYS.findIndex(w => t.startsWith(w) && 'sunday monday tuesday wednesday thursday friday saturday'.indexOf(t) >= 0);
    if (wd >= 0 && t.length >= 3) { return plus((wd - today.getDay() + 7) % 7); }
    let m = t.match(/^([+-])(\d+)([dwm])?$/);
    if (m) {
        const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
        if (m[3] === 'w') { return plus(n * 7); }
        if (m[3] === 'm') { return plus(0, n); }
        return plus(n);
    }
    m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) { return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); }
    m = t.match(/^(\d{1,2})-(\d{1,2})$/);
    if (m) {
        let d = new Date(today.getFullYear(), Number(m[1]) - 1, Number(m[2]));
        if (d < today) { d = new Date(today.getFullYear() + 1, Number(m[1]) - 1, Number(m[2])); }
        return d;
    }
    return null;
}

// --- orgs' internal/orgdate -------------------------------------------------

// A timestamp on the way to a file: the day, optionally a time or a range,
// optionally a repeater, and whether it is active (<>) or inactive ([]).
export interface OrgDate {
    day: Date;
    hasTime: boolean;
    end?: Date;          // the far end of a time range
    repeater: string;    // "+1w", ".+2d", "++1m" - as typed
    inactive: boolean;
    // A timestamp that arrived already written, passed through as it stands.
    raw: string;
}

export interface WhenResult {
    // false: "clear this date" (empty, clear, none...), and date is unset.
    set: boolean;
    date?: OrgDate;
    error?: string;
}

// The timestamp as org writes one.
export function orgDateString(d: OrgDate): string {
    if (d.raw) {
        return d.raw;
    }
    const [lo, hi] = d.inactive ? ['[', ']'] : ['<', '>'];
    return lo + orgDateBody(d) + hi;
}

// The inside of the brackets: 2026-10-02 Fri 14:00-15:00 +1w.
export function orgDateBody(d: OrgDate): string {
    if (d.raw) {
        return d.raw.replace(/^[<[]|[>\]]$/g, '');
    }
    let s = `${dayKey(d.day)} ${DAYS[d.day.getDay()]}`;
    if (d.hasTime) {
        s += ` ${pad(d.day.getHours())}:${pad(d.day.getMinutes())}`;
        if (d.end) {
            s += `-${pad(d.end.getHours())}:${pad(d.end.getMinutes())}`;
        }
    }
    if (d.repeater) {
        s += ' ' + d.repeater;
    }
    return s;
}

const CLEAR = ['', 'clear', 'none', 'off', 'remove', 'nil', '-'];

// What somebody typed as a date. `set: false` with no error is "clear it",
// which is what the server reads an empty value as.
export function parseOrgDate(input: string, now: Date = new Date()): WhenResult {
    const s = input.trim();
    const low = s.toLowerCase();
    if (CLEAR.indexOf(low) >= 0) {
        return { set: false };
    }
    if ((s.startsWith('<') && s.endsWith('>')) || (s.startsWith('[') && s.endsWith(']'))) {
        return { set: true, date: { day: startOfDay(now), hasTime: false, repeater: '', inactive: s[0] === '[', raw: s } };
    }
    const d: OrgDate = { day: startOfDay(now), hasTime: false, repeater: '', inactive: false, raw: '' };

    // The time wherever it was written: "fri 14:00" and "14:00 fri" are the
    // same sentence.
    const rest: string[] = [];
    for (const w of low.split(/\s+/).filter(x => x)) {
        if (looksLikeTime(w)) {
            const err = applyTime(d, w);
            if (err) {
                return { set: true, error: err };
            }
            continue;
        }
        rest.push(w);
    }

    // Then the day, then the repeater: `+2w` is both an offset and a repeater,
    // and only a day in front of it makes it the repeater.
    let day = d.day;
    let haveDay = false;
    for (const w of rest) {
        if (!haveDay) {
            const t = parseDay(w, now);
            if (t instanceof Date) {
                day = t;
                haveDay = true;
                continue;
            }
        }
        if (isRepeater(w)) {
            d.repeater = w;
            continue;
        }
        const t = parseDay(w, now);
        if (!(t instanceof Date)) {
            return { set: true, error: t };
        }
    }

    if (!haveDay) {
        if (!d.hasTime) {
            return { set: true, error: `no date in "${s}"` };
        }
        // A time with no day is today.
        return { set: true, date: d };
    }
    if (d.hasTime) {
        d.day = withDay(day, d.day);
        if (d.end) {
            d.end = withDay(day, d.end);
        }
    } else {
        d.day = day;
    }
    return { set: true, date: d };
}

function withDay(day: Date, clock: Date): Date {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), clock.getHours(), clock.getMinutes());
}

const WEEKDAY_NAMES: { [k: string]: number } = {
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
    sun: 0, sunday: 0,
};

// The next day with this weekday, today counting as one.
function forward(from: Date, wd: number): Date {
    return new Date(from.getFullYear(), from.getMonth(), from.getDate() + (wd - from.getDay() + 7) % 7);
}

// The day half: a name, an offset, or a written date. A Date, or what is
// wrong with it.
function parseDay(s: string, now: Date): Date | string {
    const today = startOfDay(now);
    const y = today.getFullYear(), mo = today.getMonth(), dd = today.getDate();
    switch (s) {
        case 'today': case 'tod': case 'now': return today;
        case 'tomorrow': case 'tom': case 'tmr': return new Date(y, mo, dd + 1);
        case 'yesterday': case 'yest': return new Date(y, mo, dd - 1);
        // Friday of this week, which is what "end of the week" means about work.
        case 'eow': case 'endofweek': return forward(today, 5);
        case 'eom': case 'endofmonth': return new Date(y, mo + 1, 0);
        case 'eoy': case 'endofyear': return new Date(y, 11, 31);
    }
    if (s in WEEKDAY_NAMES) {
        return forward(today, WEEKDAY_NAMES[s]);
    }
    // An offset needs its sign: that is what tells it from a date.
    if (s.length > 1 && (s[0] === '+' || s[0] === '-')) {
        return offset(today, s);
    }
    // Written dates, month first only.
    let m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(s);
    if (m && (s[4] === s[7])) {
        if (validDay(+m[1], +m[2], +m[3])) {
            return new Date(+m[1], +m[2] - 1, +m[3]);
        }
    }
    m = /^(\d{2})([-/])(\d{2})$/.exec(s);
    if (m && validDay(2000, +m[1], +m[3])) {
        // This year's, or next year's once this year's has gone.
        let t = new Date(y, +m[1] - 1, +m[3]);
        if (t < today) {
            t = new Date(t.getFullYear() + 1, t.getMonth(), t.getDate());
        }
        return t;
    }
    // A bare day of the month: this month's, or next month's.
    if (/^\d+$/.test(s) && +s >= 1 && +s <= 31) {
        let t = new Date(y, mo, +s);
        if (t < today) {
            t = new Date(t.getFullYear(), t.getMonth() + 1, t.getDate());
        }
        return t;
    }
    if (s.indexOf('/') >= 0 || (s.split('-').length === 2 && s.length <= 5)) {
        return `"${s}" could be two dates - write the month first, 2026-10-01 or 10-01`;
    }
    return `"${s}" is not a date I can read - try today, tomorrow, fri, +2w or 2026-10-01`;
}

function validDay(y: number, m: number, d: number): boolean {
    if (m < 1 || m > 12 || d < 1) {
        return false;
    }
    return d <= new Date(y, m, 0).getDate();
}

function offset(from: Date, s: string): Date | string {
    const sign = s[0] === '-' ? -1 : 1;
    let body = s.slice(1);
    let unit = 'd';
    const last = body[body.length - 1];
    if (last && !(last >= '0' && last <= '9')) {
        unit = last;
        body = body.slice(0, -1);
    }
    // Go's Atoi, which takes a sign of its own.
    if (!/^[+-]?\d+$/.test(body)) {
        return `"${s}" is not an offset - try +3d, +2w, +1m or +1y`;
    }
    const n = parseInt(body, 10) * sign;
    const y = from.getFullYear(), m = from.getMonth(), d = from.getDate();
    switch (unit) {
        case 'd': return new Date(y, m, d + n);
        case 'w': return new Date(y, m, d + n * 7);
        case 'm': return new Date(y, m + n, d);
        case 'y': return new Date(y + n, m, d);
    }
    return `"${s}": d, w, m or y`;
}

// A repeater as org writes one: +1w, ++1w, .+1w. Passed through as typed.
function isRepeater(w: string): boolean {
    if (w.startsWith('++') || w.startsWith('.+')) {
        return w.length > 2;
    }
    if (w.startsWith('+') && w.length > 1) {
        return 'dwmyh'.indexOf(w[w.length - 1]) >= 0;
    }
    return false;
}

function looksLikeTime(w: string): boolean {
    return w.indexOf(':') >= 0 || w.endsWith('am') || w.endsWith('pm');
}

function applyTime(d: OrgDate, w: string): string | undefined {
    const i = w.indexOf('-');
    const parts = i < 0 ? [w] : [w.slice(0, i), w.slice(i + 1)];
    const t = oneTime(parts[0]);
    if (typeof t === 'string') {
        return t;
    }
    d.day = new Date(d.day.getFullYear(), d.day.getMonth(), d.day.getDate(), t[0], t[1]);
    d.hasTime = true;
    if (parts.length === 2 && parts[1] !== '') {
        const e = oneTime(parts[1]);
        if (typeof e === 'string') {
            return e;
        }
        d.end = new Date(d.day.getFullYear(), d.day.getMonth(), d.day.getDate(), e[0], e[1]);
    }
    return undefined;
}

// 14:00, 9:30, 2pm, 2:30pm, or a bare 15 (only reached as a range's end).
function oneTime(s: string): [number, number] | string {
    let m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (m && +m[1] <= 23 && +m[2] <= 59) {
        return [+m[1], +m[2]];
    }
    m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(s);
    if (m && +m[1] >= 1 && +m[1] <= 12 && (!m[2] || +m[2] <= 59)) {
        let h = +m[1] % 12;
        if (m[3] === 'pm') {
            h += 12;
        }
        return [h, m[2] ? +m[2] : 0];
    }
    m = /^(\d{1,2})$/.exec(s);
    if (m && +m[1] <= 23) {
        return [+m[1], 0];
    }
    return `"${s}" is not a time - try 14:00, 2pm or 09:30`;
}

// A line for a prompt: what the typed text resolves to, said plainly.
// "Fri 2 Oct 2026 - <2026-10-02 Fri>", "clears the date", or the error.
export function describeWhen(input: string, now: Date = new Date()): { ok: boolean, text: string, stamp?: string } {
    const r = parseOrgDate(input, now);
    if (r.error) {
        return { ok: false, text: r.error };
    }
    if (!r.set || !r.date) {
        return { ok: true, text: 'clears the date', stamp: '' };
    }
    const s = orgDateString(r.date);
    if (r.date.raw) {
        return { ok: true, text: s, stamp: s };
    }
    const days = Math.round((startOfDay(r.date.day).getTime() - startOfDay(now).getTime()) / 86400000);
    const rel = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday'
        : days > 0 ? `in ${days} days` : `${-days} days ago`;
    return { ok: true, text: `${s}  (${rel})`, stamp: s };
}
