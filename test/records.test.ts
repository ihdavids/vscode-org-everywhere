// The Records view's model, and docked worg following the cursor. No vscode:
// mocha --ui tdd out/test/records.test.js
import * as assert from 'assert';
import {
    OrgRecord, RecordField, RecordFieldUse, BirthdayEvent,
    collectionLabel, recordLabel, recordDescription, recordTooltip, sortRecords, sortFields,
    daysUntil, whenLabel, birthdayLabel, birthdayDescription, upcoming,
    formFields, inputType, validDate, validateForm, normKey, validKey, allValues, updateRequest, newRequest,
} from '../src/records-model';
import { revealAt, serverPath, sameReveal } from '../src/worg-follow-model';

function field(key: string, kind: string, value: string, label = ''): RecordField {
    return { Key: key, Name: key.split('_')[0], Label: label, Kind: kind, Value: value };
}

const jane: OrgRecord = {
    Hash: 'h1', Type: 'contact', Name: 'Jane Roe', Filename: '/o/people.org', LineNum: 4,
    Fields: [
        field('NOTE', 'text', 'met at the fair'),
        field('EMAIL', 'email', 'jane@example.com'),
        field('PHONE_MOBILE', 'tel', '+1 555 0100', 'MOBILE'),
        field('ADDRESS', 'postal', '1 High St\nTown'),
    ],
    Tags: ['friend'],
    Notes: 'Likes tea.',
};

function bday(name: string, date: string, age = 0, fieldName = 'BIRTHDAY'): BirthdayEvent {
    return { Hash: name, Name: name, Type: 'contact', Filename: '/o/p.org', LineNum: 1, Date: date, Birthday: date, Age: age, Field: fieldName };
}

