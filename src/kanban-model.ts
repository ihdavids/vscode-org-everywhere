// The kanban board's model, ported from worg (worg/src/kanban.ts) and said a
// third time beside its Go twin (orgs cmd/oc/commands/kanban/model.go): which
// column a heading lands in, what colour it gets and how the cards within a
// column are ordered. The three share their test scenarios
// (test/kanban.test.ts, kanban.test.ts, model_test.go), so change one and
// change all three.
//
// Everything here is a pure function of a board and the headings a query found,
// because a board owns nothing in the org files - it is a way of looking at
// them. The one thing a board writes is manual order, and that goes onto the
// heading as a property. No vscode import: this runs under plain node.

// One column of a board. Value is what puts a card here, read against whatever
// the board groups by: the property's value, the tag, or the todo keyword.
export type KanbanColumn = {
    value: string;
    title: string;
    color: string;
    limit: number;
    // Drawn folded; worked out from the board's `folded` list.
    collapsed: boolean;
    // Other spellings this column also claims (INPROGRESS for IN-PROGRESS).
    aliases?: string[];
};

// A saved board (GET /ext/kanban/boards): where its cards come from, what
// splits them into columns and how they are drawn. It holds no cards.
export type KanbanBoard = {
    name: string;
    storedQuery: string;
    query: string;
    includeArchived: boolean;
    groupBy: 'property' | 'tag' | 'status';
    groupKey: string;
    columns: KanbanColumn[];
    showUnset: boolean;
    unsetTitle: string;
    colorBy: 'none' | 'property' | 'tag' | 'status' | 'priority';
    colorKey: string;
    colors: Record<string, string>;
    headerKey: string;
    headerColors: Record<string, string>;
    layout: 'board' | 'list';
    listFields: string[];
    labelSource: 'none' | 'tags' | 'property';
    labelKey: string;
    labelColors: Record<string, string>;
    labelOrder: string[];
    hidden: string[];
    folded: string[];
    // Property names shown as chips on the card.
    badges: string[];
    backShows: 'body' | 'properties' | 'both';
    sort: 'headline' | 'priority' | 'deadline' | 'scheduled' | 'file' | 'manual';
    orderKey: string;
};

// A date off the server read as the wall-clock time it was written as (worg's
// orgtime.ts): an org date is a date on the calendar, not an instant, so the
// offset is ignored rather than trusted to agree with this machine's rules.
export function orgMoment(s: string | null | undefined): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s || '');
    if (!m) return new Date(s ? Date.parse(s) : NaN);
    return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
}

// A heading as /search hands it back. Only the fields a card can show are
// named; the server sends more.
export type Card = {
    Hash: string;
    Headline: string;
    Status: string;
    Priority: string;
    Tags: string[] | null;
    Props: Record<string, string> | null;
    Filename: string;
    LineNum: number;
    Level: number;
    Date?: { Start?: string; End?: string } | null;
    Deadline?: { Start?: string; End?: string } | null;
};

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

// One hue per entry, each chosen to read against both the light and the dark
// page. A card wears its colour as a stripe at full strength and a wash of the
// same colour behind it, so the hue has to sit in the middle of its range
// rather than at either end - a pastel vanishes on white and a deep tone
// vanishes on black.
export type Swatch = { key: string; label: string; hex: string };

export const PALETTE: Swatch[] = [
    { key: 'slate', label: 'Slate', hex: '#6b7280' },
    { key: 'red', label: 'Red', hex: '#e5484d' },
    { key: 'orange', label: 'Orange', hex: '#f76808' },
    { key: 'amber', label: 'Amber', hex: '#f5a524' },
    { key: 'lime', label: 'Lime', hex: '#8db421' },
    { key: 'green', label: 'Green', hex: '#30a46c' },
    { key: 'teal', label: 'Teal', hex: '#12a594' },
    { key: 'cyan', label: 'Cyan', hex: '#0d9bbd' },
    { key: 'blue', label: 'Blue', hex: '#3e63dd' },
    { key: 'indigo', label: 'Indigo', hex: '#5b5bd6' },
    { key: 'violet', label: 'Violet', hex: '#8e4ec6' },
    { key: 'pink', label: 'Pink', hex: '#d6409f' },
];

const BY_KEY: Record<string, Swatch> = {};
PALETTE.forEach(s => { BY_KEY[s.key] = s; });

export function swatch(key: string): Swatch {
    return BY_KEY[key] || PALETTE[0];
}

// A stable colour for a value nobody has chosen one for. The same spelling
// always lands on the same hue, which is the whole point: a board that has
// never been configured still reads as a board, and a value keeps its colour
// between sessions and between browsers.
export function autoSwatch(value: string): Swatch {
    const v = value.trim().toLowerCase();
    if (v === '') return PALETTE[0];
    let h = 0;
    for (let i = 0; i < v.length; i++) {
        h = (h * 31 + v.charCodeAt(i)) >>> 0;
    }
    // Slate is the colour of having no value, so an auto colour never takes it.
    return PALETTE[1 + (h % (PALETTE.length - 1))];
}

