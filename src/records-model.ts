// The Records view's model: what a record, a collection and a birthday are
// called in the tree, which fields the edit form offers and in what order, and
// whether what was typed into it can be sent. No vscode, unit tested.
//
// A record is a heading with a RECORD property naming its collection (a
// contact, a laptop); the orgs server reads its drawer into fields that know
// what kind of thing they hold (/records, /records/fields). The format is
// docs/records.org in the orgs repo; worg's records.ts is the other client.

export interface RecordField {
    Key: string;        // as written in the drawer: PHONE_MOBILE
    Name: string;       // PHONE
    Label: string;      // MOBILE, or ''
    Kind: string;       // email | tel | url | social | date | image | postal | text
    Value: string;
    Link?: string;
    Network?: string;
}

export interface OrgRecord {
    Hash: string;
    Id?: string;
    Type: string;
    Name: string;
    Filename: string;
    LineNum: number;    // 0-based
    Tags?: string[] | null;
    Fields?: RecordField[] | null;
    Props?: { [key: string]: string } | null;
    Notes?: string;
    Image?: string;
    Added?: string;
    Updated?: string;
}

export interface RecordCollection {
    Type: string;
    Name: string;
    Icon: string;
    Fields?: string[] | null;   // the keys the collection declares, in order
    Hash: string;
    Filename: string;
    LineNum: number;
    Count: number;
}

export interface RecordFieldUse {
    Key: string;
    Name: string;
    Label: string;
    Kind: string;
    Count: number;
}

export interface BirthdayEvent {
    Hash: string;
    Name: string;
    Type: string;
    Filename: string;
    LineNum: number;
    Date: string;       // the occurrence, YYYY-MM-DD
    Birthday: string;   // as the record writes it
    Age: number;        // turning, or 0 with no year
    Field: string;      // BIRTHDAY, ANNIVERSARY
}

export interface RecordUpdate {
    Hash: string;
    Set: { [key: string]: string };
    Name?: string;
    SetName?: boolean;
    Notes?: string;
    SetNotes?: boolean;
}

export interface RecordNew {
    Type: string;
    Name: string;
    Fields: { [key: string]: string };
    Notes?: string;
}

// The drawer's bookkeeping, which the server writes itself and the form
// leaves alone.
export const BOOKKEEPING = ['RECORD', 'ID', 'ADDED'];

// ── The tree ────────────────────────────────────────────────────────────────

export function collectionLabel(c: RecordCollection): string {
    const name = c.Name || c.Type;
    return c.Icon ? `${c.Icon} ${name}` : name;
}

export function recordLabel(r: { Name: string }): string {
    return (r.Name || '').trim() || '(untitled)';
}

// The kinds worth a glance in a list row, in the order a reader reaches for
// them, when the collection does not say which fields are its keys.
const KIND_ORDER: { [kind: string]: number } = {
    tel: 1, email: 2, social: 3, url: 4, postal: 5, date: 6, text: 7, image: 9,
};

// Fields in the order to show them: the kinds a reader reaches for first,
// otherwise as the drawer has them.
export function sortFields(fields: RecordField[]): RecordField[] {
    const rank = (f: RecordField) => KIND_ORDER[f.Kind] === undefined ? 8 : KIND_ORDER[f.Kind];
    return fields.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map(x => x.f);
}

// The line beside a record's name: the collection's own key fields when it
// declares some (a laptop's MAKER and MODEL), else its first phone and email.
export function recordDescription(r: OrgRecord, keys: string[] = [], most = 2): string {
    const fields = (r.Fields || []).filter(f => (f.Value || '').trim() !== '' && f.Kind !== 'image');
    const byKey = new Map(fields.map(f => [f.Key.toUpperCase(), f] as [string, RecordField]));
    let picked = keys.map(k => byKey.get(k.toUpperCase())).filter(f => f) as RecordField[];
    if (picked.length === 0) {
        picked = sortFields(fields);
    }
    return picked.slice(0, most).map(f => oneLine(f.Value)).join(' · ');
}

// Every field as a tooltip shows it: "phone · mobile: +1 555".
export function fieldLabel(f: { Name: string; Label: string }): string {
    const name = f.Name.toLowerCase();
    return f.Label ? `${name} · ${f.Label.toLowerCase()}` : name;
}

export function recordTooltip(r: OrgRecord): string {
    const lines = [recordLabel(r)];
    sortFields(r.Fields || []).filter(f => f.Kind !== 'image' && f.Value).forEach(f => lines.push(`${fieldLabel(f)}: ${oneLine(f.Value)}`));
    if (r.Tags && r.Tags.length) {
        lines.push(':' + r.Tags.join(':') + ':');
    }
    return lines.join('\n');
}

