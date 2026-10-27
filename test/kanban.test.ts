// The kanban model's scenarios, ported from worg/src/kanban.test.ts (and the
// Go twin's model_test.go, at the end), so this is the third copy of the same
// checks. Plain node: mocha --ui tdd out/test/kanban.test.js
import { expect } from './jest-expect';
// The board's arithmetic, which is the part of it that can be wrong quietly.
//
// Where a card lands and what number a drag writes are the two things a user
// cannot check by looking: a card in the wrong column looks like a card, and an
// order value a hair out looks right until the next refresh puts the card back
// where it came from.

import {
    Card,
    columnOf,
    sortCards,
    orderBetween,
    formatOrder,
    renumber,
    autoSwatch,
    cardSwatch,
    discoverValues,
    cardMatches,
    searchTerms,
    normalizeBoard,
    uniqueName,
    boardQuery,
    boardQueryProblem,
} from '../src/kanban-model';
import { KanbanBoard } from '../src/kanban-model';
import { defaultStatusColumns, statusesInCards, columnValues, canonicalValue } from '../src/kanban-model';
import { newBoard } from '../src/kanban-model';
import {
    labelsOf, labelColorOf, labelsInCards, splitLabels,
    headerValueOf, headerColorOf, colorFromWord,
    HEADER_NONE_DARK, HEADER_NONE_LIGHT, PALETTE, swatch,
} from '../src/kanban-model';
import {
    LIST_FIELDS, DEFAULT_LIST_FIELDS, PINNED_FIELDS, PROP_FIELD,
    listField, listFieldsOf, listFieldText,
} from '../src/kanban-model';
import {
    planOrder, searchExpr, boardColumns, bucketCards, movedCard, dropRefused,
    assigneeOf, dateLabel, isOverdue, isSetDate, checklistOf, bodyLines,
} from '../src/kanban-model';

function card(over: Partial<Card>): Card {
    return {
        Hash: 'h', Headline: 'A heading', Status: '', Priority: '',
        Tags: [], Props: {}, Filename: '/notes.org', LineNum: 1, Level: 1,
        ...over,
    };
}

function board(over: Partial<KanbanBoard>): KanbanBoard {
    return { ...newBoard('T'), ...over };
}

suite('which column a card lands in', () => {
    test('reads a property, ignoring case and stray spaces', () => {
        const b = board({
            groupBy: 'property', groupKey: 'STAGE',
            columns: [{ value: 'Doing', title: '', color: '', limit: 0, collapsed: false }],
        });
        expect(columnOf(card({ Props: { STAGE: ' doing ' } }), b)).toBe('Doing');
    });

    test('gives a card with two matching tags to the first column that asks', () => {
        const b = board({
            groupBy: 'tag',
            columns: [
                { value: 'urgent', title: '', color: '', limit: 0, collapsed: false },
                { value: 'work', title: '', color: '', limit: 0, collapsed: false },
            ],
        });
        expect(columnOf(card({ Tags: ['work', 'urgent'] }), b)).toBe('urgent');
        // ...and swapping the columns swaps the answer, which is what makes the
        // order of the columns part of what they mean.
        const swapped = board({ ...b, columns: b.columns.slice().reverse() });
        expect(columnOf(card({ Tags: ['work', 'urgent'] }), swapped)).toBe('work');
    });

    test('leaves a card no column claims with no column', () => {
        const b = board({
            groupBy: 'status',
            columns: [{ value: 'TODO', title: '', color: '', limit: 0, collapsed: false }],
        });
        expect(columnOf(card({ Status: 'DONE' }), b)).toBe('');
        expect(columnOf(card({ Status: '' }), b)).toBe('');
    });
});

suite('the order of a column', () => {
    test('puts a card nobody has dragged after the ones that have been', () => {
        const b = board({ sort: 'manual', orderKey: 'KANBAN' });
        const out = sortCards([
            card({ Hash: 'none', Props: {} }),
            card({ Hash: 'two', Props: { KANBAN: '2' } }),
            card({ Hash: 'one', Props: { KANBAN: '1' } }),
        ], b);
        expect(out.map(c => c.Hash)).toEqual(['one', 'two', 'none']);
    });

    test('sorts an unprioritised card after every prioritised one', () => {
        const b = board({ sort: 'priority' });
        const out = sortCards([
            card({ Hash: 'none' }),
            card({ Hash: 'b', Priority: 'B' }),
            card({ Hash: 'a', Priority: 'A' }),
        ], b);
        expect(out.map(c => c.Hash)).toEqual(['a', 'b', 'none']);
    });

    test('is stable, so a refresh does not reshuffle the column', () => {
        const b = board({ sort: 'manual' });
        const cards = [card({ Hash: 'x' }), card({ Hash: 'y' }), card({ Hash: 'z' })];
        expect(sortCards(cards, b).map(c => c.Hash)).toEqual(['x', 'y', 'z']);
    });
});