// ---------------------------------------------------------------------------
// The bar across the top of a card
// ---------------------------------------------------------------------------
//
// A card wears a thin header whose colour comes from one of its properties. By
// default that property is its own `:COLOUR:` and the value is read as the name
// of a colour, so a card can be given one by writing `:COLOUR: teal` in the org
// file and nothing has to be configured at all. A board can name a different
// property instead and map that property's values to colours by hand - so
// `:CLIENT: Acme` can be blue without anybody having to call it blue.
//
// A card with nothing to say gets a grey that is darker than the card: it has
// to read as "no colour" rather than as one.

// The properties the default looks in. Both spellings, because which one an org
// file uses is a matter of where its author went to school.
export const DEFAULT_HEADER_KEYS = ['COLOUR', 'COLOR'];

export const HEADER_NONE_DARK = '#4b5563';
export const HEADER_NONE_LIGHT = '#9ca3af';

// Colour names people actually write, pointed at the palette. The palette's own
// keys work too, so "teal" needs no entry.
const COLOR_WORDS: Record<string, string> = {
    grey: 'slate', gray: 'slate', silver: 'slate',
    purple: 'violet', magenta: 'pink', fuchsia: 'pink', rose: 'pink',
    yellow: 'amber', gold: 'amber', mustard: 'amber',
    turquoise: 'teal', aqua: 'cyan', sky: 'cyan',
    navy: 'indigo', royal: 'indigo',
    maroon: 'red', crimson: 'red', scarlet: 'red',
    olive: 'lime', emerald: 'green', forest: 'green',
};

// What a card says about its header, or '' when it says nothing.
export function headerValueOf(card: Card, board: KanbanBoard): string {
    const props = card.Props || {};
    const key = (board.headerKey || '').trim();
    if (key !== '') return (props[key.toUpperCase()] || props[key] || '').trim();
    for (const k of DEFAULT_HEADER_KEYS) {
        const v = (props[k] || '').trim();
        if (v !== '') return v;
    }
    return '';
}

// The header's colour. `dark` only decides the shade of "nothing said" - every
// other answer is a colour somebody chose.
export function headerColorOf(card: Card, board: KanbanBoard, dark: boolean = true): string {
    const value = headerValueOf(card, board);
    if (value === '') return dark ? HEADER_NONE_DARK : HEADER_NONE_LIGHT;

    // What the board was told, first: a mapping set up for this board beats
    // whatever the value happens to spell.
    const mapped = board.headerColors && board.headerColors[value];
    if (mapped) return mapped.charAt(0) === '#' ? mapped : swatch(mapped).hex;

    return colorFromWord(value);
}

// A value read as a colour: a palette name, a word people use for one, or a
// hex code written out. Anything else gets a colour of its own, stable for
// that spelling - better than grey, which is reserved for saying nothing.
export function colorFromWord(value: string): string {
    const v = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    if (/^#[0-9a-f]{3}$/i.test(v)) {
        return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    }
    const named = COLOR_WORDS[v] || v;
    const hit = PALETTE.find(p => p.key === named || p.label.toLowerCase() === named);
    if (hit) return hit.hex;
    return autoSwatch(value).hex;
}

// ---------------------------------------------------------------------------
// The coloured bars across a card
// ---------------------------------------------------------------------------
//
// Trello's labels, said in org. A card wears a small bar per label, and a
// label is either one of the heading's tags or one value of a property that
// holds several - which is why a property's value is read as a list rather
// than as a word. Tags are the natural fit and the default; a property is
// there for the boards where the categories are not things you want in the
// agenda's tag list.
//
// `labelOrder` is the set the board is about. A heading can carry a tag the
// board has never heard of - it just gets no bar - but the card's own menu
// offers this list, so adding a label is picking from a few rather than
// typing one and hoping it matches.

// How a property holding several labels is split. Commas or spaces, because
// both get written and neither is a label on its own.
export function splitLabels(v: string): string[] {
    return (v || '').split(/[,\s]+/).map(s => s.trim()).filter(s => s !== '');
}

// The labels a heading actually carries, in the board's own order so that two
// cards with the same labels wear them the same way round.
export function labelsOf(card: Card, board: KanbanBoard): string[] {
    if (board.labelSource === 'none') return [];
    const have = board.labelSource === 'tags'
        ? (card.Tags || [])
        : splitLabels(((card.Props || {})[(board.labelKey || '').toUpperCase()]) || '');
    const set: Record<string, boolean> = {};
    for (const v of have) set[v] = true;
    const order = board.labelOrder || [];
    const out = order.filter(v => set[v]);
    // Anything the heading carries that the board never named goes after the
    // ones it did, so a tag added in the editor still shows rather than being
    // silently dropped.
    for (const v of have) if (order.indexOf(v) < 0 && out.indexOf(v) < 0) out.push(v);
    return out;
}

// What colour a label is drawn. A value nobody has picked a colour for gets
// one from its own spelling, the same rule the card stripe uses, so a board
// that has never been configured still reads as a board.
export function labelColorOf(value: string, board: KanbanBoard): string {
    const named = (board.labelColors || {})[value];
    if (named) return named.charAt(0) === '#' ? named : swatch(named).hex;
    return autoSwatch(value).hex;
}

// Every label worth offering: the board's own set, plus anything the cards on
// it actually carry.
export function labelsInCards(cards: Card[], board: KanbanBoard): string[] {
    const out = (board.labelOrder || []).slice();
    if (board.labelSource !== 'none') {
        for (const c of cards) {
            for (const v of labelsOf(c, board)) if (out.indexOf(v) < 0) out.push(v);
        }
    }
    return out;
}