function oneLine(s: string): string {
    return (s || '').replace(/\s*\n\s*/g, ', ').trim();
}

// Records by name, case-blind, the way a person looks one up.
export function sortRecords<T extends { Name: string }>(rs: T[]): T[] {
    return [...rs].sort((a, b) => recordLabel(a).localeCompare(recordLabel(b), undefined, { sensitivity: 'base' }));
}

// ── Birthdays ───────────────────────────────────────────────────────────────

function dayOf(iso: string): number | undefined {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : undefined;
}

export function isoDay(d: Date): string {
    const p = (n: number) => (n < 10 ? '0' : '') + n;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Days from today (YYYY-MM-DD) to an occurrence; undefined for a bad date.
export function daysUntil(date: string, today: string): number | undefined {
    const a = dayOf(today), b = dayOf(date);
    return a === undefined || b === undefined ? undefined : Math.round(b - a);
}

export function whenLabel(days: number | undefined): string {
    if (days === undefined) {
        return '';
    }
    return days === 0 ? 'today' : days === 1 ? 'tomorrow' : days < 0 ? `${-days} days ago` : `in ${days} days`;
}

export function birthdayLabel(b: BirthdayEvent): string {
    const what = (b.Field || 'BIRTHDAY').toUpperCase() === 'ANNIVERSARY' ? 'anniversary' : 'birthday';
    if (what === 'birthday' && b.Age > 0) {
        return `${recordLabel(b)} turns ${b.Age}`;
    }
    return `${recordLabel(b)}'s ${what}` + (b.Age > 0 ? ` (${b.Age} years)` : '');
}

export function birthdayDescription(b: BirthdayEvent, today: string): string {
    return [whenLabel(daysUntil(b.Date, today)), b.Date].filter(s => s).join(' · ');
}

// The ones within `days` of today, soonest first.
export function upcoming(bs: BirthdayEvent[], today: string, days: number): BirthdayEvent[] {
    return bs
        .map(b => ({ b, d: daysUntil(b.Date, today) }))
        .filter(x => x.d !== undefined && x.d >= 0 && x.d <= days)
        .sort((x, y) => x.d - y.d || recordLabel(x.b).localeCompare(recordLabel(y.b)))
        .map(x => x.b);
}

// ── The form ────────────────────────────────────────────────────────────────

export interface FormField {
    key: string;
    label: string;
    kind: string;
    value: string;
}

export function normKey(k: string): string {
    return (k || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function validKey(k: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(k) && BOOKKEEPING.indexOf(k) < 0;
}

// The fields the form shows, in order: the collection's declared fields, then
// what the record already carries (as its drawer has them), then the rest the
// collection's records use, most used first. Bookkeeping is left out.
export function formFields(uses: RecordFieldUse[], rec?: OrgRecord, declared: string[] = []): FormField[] {
    const out: FormField[] = [];
    const seen = new Set<string>();
    const have = new Map<string, RecordField>();
    (rec && rec.Fields || []).forEach(f => have.set(f.Key.toUpperCase(), f));
    const use = new Map<string, RecordFieldUse>();
    uses.forEach(u => use.set(u.Key.toUpperCase(), u));
    const add = (key: string) => {
        const k = key.toUpperCase();
        if (seen.has(k) || BOOKKEEPING.indexOf(k) >= 0 || !k) {
            return;
        }
        seen.add(k);
        const f = have.get(k), u = use.get(k);
        const name = (f && f.Name) || (u && u.Name) || k.replace(/_/g, ' ');
        const label = (f && f.Label) || (u && u.Label) || '';
        out.push({ key: k, label: fieldLabel({ Name: name, Label: label }), kind: (f && f.Kind) || (u && u.Kind) || 'text', value: f ? f.Value : '' });
    };
    declared.forEach(add);
    (rec && rec.Fields || []).forEach(f => add(f.Key));
    [...uses].sort((a, b) => b.Count - a.Count).forEach(u => add(u.Key));
    return out;
}

// What the form's input for a kind of field is.
export function inputType(kind: string): 'email' | 'tel' | 'url' | 'textarea' | 'text' {
    switch (kind) {
        case 'email': return 'email';
        case 'tel': return 'tel';
        case 'url': return 'url';
        case 'postal': return 'textarea';
        default: return 'text';
    }
}

// The three ways a record may write a yearly date (as the server reads them):
// an ISO date, the same in an org timestamp, and vCard's year-less --MM-DD.
export function validDate(v: string): boolean {
    const s = v.trim();
    const m = /^-{1,2}(\d{2})-(\d{2})$/.exec(s) || /(?:^|[<\[])\d{4}-(\d{2})-(\d{2})/.exec(s);
    if (!m) {
        return false;
    }
    const month = +m[1], day = +m[2];
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export interface FormValues {
    name: string;
    notes?: string;
    fields: { [key: string]: string };
    // Fields typed into the "another field" rows: key as typed.
    extra?: { key: string; value: string }[];
}

// What is wrong with the form, by input: 'name', a field key, or 'extra:<i>'.
// Empty when it can be sent. Kinds are the form's (formFields); a field the
// form does not know the kind of is text.
export function validateForm(v: FormValues, kinds: { [key: string]: string }): { [input: string]: string } {
    const errs: { [input: string]: string } = {};
    if (!(v.name || '').trim()) {
        errs.name = 'A record needs a name.';
    }
    const check = (input: string, kind: string, value: string) => {
        const s = (value || '').trim();
        if (!s) {
            return;
        }
        if (kind === 'email' && !/^[^\s@]+@[^\s@]+$/.test(s)) {
            errs[input] = 'Not an email address.';
        } else if (kind === 'date' && !validDate(s)) {
            errs[input] = 'Write a date as 2026-05-15, <2026-05-15 Fri> or --05-15.';
        } else if ((kind === 'url' || kind === 'image') && /\s/.test(s)) {
            errs[input] = 'A link has no spaces in it.';
        } else if (kind === 'tel' && !/^[+()0-9.\-\s\/x#*]+$/i.test(s)) {
            errs[input] = 'Not a phone number.';
        }
    };
    Object.keys(v.fields || {}).forEach(k => check(k, kinds[k] || 'text', v.fields[k]));
    const keys = new Set(Object.keys(v.fields || {}));
    (v.extra || []).forEach((x, i) => {
        const k = normKey(x.key);
        if (!k && !(x.value || '').trim()) {
            return;
        }
        if (!validKey(k)) {
            errs['extra:' + i] = k && BOOKKEEPING.indexOf(k) >= 0
                ? `${k} is kept by the server.`
                : 'A field name is letters, digits and _, starting with a letter.';
        } else if (keys.has(k)) {
            errs['extra:' + i] = `${k} is already on the form.`;
        } else {
            keys.add(k);
        }
    });
    return errs;
}

// Every field the form ends up with, extra rows folded in, keys normalised.
export function allValues(v: FormValues): { [key: string]: string } {
    const out: { [key: string]: string } = {};
    Object.keys(v.fields || {}).forEach(k => out[k.toUpperCase()] = (v.fields[k] || '').trim());
    (v.extra || []).forEach(x => {
        const k = normKey(x.key);
        if (k) {
            out[k] = (x.value || '').trim();
        }
    });
    return out;
}

// The /record/update body for an edit: only what changed, a field emptied
// being a field taken off. Undefined when nothing did.
export function updateRequest(rec: OrgRecord, v: FormValues): RecordUpdate | undefined {
    const was = new Map<string, string>();
    (rec.Fields || []).forEach(f => was.set(f.Key.toUpperCase(), f.Value || ''));
    const now = allValues(v);
    const set: { [key: string]: string } = {};
    Object.keys(now).forEach(k => {
        if ((was.get(k) || '').trim() !== now[k]) {
            set[k] = now[k];
        }
    });
    const req: RecordUpdate = { Hash: rec.Hash, Set: set };
    const name = (v.name || '').trim();
    if (name && name !== (rec.Name || '').trim()) {
        req.SetName = true;
        req.Name = name;
    }
    if (v.notes !== undefined && v.notes.trim() !== (rec.Notes || '').trim()) {
        req.SetNotes = true;
        req.Notes = v.notes;
    }
    return Object.keys(set).length || req.SetName || req.SetNotes ? req : undefined;
}

// The POST /record body for a new one: the fields that have something in them.
export function newRequest(type: string, v: FormValues): RecordNew {
    const all = allValues(v);
    const fields: { [key: string]: string } = {};
    Object.keys(all).filter(k => all[k]).forEach(k => fields[k] = all[k]);
    const req: RecordNew = { Type: type, Name: (v.name || '').trim(), Fields: fields };
    if (v.notes && v.notes.trim()) {
        req.Notes = v.notes;
    }
    return req;
}