suite('the number a drag writes', () => {
    test('takes the midpoint, so only the card that moved is written', () => {
        expect(orderBetween(1, 2)).toBe(1.5);
        expect(orderBetween(0, 100)).toBe(50);
    });

    test('steps past the end rather than off it', () => {
        expect(orderBetween(null, null)).toBe(0);
        expect(orderBetween(5, null)).toBe(6);
        expect(orderBetween(null, 5)).toBe(4);
    });

    test('asks for a renumber when the gap has run out of room', () => {
        const a = 1;
        const b = a + Number.EPSILON;
        expect(orderBetween(a, b)).toBeNull();
    });

    test('lands strictly between its neighbours, so the card stays where it was dropped', () => {
        const lo = 0;
        let hi = 1;
        for (let i = 0; i < 20; i++) {
            const mid = orderBetween(lo, hi);
            expect(mid).not.toBeNull();
            expect(mid as number).toBeGreaterThan(lo);
            expect(mid as number).toBeLessThan(hi);
            hi = mid as number;
        }
    });

    test('is written short enough to read in a property drawer', () => {
        expect(formatOrder(3)).toBe('3');
        expect(formatOrder(1.5)).toBe('1.5');
        expect(formatOrder(1 / 3)).toBe('0.333333');
    });

    test('renumbers with room between every pair', () => {
        expect(renumber(3)).toEqual([0, 100, 200]);
    });
});

suite('colour', () => {
    test('gives the same value the same colour every time', () => {
        expect(autoSwatch('work').key).toBe(autoSwatch('work').key);
        expect(autoSwatch('WORK ').key).toBe(autoSwatch('work').key);
    });

    test('never hands out the colour of having no value', () => {
        for (const v of ['a', 'b', 'work', 'home', 'zzz', 'idea']) {
            expect(autoSwatch(v).key).not.toBe('slate');
        }
    });

    test('prefers the colour the board named over the automatic one', () => {
        const b = board({ colorBy: 'property', colorKey: 'AREA', colors: { home: 'teal' } });
        expect(cardSwatch(card({ Props: { AREA: 'home' } }), b)!.key).toBe('teal');
        expect(cardSwatch(card({ Props: { AREA: 'work' } }), b)!.key).toBe(autoSwatch('work').key);
    });

    test('colours nothing when the board says to colour nothing', () => {
        expect(cardSwatch(card({ Props: { AREA: 'home' } }), board({}))).toBeNull();
    });
});

suite('the rest of it', () => {
    test('offers only the column values that are missing, commonest first', () => {
        const b = board({
            groupBy: 'property', groupKey: 'STAGE',
            columns: [{ value: 'done', title: '', color: '', limit: 0, collapsed: false }],
        });
        const cards = [
            card({ Props: { STAGE: 'idea' } }),
            card({ Props: { STAGE: 'doing' } }),
            card({ Props: { STAGE: 'doing' } }),
            card({ Props: { STAGE: 'done' } }),
        ];
        expect(discoverValues(cards, b)).toEqual(['doing', 'idea']);
    });

    test('searches everything a card holds, not what it is showing', () => {
        const c = card({ Headline: 'Write the spec', Props: { OWNER: 'ian' }, Tags: ['work'] });
        expect(cardMatches(c, searchTerms('spec ian work'))).toBe(true);
        expect(cardMatches(c, searchTerms('spec nobody'))).toBe(false);
        expect(cardMatches(c, searchTerms(''))).toBe(true);
    });

    test('fills in a board written before it had all its fields', () => {
        const b = normalizeBoard({ name: 'Old', columns: [{ value: 'a' }] });
        expect(b.sort).toBe('manual');
        expect(b.orderKey).toBe('KANBAN');
        expect(b.showUnset).toBe(true);
        // A column written before aliases existed gets an empty list rather
        // than an undefined one, so nothing downstream has to check.
        expect(b.columns[0]).toEqual({ value: 'a', title: '', color: '', limit: 0, collapsed: false, aliases: [] });
    });

    test('refuses to hand out a name another board has', () => {
        expect(uniqueName('Board', ['Board', 'Board 2'])).toBe('Board 3');
        expect(uniqueName('Board', [])).toBe('Board');
    });

    test('runs the stored query rather than the board\'s own when both are set', () => {
        const b = board({ storedQuery: 'Notes', query: 'IsTodo()' });
        expect(boardQuery(b, [{ name: 'Notes', query: 'HasTags("note")' }]).query).toBe('HasTags("note")');
    });

    test('leaves archived headings out unless the board asked for them', () => {
        expect(boardQuery(board({}), []).baseFilter).toBe('!IsArchived()');
        expect(boardQuery(board({ includeArchived: true }), []).baseFilter).toBe('');
    });
});


// --- the columns a status board starts with ---------------------------------
//
// A board that has not been configured still has to be a board. These pin what
// it reads off the server and the query, and the order it puts them in.

test('the columns come from the configured states, finished ones last', () => {
    const cols = defaultStatusColumns({
        active: ['TODO', 'IN-PROGRESS', 'BLOCKED'],
        done: ['DONE', 'CANCELLED'],
    });
    // Work travels rightwards, so finished work is at the right-hand end.
    // Inside each group the configured order is kept exactly.
    expect(cols.map(c => c.value)).toEqual([
        'TODO', 'IN-PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED',
    ]);
});

test('every default column gets a colour, and the two groups read apart', () => {
    const cols = defaultStatusColumns({ active: ['TODO', 'NEXT'], done: ['DONE'] });
    for (const c of cols) expect(c.color).not.toBe('');
    const done = cols.find(c => c.value === 'DONE')!;
    const active = cols.filter(c => c.value !== 'DONE');
    // Finished work is in its own family of hues, so no active column can be
    // mistaken for it.
    expect(done.color).toBe('green');
    for (const a of active) expect(a.color).not.toBe(done.color);
    // And two active columns are not the same colour as each other.
    expect(active[0].color).not.toBe(active[1].color);
});