// The value a card is coloured by, given what the board said to colour by.
export function colorValueOf(card: Card, board: KanbanBoard): string {
    switch (board.colorBy) {
        case 'property': return (card.Props && card.Props[board.colorKey]) || '';
        case 'status': return card.Status || '';
        case 'priority': return card.Priority || '';
        case 'tag': {
            const tags = card.Tags || [];
            // The first tag with a colour of its own, so a card carrying both
            // a project tag and a context one shows whichever the board named.
            for (const t of tags) {
                if (board.colors && board.colors[t]) return t;
            }
            return tags.length > 0 ? tags[0] : '';
        }
        default: return '';
    }
}

// The colour a card is drawn in, or null when the board colours nothing.
export function cardSwatch(card: Card, board: KanbanBoard): Swatch | null {
    if (!board.colorBy || board.colorBy === 'none') return null;
    const value = colorValueOf(card, board);
    if (value === '') return null;
    const named = board.colors ? board.colors[value] : '';
    return named ? swatch(named) : autoSwatch(value);
}

// A hex colour at a fraction of its opacity, for the wash behind a card. Kept
// as an rgba() rather than a lightened hex so it tints whatever page it is
// laid on - cream in light mode, near black in dark - instead of fighting it.
export function tint(hex: string, alpha: number): string {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

// Every value of a card that a column could match. A property or a status is
// one value; tags are all of them, which is why a card can be claimed by more
// than one tag column and has to be given to the first that asks.
export function groupValuesOf(card: Card, board: KanbanBoard): string[] {
    switch (board.groupBy) {
        case 'property': {
            const v = (card.Props && card.Props[board.groupKey]) || '';
            return v === '' ? [] : [v];
        }
        case 'tag':
            return card.Tags || [];
        case 'status':
        default: {
            const v = card.Status || '';
            return v === '' ? [] : [v];
        }
    }
}

function sameValue(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// The column value a card belongs to, or '' when no column claims it. Columns
// are asked in board order, so where a column sits is part of what it means:
// with tag columns "urgent" and "work", a card tagged both lands in whichever
// the board lists first.
// Which column a card belongs in. `cols` is the columns actually on the board -
// which is not always `board.columns`, because a board that has been given none
// of its own is showing columns worked out from the server's states and the
// query. Reading the stored list here rather than the shown one put every card
// in the catch-all on exactly those boards.
export function columnOf(card: Card, board: KanbanBoard, cols?: KanbanColumn[]): string {
    const values = groupValuesOf(card, board);
    if (values.length === 0) return '';
    for (const col of cols ?? board.columns) {
        if (col.value === '') continue;
        // A column claims its own spelling and any it has been told is the
        // same thing, so a card saying INPROGRESS lands in the IN-PROGRESS
        // column rather than falling through to the catch-all.
        const claims = columnValues(col);
        if (values.some(v => claims.some(c => sameValue(v, c)))) return col.value;
    }
    return '';
}

// The catch-all column, appended rather than stored, so that turning it off and
// on again cannot lose a column somebody had configured.
export const UNSET = '';

// Every spelling a column answers to, its own first.
export function columnValues(col: KanbanColumn): string[] {
    const out = [col.value];
    for (const a of col.aliases || []) {
        const v = a.trim();
        if (v !== '' && !out.some(x => sameValue(x, v))) out.push(v);
    }
    return out;
}

// Two spellings of the same word. Case, spaces, hyphens and underscores are
// noise here: IN-PROGRESS, INPROGRESS, in_progress and "In Progress" are one
// state that four people typed four ways, and a board that shows them as four
// columns is showing typing rather than work.
export function canonicalValue(v: string): string {
    return v.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

export function unsetColumn(board: KanbanBoard): KanbanColumn {
    return {
        value: UNSET,
        title: board.unsetTitle || defaultUnsetTitle(board),
        color: 'slate',
        limit: 0,
        collapsed: false,
        aliases: [],
    };
}

export function defaultUnsetTitle(board: KanbanBoard): string {
    switch (board.groupBy) {
        case 'property': return board.groupKey ? `No ${board.groupKey}` : 'No value';
        case 'tag': return 'Untagged';
        default: return 'No status';
    }
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

const PRIORITIES = 'ABCDEFG';

function priorityRank(p: string): number {
    // No priority sorts after every priority rather than before, because an
    // unprioritised card is not the most important thing in the column. Asked
    // for outright rather than left to indexOf, which answers 0 - the rank of
    // [#A] - when handed the empty string.
    const c = (p || '').trim().toUpperCase();
    if (c === '') return 99;
    const i = PRIORITIES.indexOf(c);
    return i < 0 ? 98 : i;
}

// An org date as a sortable number. The zero time go-org writes for a date
// nobody set sorts last, along with everything else that has no date.
function dateRank(d?: { Start?: string } | null): number {
    if (!d || !d.Start || d.Start.startsWith('0001-01-01')) return Number.MAX_SAFE_INTEGER;
    const t = orgMoment(d.Start).getTime();
    return isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

// ---------------------------------------------------------------------------
// The list layout
// ---------------------------------------------------------------------------
//
// The same board drawn as one grouped list rather than a row of columns: the
// groups are the columns, in the same order, and a row is a card. Everything
// underneath is shared - which group a heading is in, what order the rows are
// in, and what a drag writes are the board's answers, not the layout's, so a
// board can be read either way round without either view knowing about the
// other.
//
// What a list adds is fields: the columns of the table beside a heading. They
// are named here rather than in the component so that a board can be checked
// for asking after a field that does not exist, and so the settings dialog and
// the table cannot disagree about what one is called.

export interface ListField {
    key: string;
    label: string;
    // Width in pixels of the field's column. The headline takes what is left.
    width: number;
    // The board sort this field's heading switches to when it is clicked, for
    // the fields a sort exists for.
    sort?: KanbanBoard['sort'];
    // Right-aligned, for the ones that read as a quantity rather than a name.
    right?: boolean;
}

// The keyword is in this list so that a board saved with it still reads, and
// so that `listField('status')` has something to say - but it is never offered
// as a field to add, and the list filters it out of the fields it lays out.
// See PINNED_FIELDS.
export const LIST_FIELDS: ListField[] = [
    { key: 'status', label: 'Keyword', width: 116 },
    { key: 'priority', label: 'Priority', width: 74, sort: 'priority' },
    { key: 'deadline', label: 'Deadline', width: 104, sort: 'deadline' },
    { key: 'scheduled', label: 'Scheduled', width: 104, sort: 'scheduled' },
    { key: 'tags', label: 'Tags', width: 150 },
    { key: 'file', label: 'File', width: 130, sort: 'file' },
];

// What a list shows before anybody has said. The keyword is not among them:
// it has a column of its own at the front of every row, because a todo list is
// read down that column rather than across to it.
export const DEFAULT_LIST_FIELDS = ['priority', 'deadline', 'tags'];

// Fields that are not the board's to arrange: they have a fixed place in the
// row and are drawn whether or not anybody asked for them.
export const PINNED_FIELDS = ['status'];

// A property shown as a field of its own is written `prop:NAME`.
export const PROP_FIELD = 'prop:';

// The field a key names. A property is given a column on the spot, so a board
// may ask for any property without it having to be registered anywhere.
export function listField(key: string): ListField {
    const k = (key || '').trim();
    if (k.slice(0, PROP_FIELD.length) === PROP_FIELD) {
        const name = k.slice(PROP_FIELD.length).toUpperCase();
        return { key: `${PROP_FIELD}${name}`, label: name, width: 120 };
    }
    for (const f of LIST_FIELDS) if (f.key === k) return f;
    // An unknown key is shown as itself rather than dropped: a board that has
    // asked for something this version does not have should say so on screen,
    // not quietly show one fewer column than it was set up with.
    return { key: k, label: k, width: 120 };
}

// The fields a board's list lays out, in order, with anything it names twice
// counted once.
export function listFieldsOf(board: KanbanBoard): ListField[] {
    const out: ListField[] = [];
    const seen: Record<string, boolean> = {};
    for (const key of board.listFields || []) {
        const f = listField(key);
        if (seen[f.key]) continue;
        seen[f.key] = true;
        out.push(f);
    }
    return out;
}

// A field as plain text - what it is worth searching, sorting by hand or
// putting in a tooltip. The table draws the ones that have a shape of their
// own (keywords, priorities, tags) as chips instead, but this is what they
// say.
export function listFieldText(card: Card, key: string): string {
    const k = (key || '').trim();
    if (k.slice(0, PROP_FIELD.length) === PROP_FIELD) {
        const name = k.slice(PROP_FIELD.length).toUpperCase();
        return ((card.Props || {})[name] || '').trim();
    }
    switch (k) {
        case 'status': return card.Status || '';
        case 'priority': return card.Priority || '';
        case 'deadline': return dateText(card.Deadline);
        case 'scheduled': return dateText(card.Date);
        case 'tags': return (card.Tags || []).join(' ');
        case 'file': return (card.Filename || '').split('/').pop() || '';
    }
    return '';
}

function dateText(d?: { Start?: string } | null): string {
    if (!d || !d.Start || d.Start.slice(0, 10) === '0001-01-01') return '';
    return d.Start.slice(0, 10);
}

// What a card's manual order property says, or null when it says nothing.
export function orderOf(card: Card, board: KanbanBoard): number | null {
    const key = board.orderKey || 'KANBAN';
    const raw = card.Props ? card.Props[key] : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const n = Number(raw);
    return isNaN(n) ? null : n;
}

// The cards of one column, in the order the board asks for. Stable: two cards
// the sort cannot tell apart keep the order the query returned them in, so a
// board does not reshuffle itself under a refresh.
export function sortCards(cards: Card[], board: KanbanBoard): Card[] {
    const decorated = cards.map((c, i) => ({ c, i }));
    const cmp = (a: { c: Card; i: number }, b: { c: Card; i: number }): number => {
        let d = 0;
        switch (board.sort) {
            case 'headline':
                d = a.c.Headline.localeCompare(b.c.Headline);
                break;
            case 'priority':
                d = priorityRank(a.c.Priority) - priorityRank(b.c.Priority);
                if (d === 0) d = a.c.Headline.localeCompare(b.c.Headline);
                break;
            case 'deadline':
                d = dateRank(a.c.Deadline) - dateRank(b.c.Deadline);
                break;
            case 'scheduled':
                d = dateRank(a.c.Date) - dateRank(b.c.Date);
                break;
            case 'file':
                d = a.c.Filename.localeCompare(b.c.Filename);
                if (d === 0) d = a.c.LineNum - b.c.LineNum;
                break;
            case 'manual':
            default: {
                const ao = orderOf(a.c, board);
                const bo = orderOf(b.c, board);
                // A card nobody has dragged yet waits at the end of the column
                // rather than jumping to the top of it.
                if (ao === null && bo === null) d = 0;
                else if (ao === null) d = 1;
                else if (bo === null) d = -1;
                else d = ao - bo;
                break;
            }
        }
        return d !== 0 ? d : a.i - b.i;
    };
    decorated.sort(cmp);
    return decorated.map(d => d.c);
}

// The order value for a card dropped between two others.
//
// Only the card that moved is written: the midpoint of its new neighbours is a
// number no other card in the column has, so the rest of them are left alone
// and a drop costs one write rather than one per card. null means the gap has
// run out of room - two neighbours whose numbers are adjacent in floating point
// - and the column has to be renumbered.
export function orderBetween(prev: number | null, next: number | null): number | null {
    if (prev === null && next === null) return 0;
    if (prev === null) return (next as number) - 1;
    if (next === null) return prev + 1;
    const mid = (prev + next) / 2;
    if (mid <= prev || mid >= next) return null;
    return mid;
}

// Order values written to a property have to be read back by anything else
// looking at the file, so they are kept short rather than printed at full
// floating point precision.
export function formatOrder(n: number): string {
    if (Number.isInteger(n)) return String(n);
    return String(Number(n.toFixed(6)));
}

// Whole numbers spread across a column, for the renumbering that orderBetween
// asks for when a gap runs out.
export function renumber(count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(i * 100);
    return out;
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

// Everything about a card the board's own search box looks through - not what
// the card is currently showing, or folding a card away would hide the very
// heading somebody was searching for.
export function haystack(card: Card): string {
    const props = card.Props ? Object.keys(card.Props).map(k => `${k} ${card.Props![k]}`).join(' ') : '';
    const tags = (card.Tags || []).join(' ');
    return `${card.Headline} ${card.Status} ${tags} ${props} ${card.Filename}`.toLowerCase();
}

// Every word has to turn up somewhere, which is what makes a search like
// "spec draft ian" work.
export function cardMatches(card: Card, terms: string[]): boolean {
    if (terms.length === 0) return true;
    const hay = haystack(card);
    return terms.every(t => hay.indexOf(t) >= 0);
}

export function searchTerms(text: string): string[] {
    return text.toLowerCase().split(/\s+/).filter(t => t !== '');
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Columns a board starts with
// ---------------------------------------------------------------------------
//
// A board split by the todo keyword does not need to be told what its columns
// are: the server already knows which keywords it accepts, and the query knows
// which ones are actually in use. So a board with no columns of its own reads
// them off those two rather than showing an empty page and asking.
//
// The server's list is the spine - in the order it was configured in, because
// that order is the order the states are meant to be read in - and anything the
// query turns up that the configuration never mentioned is added after it
// rather than folded into it.

// The hues a default column takes, kept in two families so that finished work
// and work still going read apart at a glance. Walked in order and wrapped, so
// a long list of states never runs out of colours.
const DONE_HUES = ['green', 'teal', 'lime'];
const ACTIVE_HUES = ['blue', 'indigo', 'violet', 'pink', 'amber', 'orange', 'red', 'cyan'];

export interface TodoStateList {
    active: string[];
    done: string[];
}

// The columns a status board shows when it has none of its own.
//
// Left to right: the states still in play, in the order they were configured,
// then anything the query is using that the configuration never mentioned, then
// the finished states last. A board reads as work travelling rightwards, so
// finished work belongs at the right-hand end and the strays belong just before
// it - they are states somebody is using, and nothing says where in the run
// they go, only that they are not finished.
export function defaultStatusColumns(
    states: TodoStateList,
    discovered: string[] = [],
): KanbanColumn[] {
    // Grouped by canonical spelling rather than by exact text, so IN-PROGRESS
    // and INPROGRESS arrive as one column with the other as its alias instead
    // of as two columns holding half the work each. The first spelling met is
    // the one the column is called and the one a plain drop writes.
    const seen = new Map<string, string[]>();
    const take = (list: string[]) => {
        const primaries: string[] = [];
        for (const raw of list) {
            const v = raw.trim();
            if (v === '') continue;
            const k = canonicalValue(v);
            const had = seen.get(k);
            if (had) {
                if (!had.some(x => sameValue(x, v))) had.push(v);
                continue;
            }
            seen.set(k, [v]);
            primaries.push(v);
        }
        return primaries;
    };

    // Active first, so that a state named on both sides of two different
    // sequences is claimed by the group it is drawn in first - and so the
    // colours walk their family in display order.
    const active = take(states.active);
    const done = take(states.done);
    // Whatever the query found that the configuration never mentioned. It goes
    // last, because there is nothing to say where in the run of states it
    // belongs - only that somebody is using it.
    const extra = take(discovered);

    const col = (value: string, color: string): KanbanColumn => ({
        value,
        title: '',
        color,
        limit: 0,
        collapsed: false,
        // Everything else that turned out to be this same word.
        aliases: (seen.get(canonicalValue(value)) || []).filter(v => !sameValue(v, value)),
    });

    // Built only now that every list has been walked: a spelling met late -
    // one the query turned up - is an alias of a column made early, and the
    // column cannot be told about it before it has been seen.
    return [
        ...active.map((v, i) => col(v, ACTIVE_HUES[i % ACTIVE_HUES.length])),
        ...extra.map((v, i) => col(v, ACTIVE_HUES[(active.length + i) % ACTIVE_HUES.length])),
        ...done.map((v, i) => col(v, DONE_HUES[i % DONE_HUES.length])),
    ];
}

// The keywords in use among these cards, in the order the query met them -
// deterministic for the same data, where counting or sorting would shuffle a
// column the moment one card changed.
export function statusesInCards(cards: Card[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const c of cards) {
        const v = (c.Status || '').trim();
        if (v === '' || seen.has(v.toLowerCase())) continue;
        seen.add(v.toLowerCase());
        out.push(v);
    }
    return out;
}

export function newBoard(name: string): KanbanBoard {
    return {
        name,
        storedQuery: '',
        query: '',
        includeArchived: false,
        groupBy: 'status',
        groupKey: '',
        columns: [],
        showUnset: true,
        unsetTitle: '',
        colorBy: 'none',
        colorKey: '',
        colors: {},
        headerKey: '',
        headerColors: {},
        labelSource: 'none',
        labelKey: '',
        labelColors: {},
        labelOrder: [],
        layout: 'board',
        listFields: DEFAULT_LIST_FIELDS.slice(),
        hidden: [],
        folded: [],
        badges: [],
        backShows: 'both',
        sort: 'manual',
        orderKey: 'KANBAN',
    };
}

// A board read off the server, filled in. The extensions file is a yaml file a
// user may well have edited by hand, and a board missing a field it gained
// later should open rather than throw.
export function normalizeBoard(raw: any): KanbanBoard {
    const base = newBoard(typeof raw?.name === 'string' ? raw.name : 'Board');
    const cols: KanbanColumn[] = Array.isArray(raw?.columns)
        ? raw.columns.map((c: any) => ({
            value: typeof c?.value === 'string' ? c.value : '',
            title: typeof c?.title === 'string' ? c.title : '',
            color: typeof c?.color === 'string' ? c.color : '',
            limit: typeof c?.limit === 'number' ? c.limit : 0,
            collapsed: !!c?.collapsed,
            aliases: Array.isArray(c?.aliases)
                ? c.aliases.filter((a: any) => typeof a === 'string' && a.trim() !== '')
                : [],
        }))
        : [];
    return {
        ...base,
        storedQuery: raw?.storedQuery || '',
        query: raw?.query || '',
        includeArchived: !!raw?.includeArchived,
        groupBy: raw?.groupBy === 'property' || raw?.groupBy === 'tag' ? raw.groupBy : 'status',
        groupKey: raw?.groupKey || '',
        columns: cols,
        showUnset: raw?.showUnset === undefined ? true : !!raw.showUnset,
        unsetTitle: raw?.unsetTitle || '',
        colorBy: ['property', 'tag', 'status', 'priority'].indexOf(raw?.colorBy) >= 0 ? raw.colorBy : 'none',
        colorKey: raw?.colorKey || '',
        colors: raw?.colors && typeof raw.colors === 'object' ? raw.colors : {},
        headerKey: typeof raw?.headerKey === 'string' ? raw.headerKey : '',
        headerColors: raw?.headerColors && typeof raw.headerColors === 'object' ? raw.headerColors : {},
        labelSource: raw?.labelSource === 'tags' || raw?.labelSource === 'property' ? raw.labelSource : 'none',
        labelKey: typeof raw?.labelKey === 'string' ? raw.labelKey : '',
        labelColors: raw?.labelColors && typeof raw.labelColors === 'object' ? raw.labelColors : {},
        labelOrder: Array.isArray(raw?.labelOrder)
            ? raw.labelOrder.filter((v: any) => typeof v === 'string' && v.trim() !== '')
            : [],
        layout: raw?.layout === 'list' ? 'list' : 'board',
        listFields: Array.isArray(raw?.listFields)
            ? raw.listFields.filter((f: any) => typeof f === 'string' && f.trim() !== '')
            : DEFAULT_LIST_FIELDS.slice(),
        hidden: Array.isArray(raw?.hidden)
            ? raw.hidden.filter((v: any) => typeof v === 'string')
            : [],
        // A board saved before folding was kept on the board wrote the flag on
        // each column instead. Read those so nobody's folded columns spring
        // open the first time they open the board after this change.
        folded: Array.isArray(raw?.folded)
            ? raw.folded.filter((v: any) => typeof v === 'string')
            : cols.filter(c => c.collapsed).map(c => c.value),
        badges: Array.isArray(raw?.badges) ? raw.badges.filter((b: any) => typeof b === 'string') : [],
        backShows: ['body', 'properties', 'both'].indexOf(raw?.backShows) >= 0 ? raw.backShows : 'both',
        sort: ['headline', 'priority', 'deadline', 'scheduled', 'file', 'manual'].indexOf(raw?.sort) >= 0 ? raw.sort : 'manual',
        orderKey: raw?.orderKey || 'KANBAN',
    };
}

// A name no existing board has, for Add board and for Duplicate.
export function uniqueName(base: string, taken: string[]): string {
    if (taken.indexOf(base) < 0) return base;
    for (let i = 2; ; i++) {
        const n = `${base} ${i}`;
        if (taken.indexOf(n) < 0) return n;
    }
}

// The query a board runs, and the filter it runs under. An archived heading is
// left out unless the board asked for it; nothing else is assumed, because a
// board of notes is exactly the case a todo-only filter would empty.
export function boardQuery(board: KanbanBoard, stored: { name: string; query: string }[]): { query: string; baseFilter: string } {
    let query = board.query || '';
    if (board.storedQuery) {
        const found = stored.find(s => s.name === board.storedQuery);
        query = found ? found.query : '';
    }
    return { query, baseFilter: board.includeArchived ? '' : '!IsArchived()' };
}

// The one expression /search is sent: the filter and the query joined, the
// query in brackets so an `||` in it cannot escape the filter. The same
// string the Go twin's BoardQuery builds.
export function searchExpr(board: KanbanBoard, stored: { name: string; query: string }[]): string {
    const { query, baseFilter } = boardQuery(board, stored);
    if (baseFilter === '') return query;
    if (query.trim() === '') return baseFilter;
    return `${baseFilter} && (${query})`;
}

// Why a board's query cannot be run, or '' when it can.
//
// A board with no query is not "show nothing" to the server: an empty
// expression is everything, and on a large database asking for every heading
// (with its body, for the cards) is what locked the page up. So an empty
// query is refused here, before anything is sent - by the settings dialog
// (which will not save the board, and does not count its matches) and by the
// board itself (which says why instead of loading).
//
// A saved query that has since been deleted lands in the same place: the
// board names it, finds no text, and would otherwise run the empty query.
export function boardQueryProblem(board: KanbanBoard, stored: { name: string; query: string }[]): string {
    if (board.storedQuery) {
        const found = stored.find(s => s.name === board.storedQuery);
        if (!found) return `The saved query “${board.storedQuery}” is not there any more. Pick another, or write one.`;
        if ((found.query || '').trim() === '') return `The saved query “${board.storedQuery}” is empty.`;
        return '';
    }
    if ((board.query || '').trim() === '') return 'A board needs a query: pick a saved one, or write an expression.';
    return '';
}

// The column values the query actually turned up, commonest first, for the
// settings dialog's offer to fill the columns in. Values a column already has
// are left out - this adds what is missing rather than replacing what is there.
export function discoverValues(cards: Card[], board: KanbanBoard): string[] {
    const counts = new Map<string, number>();
    for (const c of cards) {
        for (const v of groupValuesOf(c, board)) {
            if (v.trim() === '') continue;
            counts.set(v, (counts.get(v) || 0) + 1);
        }
    }
    // Anything a column already claims - its own spelling or an alias - is not
    // a discovery, or the board would offer to add INPROGRESS as a new column
    // next to the IN-PROGRESS one that already takes it.
    const have = new Set<string>();
    board.columns.forEach(c => columnValues(c).forEach(v => have.add(v.trim().toLowerCase())));
    return Array.from(counts.entries())
        .filter(([v]) => !have.has(v.trim().toLowerCase()))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([v]) => v);
}

// Every property name the cards carry, for the settings dialog's suggestions.
export function propertyNames(cards: Card[]): string[] {
    const names = new Set<string>();
    for (const c of cards) {
        if (!c.Props) continue;
        for (const k of Object.keys(c.Props)) names.add(k);
    }
    return Array.from(names).sort();
}

export function columnTitle(col: KanbanColumn): string {
    return col.title || col.value;
}

// ---------------------------------------------------------------------------
// What a drop writes (Kanban.tsx's planOrder; PlanOrder in model.go)
// ---------------------------------------------------------------------------

export type OrderWrite = { card: Card; value: number };

// What a card moved to position `index` in `list` (the column, sorted, without
// it) has to write: its own midpoint normally, the whole column when the gap
// has run out or a card above the drop has no number to be below. null on a
// board that is not sorted by hand, where a drop only changes the column.
export function planOrder(list: Card[], index: number, moving: Card, board: KanbanBoard): OrderWrite[] | null {
    if (board.sort !== 'manual') return null;
    const rest = list.filter(c => c.Hash !== moving.Hash);
    const at = Math.max(0, Math.min(index, rest.length));
    const prev = at > 0 ? rest[at - 1] : null;
    const next = at < rest.length ? rest[at] : null;
    const prevOrder = prev ? orderOf(prev, board) : null;
    const nextOrder = next ? orderOf(next, board) : null;
    if (!(prev && prevOrder === null)) {
        const value = orderBetween(prevOrder, nextOrder);
        if (value !== null) return [{ card: moving, value }];
    }
    const after = rest.slice();
    after.splice(at, 0, moving);
    const numbers = renumber(after.length);
    const writes: OrderWrite[] = [];
    after.forEach((c, i) => {
        if (c.Hash === moving.Hash || orderOf(c, board) !== numbers[i]) writes.push({ card: c, value: numbers[i] });
    });
    return writes;
}

// The card as it will be once dropped into `target`, drawn before the server
// has answered (Kanban.tsx's optimistic move).
export function movedCard(card: Card, board: KanbanBoard, from: string, target: string): Card {
    const next: Card = { ...card, Props: { ...(card.Props || {}) }, Tags: (card.Tags || []).slice() };
    if (from === target) return next;
    if (board.groupBy === 'property') next.Props![board.groupKey] = target;
    else if (board.groupBy === 'status') next.Status = target;
    else if (board.groupBy === 'tag') {
        next.Tags = next.Tags!.filter(t => t !== from);
        if (target !== UNSET) next.Tags!.push(target);
    }
    return next;
}

// The columns a board shows: its own, or for a status board with none the ones
// read off the server's keywords and the query, with the catch-all on the far
// left when asked for. Kanban.tsx's `derived` and `columns`.
export function boardColumns(board: KanbanBoard, states: TodoStateList, cards: Card[]): KanbanColumn[] {
    const derived = board.columns.length === 0 && board.groupBy === 'status'
        ? defaultStatusColumns(states, statusesInCards(cards))
        : [];
    const cols = derived.length > 0 ? derived.slice() : board.columns.slice();
    if (board.showUnset) cols.unshift(unsetColumn(board));
    const folded = new Set(board.folded || []);
    return cols.map(c => ({ ...c, collapsed: folded.has(c.value) }));
}

// Every column's cards, sorted. A card no shown column claims is left out.
export function bucketCards(cards: Card[], board: KanbanBoard, cols: KanbanColumn[]): Map<string, Card[]> {
    const out = new Map<string, Card[]>();
    for (const col of cols) out.set(col.value, []);
    for (const c of cards) {
        const list = out.get(columnOf(c, board, cols));
        if (list) list.push(c);
    }
    const sorted = new Map<string, Card[]>();
    out.forEach((list, key) => sorted.set(key, sortCards(list, board)));
    return sorted;
}

// A status board cannot take the keyword away through /status/change, so a
// drop into its catch-all is refused rather than sent.
export function dropRefused(board: KanbanBoard, target: string): boolean {
    return board.groupBy === 'status' && target === UNSET;
}

// ---------------------------------------------------------------------------
// The checklist under a heading (worg/src/orgbody.ts)
// ---------------------------------------------------------------------------

export interface CheckItem {
    // Position among the checkboxes of this body: what the server counts.
    index: number;
    done: boolean;
    text: string;
    depth: number;
}

export interface Checklist {
    items: CheckItem[];
    done: number;
    total: number;
}

// An item: indent, a bullet, a box. `*` is a bullet only when indented - at
// column zero it is a heading.
const ITEM = /^(\s*)([-+*]|\d+[.)])\s+\[([ xX-])\]\s?(.*)$/;
const DRAWER_OPEN = /^\s*:[A-Za-z0-9_@#%-]+:\s*$/;
const DRAWER_END = /^\s*:END:\s*$/i;
const PLANNING = /^\s*(SCHEDULED|DEADLINE|CLOSED):/;

// The body's own lines, drawers and the planning line taken out, so nothing
// counts a box in a LOGBOOK.
export function bodyLines(text: string): string[] {
    const out: string[] = [];
    if ((text || '') === '') return out;
    let inDrawer = false;
    for (const line of (text || '').split('\n')) {
        if (inDrawer) {
            if (DRAWER_END.test(line)) inDrawer = false;
            continue;
        }
        if (DRAWER_OPEN.test(line) && !DRAWER_END.test(line)) { inDrawer = true; continue; }
        if (PLANNING.test(line)) continue;
        out.push(line);
    }
    return out;
}

export function checklistOf(text: string): Checklist {
    const items: CheckItem[] = [];
    for (const line of bodyLines(text)) {
        const m = line.match(ITEM);
        if (!m || (m[2] === '*' && m[1] === '')) continue;
        items.push({
            index: items.length,
            // `[-]` is half done, which is not done.
            done: m[3] === 'x' || m[3] === 'X',
            text: m[4].trim(),
            depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2),
        });
    }
    return { items, done: items.filter(i => i.done).length, total: items.length };
}

// ---------------------------------------------------------------------------
// What a card face shows (worg's cardparts.tsx)
// ---------------------------------------------------------------------------

export const PRIORITY_COLOR: Record<string, string> = { A: '#e5484d', B: '#f5a524', C: '#3e63dd' };

// The properties read as who a card is for, first found wins.
export const ASSIGNEE_KEYS = ['ASSIGNEE', 'ASSIGNED', 'OWNER', 'WHO'];

export function assigneeOf(card: Card): string {
    const props = card.Props || {};
    for (const k of ASSIGNEE_KEYS) {
        const v = (props[k] || '').trim();
        if (v !== '') return v;
    }
    return '';
}

// go-org writes the zero time for a date nobody set.
export function isSetDate(d?: { Start?: string } | null): boolean {
    return !!(d && d.Start && !d.Start.startsWith('0001-01-01'));
}

// A date as a card says it: today and tomorrow by name, the weekday within
// the week, this year without the year.
export function dateLabel(iso: string, now: Date = new Date()): string {
    const d = orgMoment(iso);
    if (isNaN(d.getTime())) return '';
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
        - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (days > 1 && days < 7) return WEEK[d.getDay()];
    const md = `${MONTH[d.getMonth()]} ${d.getDate()}`;
    return d.getFullYear() === now.getFullYear() ? md : `${md} ${d.getFullYear()}`;
}

export function isOverdue(iso: string, now: Date = new Date()): boolean {
    const d = orgMoment(iso);
    if (isNaN(d.getTime())) return false;
    return d.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