suite('Records', () => {
    test('collections and records are labelled', () => {
        assert.strictEqual(collectionLabel({ Type: 'synth', Name: 'Synthesisers', Icon: '🎹', Hash: '', Filename: '', LineNum: 0, Count: 2 }), '🎹 Synthesisers');
        assert.strictEqual(collectionLabel({ Type: 'synth', Name: '', Icon: '', Hash: '', Filename: '', LineNum: 0, Count: 2 }), 'synth');
        assert.strictEqual(recordLabel({ Name: '  ' }), '(untitled)');
        assert.deepStrictEqual(sortRecords([{ Name: 'bob' }, { Name: 'Alice' }, { Name: 'carl' }]).map(r => r.Name), ['Alice', 'bob', 'carl']);
    });

    test('the description is the key fields, else the phone and email', () => {
        assert.strictEqual(recordDescription(jane), '+1 555 0100 · jane@example.com');
        assert.strictEqual(recordDescription(jane, ['ADDRESS', 'MISSING']), '1 High St, Town');
        assert.strictEqual(recordDescription({ ...jane, Fields: [] }), '');
        assert.deepStrictEqual(sortFields(jane.Fields).map(f => f.Key), ['PHONE_MOBILE', 'EMAIL', 'ADDRESS', 'NOTE']);
        const tip = recordTooltip(jane);
        assert.ok(tip.indexOf('phone · mobile: +1 555 0100') >= 0, tip);
        assert.ok(tip.endsWith(':friend:'));
    });

    test('birthdays coming up, soonest first', () => {
        const today = '2026-10-25';
        assert.strictEqual(daysUntil('2026-10-28', today), 3);
        assert.strictEqual(daysUntil('2027-01-01', '2026-12-31'), 1);
        assert.strictEqual(daysUntil('nope', today), undefined);
        assert.strictEqual(whenLabel(0), 'today');
        assert.strictEqual(whenLabel(1), 'tomorrow');
        assert.strictEqual(whenLabel(9), 'in 9 days');
        const list = upcoming([bday('Late', '2026-12-30'), bday('Soon', '2026-10-26', 40), bday('Now', '2026-10-25'), bday('Past', '2026-10-01')], today, 30);
        assert.deepStrictEqual(list.map(b => b.Name), ['Now', 'Soon']);
        assert.strictEqual(birthdayLabel(bday('Soon', '2026-10-26', 40)), 'Soon turns 40');
        assert.strictEqual(birthdayLabel(bday('Now', '2026-10-25')), "Now's birthday");
        assert.strictEqual(birthdayLabel(bday('Al', '2026-10-25', 10, 'ANNIVERSARY')), "Al's anniversary (10 years)");
        assert.strictEqual(birthdayDescription(bday('Soon', '2026-10-26'), today), 'tomorrow · 2026-10-26');
    });

    test('the form: declared fields, then the record\'s, then the most used', () => {
        const uses: RecordFieldUse[] = [
            { Key: 'TWITTER', Name: 'TWITTER', Label: '', Kind: 'social', Count: 1 },
            { Key: 'BIRTHDAY', Name: 'BIRTHDAY', Label: '', Kind: 'date', Count: 9 },
            { Key: 'RECORD', Name: 'RECORD', Label: '', Kind: 'text', Count: 20 },
        ];
        const f = formFields(uses, jane, ['EMAIL', 'COMPANY']);
        assert.deepStrictEqual(f.map(x => x.key), ['EMAIL', 'COMPANY', 'NOTE', 'PHONE_MOBILE', 'ADDRESS', 'BIRTHDAY', 'TWITTER']);
        assert.strictEqual(f[0].value, 'jane@example.com');
        assert.strictEqual(f[1].value, '');
        assert.strictEqual(f[3].label, 'phone · mobile');
        assert.strictEqual(f[5].kind, 'date');
        assert.deepStrictEqual(formFields(uses).map(x => x.key), ['BIRTHDAY', 'TWITTER']);
        assert.strictEqual(inputType('postal'), 'textarea');
        assert.strictEqual(inputType('email'), 'email');
        assert.strictEqual(inputType('social'), 'text');
    });

    test('the form is checked before it is sent', () => {
        assert.ok(validDate('1990-05-15'));
        assert.ok(validDate('<1990-05-15 Tue>'));
        assert.ok(validDate('--05-15'));
        assert.ok(!validDate('15/05/1990'));
        assert.ok(!validDate('--13-01'));
        assert.strictEqual(normKey(' phone mobile '), 'PHONE_MOBILE');
        assert.ok(validKey('PHONE_2'));
        assert.ok(!validKey('2PHONE'));
        assert.ok(!validKey('ID'));
        const kinds = { EMAIL: 'email', BIRTHDAY: 'date', PHONE: 'tel', SITE: 'url' };
        assert.deepStrictEqual(validateForm({ name: 'Jane', fields: { EMAIL: 'jane@example.com', BIRTHDAY: '', PHONE: '+1 (555) 0100' } }, kinds), {});
        const errs = validateForm({
            name: ' ',
            fields: { EMAIL: 'jane', BIRTHDAY: 'May', PHONE: 'call me', SITE: 'a b' },
            extra: [{ key: '', value: '' }, { key: 'email', value: 'x' }, { key: '9x', value: 'y' }, { key: 'added', value: 'z' }, { key: 'nick name', value: 'J' }],
        }, kinds);
        assert.deepStrictEqual(Object.keys(errs).sort(), ['BIRTHDAY', 'EMAIL', 'PHONE', 'SITE', 'extra:1', 'extra:2', 'extra:3', 'name']);
    });

    test('an edit sends only what changed', () => {
        assert.strictEqual(updateRequest(jane, { name: 'Jane Roe', notes: 'Likes tea.', fields: { EMAIL: 'jane@example.com' } }), undefined);
        const req = updateRequest(jane, {
            name: 'Jane Smith', notes: 'Likes coffee.',
            fields: { EMAIL: 'jane@example.com', PHONE_MOBILE: '', COMPANY: '' },
            extra: [{ key: 'nick', value: ' JJ ' }],
        });
        assert.deepStrictEqual(req, { Hash: 'h1', Set: { PHONE_MOBILE: '', NICK: 'JJ' }, SetName: true, Name: 'Jane Smith', SetNotes: true, Notes: 'Likes coffee.' });
        assert.deepStrictEqual(allValues({ name: 'x', fields: { a: ' 1 ' } }), { A: '1' });
    });

    test('a new record carries the fields with something in them', () => {
        assert.deepStrictEqual(newRequest('contact', { name: ' Ann ', notes: '', fields: { EMAIL: 'a@b.c', PHONE: '' }, extra: [{ key: 'x', value: '1' }] }),
            { Type: 'contact', Name: 'Ann', Fields: { EMAIL: 'a@b.c', X: '1' } });
    });
});

suite('Worg follows the cursor', () => {
    const lines = ['#+TITLE: x', 'intro', '* TODO [#A] Top :work:', 'text', '** Child', 'more', '* Other'];

    test('the heading the cursor is in, with its outline path', () => {
        assert.strictEqual(revealAt(lines, 1, '/o/a.org'), undefined);
        assert.deepStrictEqual(revealAt(lines, 3, '/o/a.org'), { type: 'worg:reveal', file: '/o/a.org', line: 2, olp: ['Top'], heading: 'Top' });
        assert.deepStrictEqual(revealAt(lines, 5, '/o/a.org'), { type: 'worg:reveal', file: '/o/a.org', line: 4, olp: ['Top', 'Child'], heading: 'Child' });
        assert.ok(sameReveal(revealAt(lines, 4, 'f'), revealAt(lines, 5, 'f')));
        assert.ok(!sameReveal(revealAt(lines, 4, 'f'), revealAt(lines, 6, 'f')));
        assert.ok(!sameReveal(undefined, revealAt(lines, 6, 'f')));
    });

    test('a local path is named as the server names it', () => {
        assert.strictEqual(serverPath('/home/me/org/a.org'), '/home/me/org/a.org');
        assert.strictEqual(serverPath('/Users/me/org/sub/a.org', { '/srv/org/': '/Users/me/org' }), '/srv/org/sub/a.org');
        assert.strictEqual(serverPath('/Users/me/orgx/a.org', { '/srv/org': '/Users/me/org' }), '/Users/me/orgx/a.org');
        assert.strictEqual(serverPath('C:\\org\\a.org', { '/srv/org': 'C:\\org' }), '/srv/org/a.org');
    });
});