test('a keyword the query uses but the config never mentions is added, last', () => {
    const cols = defaultStatusColumns(
        { active: ['TODO'], done: ['DONE'] },
        ['TODO', 'WAITING', 'DONE'],
    );
    // The two already configured are not repeated, and the stray one goes just
    // before the finished states: nothing says where in the run it belongs,
    // only that it is not finished.
    expect(cols.map(c => c.value)).toEqual(['TODO', 'WAITING', 'DONE']);
});

test('a state named twice only gets one column', () => {
    const cols = defaultStatusColumns({ active: ['TODO', 'TODO'], done: ['DONE'] }, ['todo']);
    expect(cols.map(c => c.value)).toEqual(['TODO', 'DONE']);
});

test('no configured states at all still gives a board built from the query', () => {
    const cols = defaultStatusColumns({ active: [], done: [] }, ['TODO', 'DONE']);
    expect(cols.map(c => c.value)).toEqual(['TODO', 'DONE']);
});

test('a card is matched against the columns on show, not the stored ones', () => {
    // A board given no columns of its own shows derived ones. Matching against
    // board.columns there put every card in the catch-all, which looked like
    // the grouping was broken rather than the lookup.
    const b = { ...newBoard('B'), groupBy: 'status' as const, columns: [] };
    const derived = defaultStatusColumns({ active: ['TODO'], done: ['DONE'] });
    expect(columnOf(card({ Status: 'TODO' }), b)).toBe('');
    expect(columnOf(card({ Status: 'TODO' }), b, derived)).toBe('TODO');
    expect(columnOf(card({ Status: 'DONE' }), b, derived)).toBe('DONE');
});

test('the keywords in use are met in the order the query met them', () => {
    const cards = [
        card({ Status: 'TODO' }),
        card({ Status: 'DONE' }),
        card({ Status: 'TODO' }),
        card({ Status: '' }),
        card({ Status: 'BLOCKED' }),
    ];
    // Encounter order, not counted or sorted: counting would shuffle a column
    // the moment one card changed.
    expect(statusesInCards(cards)).toEqual(['TODO', 'DONE', 'BLOCKED']);
});


// --- aliases ----------------------------------------------------------------

test('spellings of the same word become one column with the others as aliases', () => {
    const cols = defaultStatusColumns(
        { active: ['TODO', 'IN-PROGRESS'], done: ['DONE'] },
        ['INPROGRESS', 'in_progress', 'WAITING'],
    );
    // One column for the state, not three, and it is called by the spelling
    // that was configured rather than one the query happened to turn up.
    expect(cols.map(c => c.value)).toEqual(['TODO', 'IN-PROGRESS', 'WAITING', 'DONE']);
    const prog = cols.find(c => c.value === 'IN-PROGRESS')!;
    expect(prog.aliases).toEqual(['INPROGRESS', 'in_progress']);
    expect(columnValues(prog)).toEqual(['IN-PROGRESS', 'INPROGRESS', 'in_progress']);
});

test('a card spelled any of the ways lands in the one column', () => {
    const b = { ...newBoard('B'), groupBy: 'status' as const, columns: [] };
    const cols = defaultStatusColumns({ active: ['IN-PROGRESS'], done: [] }, ['INPROGRESS']);
    expect(columnOf(card({ Status: 'IN-PROGRESS' }), b, cols)).toBe('IN-PROGRESS');
    expect(columnOf(card({ Status: 'INPROGRESS' }), b, cols)).toBe('IN-PROGRESS');
    // Case is noise, so this is the same spelling.
    expect(columnOf(card({ Status: 'inprogress' }), b, cols)).toBe('IN-PROGRESS');
    // A spelling nobody has ever used does *not* match. Claiming is by the
    // listed aliases rather than by canonical shape on the fly, so two columns
    // somebody deliberately kept apart stay apart - the default builder folds
    // the spellings that are actually in the configuration and the data, which
    // is every spelling there is to meet.
    expect(columnOf(card({ Status: 'in progress' }), b, cols)).toBe('');
    // Something genuinely different still falls through to the catch-all.
    expect(columnOf(card({ Status: 'BLOCKED' }), b, cols)).toBe('');
});

test('canonical spelling ignores case and the characters between words', () => {
    const forms = ['IN-PROGRESS', 'INPROGRESS', 'in_progress', 'In Progress', 'in-progress'];
    const canon = forms.map(canonicalValue);
    expect(new Set(canon).size).toBe(1);
    // But it does not collapse words that are actually different.
    expect(canonicalValue('DONE')).not.toBe(canonicalValue('NOTDONE'));
});

test('a value a column already claims is not offered as a discovery', () => {
    const b: KanbanBoard = {
        ...newBoard('B'),
        groupBy: 'status',
        columns: [{ value: 'IN-PROGRESS', title: '', color: '', limit: 0, collapsed: false, aliases: ['INPROGRESS'] }],
    };
    const found = discoverValues([card({ Status: 'INPROGRESS' }), card({ Status: 'BLOCKED' })], b);
    expect(found).toEqual(['BLOCKED']);
});


// ---------------------------------------------------------------------------
// The bar across the top of a card
// ---------------------------------------------------------------------------

suite('the header bar', () => {
    test('reads a card’s own COLOUR, in either spelling, when the board names nothing', () => {
        const b = board({});
        expect(headerValueOf(card({ Props: { COLOUR: 'teal' } }), b)).toBe('teal');
        expect(headerValueOf(card({ Props: { COLOR: 'teal' } }), b)).toBe('teal');
        // Whitespace around a hand-written property value is not part of it.
        expect(headerValueOf(card({ Props: { COLOUR: '  amber ' } }), b)).toBe('amber');
        expect(headerValueOf(card({ Props: {} }), b)).toBe('');
        // A property that is there but empty says nothing, rather than saying ''.
        expect(headerValueOf(card({ Props: { COLOUR: '' } }), b)).toBe('');
    });

    test('reads the property the board names instead, and only that one', () => {
        const b = board({ headerKey: 'CLIENT' });
        expect(headerValueOf(card({ Props: { CLIENT: 'Acme', COLOUR: 'teal' } }), b)).toBe('Acme');
        // Naming a property turns the default off: a card with no CLIENT says
        // nothing, even though it has a COLOUR.
        expect(headerValueOf(card({ Props: { COLOUR: 'teal' } }), b)).toBe('');
        // The name is matched however it was typed into the settings.
        expect(headerValueOf(card({ Props: { CLIENT: 'Acme' } }), board({ headerKey: 'client' }))).toBe('Acme');
    });

    test('turns a colour word into a colour, and anything else into one of its own', () => {
        // A palette key, and a palette label.
        expect(colorFromWord('teal')).toBe(swatch('teal').hex);
        // A word people write for a colour the palette calls something else.
        expect(colorFromWord('purple')).toBe(swatch('violet').hex);
        expect(colorFromWord('grey')).toBe(swatch('slate').hex);
        // Case and spacing are not part of the word.
        expect(colorFromWord('  Teal ')).toBe(swatch('teal').hex);
        // Hex written out is taken at its word, in both lengths.
        expect(colorFromWord('#123456')).toBe('#123456');
        expect(colorFromWord('#abc')).toBe('#aabbcc');
        // Anything else gets a colour that is stable for that spelling - which
        // is what lets :CLIENT: Acme be a colour with nothing configured.
        expect(colorFromWord('Acme')).toBe(colorFromWord('Acme'));
        expect(colorFromWord('Acme')).not.toBe(colorFromWord('Zebra'));
        expect(colorFromWord('Acme')).toMatch(/^#[0-9a-f]{6}$/i);
    });

    test('gives a card with nothing to say a grey that differs from the card under it', () => {
        const b = board({});
        expect(headerColorOf(card({}), b, true)).toBe(HEADER_NONE_DARK);
        expect(headerColorOf(card({}), b, false)).toBe(HEADER_NONE_LIGHT);
        // The grey is reserved for saying nothing: no value is ever given it.
        const said = headerColorOf(card({ Props: { COLOUR: 'Acme' } }), b, true);
        expect(said).not.toBe(HEADER_NONE_DARK);
        expect(said).not.toBe(HEADER_NONE_LIGHT);
    });

    test('lets the board override what a value spells', () => {
        // Acme is not a colour word, so it would otherwise get an automatic one.
        const auto = colorFromWord('Acme');
        const b = board({ headerKey: 'CLIENT', headerColors: { Acme: 'indigo' } });
        expect(headerColorOf(card({ Props: { CLIENT: 'Acme' } }), b)).toBe(swatch('indigo').hex);
        expect(headerColorOf(card({ Props: { CLIENT: 'Acme' } }), b)).not.toBe(auto);
        // A mapping beats a value that *is* a colour word, too - that is the
        // point of being able to set one.
        const over = board({ headerColors: { teal: 'red' } });
        expect(headerColorOf(card({ Props: { COLOUR: 'teal' } }), over)).toBe(swatch('red').hex);
        // Hex may be mapped directly as well as a palette key.
        const hex = board({ headerColors: { teal: '#101010' } });
        expect(headerColorOf(card({ Props: { COLOUR: 'teal' } }), hex)).toBe('#101010');
    });

    test('always answers with a colour a bar can be painted', () => {
        const b = board({});
        const values = ['teal', 'Acme', '#123456', 'GRAY', 'whatever this is', ''];
        for (const v of values) {
            const hex = headerColorOf(card({ Props: v === '' ? {} : { COLOUR: v } }), b);
            expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
        }
        // And every palette colour is a valid answer, so the picker cannot
        // offer something the bar cannot show.
        for (const s of PALETTE) {
            expect(headerColorOf(card({ Props: { COLOUR: 'x' } }), board({ headerColors: { x: s.key } }))).toBe(s.hex);
        }
    });

    test('is kept by a board read back from the server', () => {
        const b = normalizeBoard({ name: 'B', headerKey: 'CLIENT', headerColors: { Acme: 'indigo' } } as any);
        expect(b.headerKey).toBe('CLIENT');
        expect(b.headerColors).toEqual({ Acme: 'indigo' });
        // A board saved before any of this existed reads as the default.
        const old = normalizeBoard({ name: 'B' } as any);
        expect(old.headerKey).toBe('');
        expect(old.headerColors).toEqual({});
    });
});


// ---------------------------------------------------------------------------
// Folded columns
// ---------------------------------------------------------------------------

suite('which columns are folded', () => {
    test('is kept on the board, so it survives a reload', () => {
        const b = normalizeBoard({ name: 'B', folded: ['DONE', 'BLOCKED'] } as any);
        expect(b.folded).toEqual(['DONE', 'BLOCKED']);
    });

    test('is empty on a new board and on one that has never said', () => {
        expect(newBoard('B').folded).toEqual([]);
        expect(normalizeBoard({ name: 'B' } as any).folded).toEqual([]);
    });

    test('is read off the columns of a board saved before it moved', () => {
        // Folding used to be a flag on each stored column. A board written then
        // must open with the same columns folded rather than all of them open.
        const b = normalizeBoard({
            name: 'B',
            columns: [
                { value: 'TODO', collapsed: false },
                { value: 'DONE', collapsed: true },
            ],
        } as any);
        expect(b.folded).toEqual(['DONE']);
        // And a board that has both is taken at its word: the list wins, so
        // opening a column stays open even though the old flag is still there.
        const both = normalizeBoard({
            name: 'B',
            folded: [],
            columns: [{ value: 'DONE', collapsed: true }],
        } as any);
        expect(both.folded).toEqual([]);
    });

    test('remembers the sections put away, which is not the same as folded', () => {
        // Two separate lists on purpose: a folded section is still on the list
        // with its count, a hidden one is not drawn at all.
        expect(newBoard('B').hidden).toEqual([]);
        const b = normalizeBoard({ name: 'B', hidden: ['DONE'], folded: ['TODO'] } as any);
        expect(b.hidden).toEqual(['DONE']);
        expect(b.folded).toEqual(['TODO']);
        // A board written before hiding existed has nothing put away, rather
        // than inheriting whatever was folded.
        const old = normalizeBoard({ name: 'B', folded: ['TODO'] } as any);
        expect(old.hidden).toEqual([]);
        // And junk in the list is not a section.
        expect(normalizeBoard({ name: 'B', hidden: ['DONE', 7, null] } as any).hidden).toEqual(['DONE']);
    });

    test('keeps a value the board has no column for', () => {
        // Which is the point of it living on the board: the catch-all column
        // and the columns read off the server's keywords are not stored
        // anywhere, and folding either of them used to be forgotten.
        const b = normalizeBoard({ name: 'B', columns: [], folded: ['', 'IN-PROGRESS'] } as any);
        expect(b.folded).toEqual(['', 'IN-PROGRESS']);
    });

    test('ignores anything in the list that is not a value', () => {
        const b = normalizeBoard({ name: 'B', folded: ['DONE', 3, null, { x: 1 }] } as any);
        expect(b.folded).toEqual(['DONE']);
    });
});


// ---------------------------------------------------------------------------
// The list layout
// ---------------------------------------------------------------------------

suite('which layout a board is drawn in', () => {
    test('is a board unless it says otherwise', () => {
        expect(newBoard('B').layout).toBe('board');
        expect(normalizeBoard({ name: 'B' } as any).layout).toBe('board');
        expect(normalizeBoard({ name: 'B', layout: 'list' } as any).layout).toBe('list');
        // Anything that is neither is a board, not an empty screen.
        expect(normalizeBoard({ name: 'B', layout: 'gantt' } as any).layout).toBe('board');
    });

    test('starts with the fields a todo list is read for', () => {
        expect(newBoard('B').listFields).toEqual(DEFAULT_LIST_FIELDS);
        // The keyword is not one of them: it leads every row on its own, and a
        // board that also listed it as a field would show it twice.
        for (const key of PINNED_FIELDS) expect(DEFAULT_LIST_FIELDS).not.toContain(key);
        // And a board is free to have none at all - just the headings.
        expect(normalizeBoard({ name: 'B', listFields: [] } as any).listFields).toEqual([]);
        // But one that has never been asked gets the default rather than none,
        // which would open as a single blank column.
        expect(normalizeBoard({ name: 'B' } as any).listFields).toEqual(DEFAULT_LIST_FIELDS);
    });
});

suite('the fields a list lays out', () => {
    test('still knows the pinned ones, so a board saved with one reads', () => {
        // They are filtered out of what a list lays out, not forgotten: a board
        // whose listFields still name the keyword must open, not throw.
        for (const key of PINNED_FIELDS) {
            expect(LIST_FIELDS.some(f => f.key === key)).toBe(true);
            expect(listField(key).label).not.toBe(key);
        }
        expect(listFieldsOf(board({ listFields: ['status', 'tags'] })).map(f => f.key))
            .toEqual(['status', 'tags']);
    });

    test('knows the ones it can draw, and gives a property a column on the spot', () => {
        expect(listField('deadline').label).toBe('Deadline');
        expect(listField('deadline').sort).toBe('deadline');
        // A property needs no registering anywhere: naming it is enough.
        expect(listField('prop:assigned').key).toBe('prop:ASSIGNED');
        expect(listField('prop:assigned').label).toBe('ASSIGNED');
        // A key from a later version shows as itself rather than vanishing -
        // one fewer column than the board was set up with, with nothing said,
        // is the failure that takes an hour to notice.
        expect(listField('whatever').label).toBe('whatever');
    });

    test('takes the board’s order, and counts a field named twice once', () => {
        const b = board({ listFields: ['status', 'prop:AREA', 'status', 'prop:area'] });
        expect(listFieldsOf(b).map(f => f.key)).toEqual(['status', 'prop:AREA']);
    });

    test('reads what each field says', () => {
        const c = card({
            Status: 'TODO', Priority: 'A', Tags: ['home', 'errand'],
            Filename: '/notes/plan.org',
            Props: { AREA: 'Kitchen' },
            Deadline: { Start: '2026-02-03T00:00:00Z' } as any,
        });
        expect(listFieldText(c, 'status')).toBe('TODO');
        expect(listFieldText(c, 'priority')).toBe('A');
        expect(listFieldText(c, 'tags')).toBe('home errand');
        expect(listFieldText(c, 'file')).toBe('plan.org');
        expect(listFieldText(c, 'deadline')).toBe('2026-02-03');
        expect(listFieldText(c, 'prop:AREA')).toBe('Kitchen');
        // The property is matched however it was typed.
        expect(listFieldText(c, 'prop:area')).toBe('Kitchen');
        // A date go-org never set is not a date.
        expect(listFieldText(card({ Deadline: { Start: '0001-01-01T00:00:00Z' } as any }), 'deadline')).toBe('');
        expect(listFieldText(card({}), 'scheduled')).toBe('');
        expect(listFieldText(card({}), 'prop:NOPE')).toBe('');
    });

    test('offers a sort only for the fields a sort exists for', () => {
        for (const f of LIST_FIELDS) {
            if (!f.sort) continue;
            // Every sort a heading can switch to has to be one sortCards knows,
            // or clicking the heading would quietly stop sorting anything.
            const b = board({ sort: f.sort });
            expect(sortCards([card({ Headline: 'b' }), card({ Headline: 'a' })], b).length).toBe(2);
        }
        // Status and tags have no sort: neither has an order anybody agrees on.
        expect(listField('status').sort).toBeUndefined();
        expect(listField('tags').sort).toBeUndefined();
    });

    test('names a property field the one way, so the picker and the table agree', () => {
        expect(PROP_FIELD).toBe('prop:');
        expect(listField(`${PROP_FIELD}owner`).key).toBe(`${PROP_FIELD}OWNER`);
    });
});


// ---------------------------------------------------------------------------
// The coloured bars across a card
// ---------------------------------------------------------------------------

suite('a card\u2019s labels', () => {
    test('are nothing at all until the board says where they come from', () => {
        expect(newBoard('B').labelSource).toBe('none');
        expect(labelsOf(card({ Tags: ['home'] }), board({}))).toEqual([]);
    });

    test('come from the tags, in the board\u2019s own order', () => {
        const b = board({ labelSource: 'tags', labelOrder: ['urgent', 'home', 'work'] });
        // The heading carries them the other way round; the card still wears
        // them the way the board lists them, so two cards match.
        expect(labelsOf(card({ Tags: ['work', 'urgent'] }), b)).toEqual(['urgent', 'work']);
    });

    test('keep a tag the board never named, after the ones it did', () => {
        const b = board({ labelSource: 'tags', labelOrder: ['urgent'] });
        expect(labelsOf(card({ Tags: ['stray', 'urgent'] }), b)).toEqual(['urgent', 'stray']);
    });

    test('come from one property holding several, split on commas or spaces', () => {
        const b = board({ labelSource: 'property', labelKey: 'LABELS', labelOrder: ['red', 'blue'] });
        expect(labelsOf(card({ Props: { LABELS: 'blue red' } }), b)).toEqual(['red', 'blue']);
        expect(labelsOf(card({ Props: { LABELS: 'blue, red' } }), b)).toEqual(['red', 'blue']);
        // The property name is matched however the board spelled it.
        const lower = board({ labelSource: 'property', labelKey: 'labels', labelOrder: ['red'] });
        expect(labelsOf(card({ Props: { LABELS: 'red' } }), lower)).toEqual(['red']);
        expect(labelsOf(card({ Props: {} }), b)).toEqual([]);
    });

    test('splits a property value without inventing empty labels', () => {
        expect(splitLabels('a,  b ,c')).toEqual(['a', 'b', 'c']);
        expect(splitLabels('   ')).toEqual([]);
        expect(splitLabels('')).toEqual([]);
    });

    test('takes a colour from the board, and otherwise from its own spelling', () => {
        const b = board({ labelSource: 'tags', labelColors: { urgent: 'red' } });
        expect(labelColorOf('urgent', b)).toBe(swatch('red').hex);
        // Stable for a value nobody chose one for, so a board that has never
        // been configured still reads as a board.
        expect(labelColorOf('home', b)).toBe(labelColorOf('home', b));
        expect(labelColorOf('home', b)).toMatch(/^#[0-9a-f]{6}$/i);
        // Hex may be given directly as well as a palette name.
        expect(labelColorOf('x', board({ labelColors: { x: '#123456' } }))).toBe('#123456');
    });

    test('offers the board\u2019s set plus whatever the cards already wear', () => {
        const b = board({ labelSource: 'tags', labelOrder: ['urgent'] });
        const cards = [card({ Tags: ['urgent'] }), card({ Tags: ['stray'] })];
        expect(labelsInCards(cards, b)).toEqual(['urgent', 'stray']);
        // A board that labels nothing offers only what it was told, which is
        // nothing - not every tag in the database.
        expect(labelsInCards(cards, board({ labelOrder: [] }))).toEqual([]);
    });

    test('is kept by a board read back from the server', () => {
        const b = normalizeBoard({
            name: 'B', labelSource: 'property', labelKey: 'LABELS',
            labelColors: { red: 'red' }, labelOrder: ['red', 'blue'],
        } as any);
        expect(b.labelSource).toBe('property');
        expect(b.labelKey).toBe('LABELS');
        expect(b.labelOrder).toEqual(['red', 'blue']);
        // A board written before labels existed opens with none rather than
        // throwing.
        const old = normalizeBoard({ name: 'B' } as any);
        expect(old.labelSource).toBe('none');
        expect(old.labelOrder).toEqual([]);
        // And junk in the list is not a label.
        expect(normalizeBoard({ name: 'B', labelOrder: ['a', 4, ''] } as any).labelOrder).toEqual(['a']);
    });
});

suite('a board without a query', () => {
    const stored = [{ name: 'Notes', query: 'HasTags("note")' }, { name: 'Blank', query: '  ' }];
    const make = (storedQuery: string, query: string) => ({ ...newBoard('B'), storedQuery, query });

    test('is refused, because an empty expression is every heading there is', () => {
        expect(boardQueryProblem(make('', ''), stored)).not.toBe('');
        expect(boardQueryProblem(make('', '   '), stored)).not.toBe('');
    });

    test('is refused when it names a saved query that has gone, or is blank', () => {
        expect(boardQueryProblem(make('Gone', ''), stored)).toContain('Gone');
        expect(boardQueryProblem(make('Blank', ''), stored)).not.toBe('');
    });

    test('is fine with either kind of query', () => {
        expect(boardQueryProblem(make('Notes', ''), stored)).toBe('');
        expect(boardQueryProblem(make('', 'IsTodo()'), stored)).toBe('');
    });
});


// ---------------------------------------------------------------------------
// The Go twin's own cases (orgs cmd/oc/commands/kanban/model_test.go)
// ---------------------------------------------------------------------------

suite('what the Go twin pins', () => {
    test('auto colours match the browser, past 32 bits and outside the BMP', () => {
        const want: Record<string, string> = {
            'work': 'violet', 'Acme Corp': 'pink', 'urgent': 'violet',
            'héllo wörld': 'amber',
            'a-very-long-tag-name-that-overflows-32-bits-many-times': 'orange',
            '😀 emoji': 'teal',
            '': 'slate',
        };
        for (const k of Object.keys(want)) expect(autoSwatch(k).key).toBe(want[k]);
    });

    test('a drop between two numbered cards writes only its midpoint', () => {
        const b = board({});
        const list = [card({ Hash: 'a', Props: { KANBAN: '0' } }), card({ Hash: 'b', Props: { KANBAN: '100' } })];
        const m = card({ Hash: 'm', Props: {} });
        const w = planOrder(list, 1, m, b)!;
        expect(w.length).toBe(1);
        expect(w[0].value).toBe(50);
        expect(w[0].card.Hash).toBe('m');
        // A card above the drop with no number of its own: renumber the column.
        list[0] = card({ Hash: 'a', Props: {} });
        expect(planOrder(list, 1, m, b)!.length).toBe(3);
        // A board sorted any other way writes no order at all.
        expect(planOrder(list, 1, m, board({ sort: 'priority' }))).toBeNull();
    });

    test('default columns colour the first active blue and the first done green', () => {
        const cols = defaultStatusColumns({ active: ['TODO', 'IN-PROGRESS'], done: ['DONE'] }, ['INPROGRESS', 'WAITING']);
        expect(cols[1].aliases).toEqual(['INPROGRESS']);
        expect(cols[0].color).toBe('blue');
        expect(cols[3].color).toBe('green');
        expect(columnOf(card({ Status: 'inprogress' }), board({}), cols)).toBe('IN-PROGRESS');
    });

    test('header colours are the palette hexes', () => {
        expect(headerColorOf(card({ Props: { COLOR: 'teal' } }), board({}), true)).toBe('#12a594');
        expect(headerColorOf(card({ Props: { COLOUR: 'purple' } }), board({}), true)).toBe('#8e4ec6');
        const b = board({ headerKey: 'CLIENT', headerColors: { Acme: 'blue' } });
        expect(headerColorOf(card({ Props: { CLIENT: 'Acme', COLOR: 'red' } }), b, true)).toBe('#3e63dd');
    });

    test('labels from a property keep the board order, strays after', () => {
        const b = board({ labelSource: 'property', labelKey: 'labels', labelOrder: ['bug', 'ux'] });
        expect(labelsOf(card({ Props: { LABELS: 'ux, perf bug' } }), b)).toEqual(['bug', 'ux', 'perf']);
    });

    test('the expression sent to /search brackets the query', () => {
        const stored = [{ name: 'mine', query: 'IsTodo()' }];
        const b = board({ query: 'IsProject()', storedQuery: 'mine' });
        expect(searchExpr(b, stored)).toBe('!IsArchived() && (IsTodo())');
        expect(searchExpr({ ...b, includeArchived: true }, stored)).toBe('IsTodo()');
    });

    test('every word of a search has to be found', () => {
        const c = card({ Headline: 'Write the spec', Status: 'TODO', Props: { OWNER: 'ian' }, Tags: ['draft'] });
        expect(cardMatches(c, searchTerms('spec DRAFT ian'))).toBe(true);
        expect(cardMatches(c, searchTerms('spec bob'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The board as the view builds it
// ---------------------------------------------------------------------------

suite('the board the view draws', () => {
    test('a status board with no columns reads them off the server, catch-all first', () => {
        const b = board({ folded: ['DONE'] });
        const cols = boardColumns(b, { active: ['TODO'], done: ['DONE'] }, [card({ Status: 'WAITING' })]);
        expect(cols.map(c => c.value)).toEqual(['', 'TODO', 'WAITING', 'DONE']);
        expect(cols.find(c => c.value === 'DONE')!.collapsed).toBe(true);
        const buckets = bucketCards([card({ Hash: 'w', Status: 'WAITING' }), card({ Hash: 'n' })], b, cols);
        expect(buckets.get('WAITING')!.map(c => c.Hash)).toEqual(['w']);
        expect(buckets.get('')!.map(c => c.Hash)).toEqual(['n']);
    });

    test('a move is drawn before the server answers', () => {
        const tagBoard = board({ groupBy: 'tag' });
        expect(movedCard(card({ Tags: ['a', 'x'] }), tagBoard, 'a', 'b').Tags).toEqual(['x', 'b']);
        expect(movedCard(card({ Status: 'TODO' }), board({}), 'TODO', 'DONE').Status).toBe('DONE');
        expect(movedCard(card({}), board({ groupBy: 'property', groupKey: 'STAGE' }), '', 'Doing').Props!.STAGE).toBe('Doing');
        // A status board cannot take a keyword away from here.
        expect(dropRefused(board({}), '')).toBe(true);
        expect(dropRefused(board({ groupBy: 'tag' }), '')).toBe(false);
    });

    test('who a card is for, and how its dates read', () => {
        expect(assigneeOf(card({ Props: { OWNER: ' ian ' } }))).toBe('ian');
        expect(assigneeOf(card({}))).toBe('');
        const now = new Date(2026, 9, 12, 10, 0);
        expect(dateLabel('2026-10-12T00:00:00Z', now)).toBe('today');
        expect(dateLabel('2026-10-13T00:00:00Z', now)).toBe('tomorrow');
        expect(dateLabel('2026-10-15T00:00:00Z', now)).toBe('Thu');
        expect(dateLabel('2026-12-25T00:00:00Z', now)).toBe('Dec 25');
        expect(dateLabel('2027-01-25T00:00:00Z', now)).toBe('Jan 25 2027');
        expect(isOverdue('2026-10-11T00:00:00Z', now)).toBe(true);
        expect(isOverdue('2026-10-12T00:00:00Z', now)).toBe(false);
        expect(isSetDate({ Start: '0001-01-01T00:00:00Z' })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The checklist under a heading (worg/src/orgbody.test.ts)
// ---------------------------------------------------------------------------

const BODY = [
    '   :PROPERTIES:',
    '     :AUDIO: [[file:audio/note.wav]]',
    '   :END:',
    '   SCHEDULED: <2026-01-05 Mon>',
    '   Some words about it.',
    '   - [ ] First thing',
    '   - [X] Second thing',
    '     - [ ] Nested under it',
    '   - [-] Half done thing',
    '   More words.',
].join('\n');

suite('the checklist', () => {
    const list = checklistOf(BODY);

    test('leaves out the drawers and the planning line', () => {
        expect(bodyLines(BODY)).toEqual([
            '   Some words about it.',
            '   - [ ] First thing',
            '   - [X] Second thing',
            '     - [ ] Nested under it',
            '   - [-] Half done thing',
            '   More words.',
        ]);
    });

    test('leaves out a LOGBOOK too, so nothing offers to tick a clock line', () => {
        const text = ['   :LOGBOOK:', '   CLOCK: [2026-01-01 Thu 09:00]', '   :END:', '   - [ ] Real one'].join('\n');
        expect(checklistOf(text).total).toBe(1);
        expect(checklistOf(text).items[0].text).toBe('Real one');
    });

    test('survives a body with nothing in it', () => {
        expect(bodyLines('')).toEqual([]);
        expect(checklistOf('').total).toBe(0);
    });

    test('finds every box, counts the ticked ones and numbers them as the server does', () => {
        expect(list.total).toBe(4);
        expect(list.done).toBe(1);
        expect(list.items.map(i => i.text)).toEqual(['First thing', 'Second thing', 'Nested under it', 'Half done thing']);
        expect(list.items.map(i => i.index)).toEqual([0, 1, 2, 3]);
        expect(list.items[3].done).toBe(false);
        expect(checklistOf('- [x] one\n- [X] two').done).toBe(2);
        expect(list.items[0].depth).toBe(1);
        expect(list.items[2].depth).toBe(2);
    });

    test('takes the bullets org takes, and not a heading', () => {
        const text = [
            '  - [ ] dash',
            '  + [ ] plus',
            '  * [ ] star, indented',
            '  1. [ ] numbered',
            '  2) [ ] numbered the other way',
            '* [ ] a heading, not an item',
        ].join('\n');
        const l = checklistOf(text);
        expect(l.total).toBe(5);
        expect(l.items.map(i => i.text)).not.toContain('a heading, not an item');
        expect(checklistOf('Just some words.\n- a plain bullet').total).toBe(0);
    });
});
