// The assistant's model (src/assistant-model.ts), after worg's
// assistant.test.ts. No vscode: mocha --ui tdd out/test/assistant.test.js
import * as assert from 'assert';
import {
    NdjsonLines, buildRequest, editorRequest, buildViewRequest, forManuscript, actionReady, QUICK_ACTIONS,
    sectionAt, sectionByPath, placeEdit, applyChanges, pickBackend, unavailable, renderMarkdown, modelLabel, whereOf,
    AssistantStatus,
} from '../src/assistant-model';

suite('Assistant', () => {
    test('ndjson split across chunks', () => {
        const l = new NdjsonLines();
        assert.deepStrictEqual(l.push('{"t":"Hel'), []);
        assert.deepStrictEqual(l.push('lo"}\n{"t":" there"}\n{"do'), [{ t: 'Hello' }, { t: ' there' }]);
        assert.deepStrictEqual(l.push('ne":true}', true), [{ done: true }]);
    });

    const base = {
        backend: 'claude', model: '', messages: [{ Role: 'user' as const, Text: 'hi' }], file: '/n/novel.org', title: 'Novel',
        doc: 'WHOLE', section: { path: 'Part one/The letter', text: 'SECTION' }, selection: '', others: [] as string[],
    };

    test('scope picks what is sent', () => {
        const s = buildRequest({ ...base, scope: 'section' });
        assert.strictEqual(s.Context, 'SECTION');
        assert.strictEqual(s.Section, 'Part one/The letter');
        assert.strictEqual(buildRequest({ ...base, scope: 'file' }).Context, 'WHOLE');
        assert.strictEqual(buildRequest({ ...base, scope: 'none' }).Context, '');
        const f = buildRequest({ ...base, scope: 'section', section: null });
        assert.strictEqual(f.Scope, 'file');
        assert.strictEqual(f.Context, 'WHOLE');
    });

    test('only files allowed are sent, never the file itself twice', () => {
        assert.deepStrictEqual(buildRequest({ ...base, scope: 'none', others: ['/n/novel.org', '/n/world.org'] }).Others, ['/n/world.org']);
    });

    test('a backend with tools gets the editor text and only editable files it may read', () => {
        const r = buildRequest({ ...base, scope: 'none', others: ['/n/world.org'], tools: true, edit: ['/n/novel.org', '/n/world.org', '/n/secret.org'] });
        assert.strictEqual(r.Doc, 'WHOLE');
        assert.deepStrictEqual(r.Edit, ['/n/novel.org', '/n/world.org']);
        const plain = buildRequest({ ...base, scope: 'none', edit: ['/n/novel.org'] });
        assert.strictEqual(plain.Doc, undefined);
        assert.strictEqual(plain.Edit, undefined);
    });

    const lines = ['#+TITLE: Novel', 'Intro.', '* Part one', '** The letter', 'She read it.', 'Twice.', '** The reply', 'Nothing.', '* Part two'];
    const ed = { backend: 'claude', model: 'm', messages: base.messages, file: '/n/novel.org', title: 'Novel', lines };

    test('the subtree the cursor is in, by its path', () => {
        const s = sectionAt(lines, 5);
        assert.deepStrictEqual(s, { path: 'Part one/The letter', olp: ['Part one', 'The letter'], text: '** The letter\nShe read it.\nTwice.', start: 3, end: 6 });
        assert.strictEqual(sectionByPath(['* A/B', 'x'], ['A/B']).start, 0);
        assert.strictEqual(sectionAt(lines, 1), null);
        assert.strictEqual(sectionAt(lines, 2).end, 8);
        assert.deepStrictEqual(sectionByPath(['x', ...lines], 'Part one/The letter').start, 4);
        assert.strictEqual(sectionByPath(lines, 'Part three'), null);
    });

    test('only the chosen scope goes from the editor', () => {
        const sel = { text: 'She read it.', startLine: 4, endLine: 4 };
        const a = editorRequest({ ...ed, scope: 'selection', selection: sel, section: sectionAt(lines, 4) });
        assert.strictEqual(a.Scope, 'none');
        assert.strictEqual(a.Context, '');
        assert.strictEqual(a.Selection, 'She read it.');
        assert.strictEqual(a.Doc, undefined);
        const b = editorRequest({ ...ed, scope: 'section', selection: sel, section: sectionAt(lines, 4) });
        assert.strictEqual(b.Context, '** The letter\nShe read it.\nTwice.');
        assert.strictEqual(b.Selection, 'She read it.');
        // A selection outside the subtree stays home.
        const c = editorRequest({ ...ed, scope: 'section', selection: { text: 'Intro.', startLine: 1, endLine: 1 }, section: sectionAt(lines, 4) });
        assert.strictEqual(c.Selection, '');
        const d = editorRequest({ ...ed, scope: 'file', selection: null, section: null });
        assert.strictEqual(d.Context, lines.join('\n'));
        assert.throws(() => editorRequest({ ...ed, scope: 'selection', selection: { text: ' ', startLine: 0, endLine: 0 }, section: null }));
        assert.throws(() => editorRequest({ ...ed, scope: 'section', selection: null, section: null }));
        // Edits allowed: the tools backend gets the text and this file to change.
        const e = editorRequest({ ...ed, scope: 'selection', selection: sel, section: null, tools: true, allowEdit: true });
        assert.strictEqual(e.Doc, lines.join('\n'));
        assert.deepStrictEqual(e.Edit, ['/n/novel.org']);
        assert.strictEqual(editorRequest({ ...ed, scope: 'selection', selection: sel, section: null, tools: true }).Doc, undefined);
    });

    test('a view request carries the view and nothing of a file', () => {
        const r = buildViewRequest({ backend: 'chatgpt', model: '', messages: base.messages, view: { Kind: 'search', Query: 'IsTodo()', File: 'x', Selected: [] }, edit: true });
        assert.deepStrictEqual(r.View, { Kind: 'search', Query: 'IsTodo()', Edit: true });
        assert.strictEqual(r.Scope, 'none');
        const c = buildViewRequest({ backend: 'chatgpt', model: '', messages: base.messages, view: { Kind: 'columns', File: '/n/a.org', Query: 'q' }, edit: false, numCtx: 8192 });
        assert.deepStrictEqual(c.View, { Kind: 'columns', File: '/n/a.org', Edit: false });
        assert.strictEqual(c.NumCtx, 8192);
    });

    test('manuscript answers lose fences and wrapping quotes', () => {
        assert.strictEqual(forManuscript('```org\nShe ran.\n```'), 'She ran.');
        assert.strictEqual(forManuscript('“She ran.”'), 'She ran.');
        assert.strictEqual(forManuscript('“Run,” she said. “Now.”'), '“Run,” she said. “Now.”');
    });

    test('actions that need a selection wait for one', () => {
        const rephrase = QUICK_ACTIONS.find(a => a.id === 'rephrase');
        assert.strictEqual(actionReady(rephrase, false), false);
        assert.strictEqual(actionReady(rephrase, true), true);
    });

    test('an edit lands where it was made, or where its text has moved to', () => {
        const doc = 'He was very old. The lamp was out.';
        const e = { old: 'very old', changes: [{ from: 7, to: 15, insert: 'seventy' }] };
        assert.deepStrictEqual(placeEdit(doc, e), e.changes);
        assert.deepStrictEqual(placeEdit('Yes. ' + doc, e), [{ from: 12, to: 20, insert: 'seventy' }]);
        assert.strictEqual(placeEdit('He was ancient.', e), null);
        assert.strictEqual(placeEdit('very old, very old', { ...e, changes: [{ from: 40, to: 48, insert: 'x' }] }), null);
        const all = { old: 'a', changes: [{ from: 0, to: 1, insert: 'b' }, { from: 9, to: 10, insert: 'b' }] };
        assert.deepStrictEqual(placeEdit('xa a', all), [{ from: 1, to: 2, insert: 'b' }, { from: 3, to: 4, insert: 'b' }]);
        assert.strictEqual(applyChanges(doc, placeEdit(doc, e)), 'He was seventy. The lamp was out.');
        assert.strictEqual(applyChanges('xa a', [{ from: 1, to: 2, insert: 'bb' }, { from: 3, to: 4, insert: 'c' }]), 'xbb c');
    });

    const status: AssistantStatus = {
        Ok: true, Default: 'chatgpt', Backends: [
            { Name: 'claude', Label: 'Claude', Model: 'c1', Models: ['c1', 'c2'], Ready: true },
            { Name: 'chatgpt', Label: 'ChatGPT', Model: 'g1', Models: ['g1'], Ready: true, Views: true },
            { Name: 'gemini', Label: 'Gemini', Model: 'x', Models: ['x'], Ready: false, Msg: 'no key' },
            { Name: 'local', Label: 'Local', Model: 'llamacpp:Q', Models: ['llamacpp:Q'], Ready: true, Where: 'network', ModelWhere: { 'llamacpp:Q': 'machine' } },
        ],
    };

    test('the backend: the one asked for if ready, else the default', () => {
        assert.strictEqual(pickBackend(status, 'claude', 'c2').model, 'c2');
        assert.strictEqual(pickBackend(status, 'claude', 'nope').model, 'c1');
        assert.strictEqual(pickBackend(status, 'gemini').backend.Name, 'chatgpt');
        assert.strictEqual(pickBackend(status, 'claude', '', true).backend.Name, 'chatgpt');
        assert.strictEqual(pickBackend({ Ok: true, Off: true }), undefined);
        assert.strictEqual(unavailable(status), '');
        assert.match(unavailable({ Ok: true, Off: true }), /turned off/);
        assert.match(unavailable({ Ok: true, Backends: [status.Backends[2]] }), /No assistant backend/);
        assert.match(unavailable(undefined), /did not answer/);
        assert.strictEqual(modelLabel('local', 'llamacpp:Q'), 'Q · llama.cpp');
        assert.strictEqual(whereOf(status.Backends[3], 'llamacpp:Q'), 'machine');
        assert.strictEqual(whereOf(status.Backends[0]), 'cloud');
    });

    test('replies are drawn safely', () => {
        assert.strictEqual(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
        assert.strictEqual(renderMarkdown('**Bold** and `<b>`'), '<p><strong>Bold</strong> and <code>&lt;b&gt;</code></p>');
        assert.strictEqual(renderMarkdown('- one\n- two'), '<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
        assert.strictEqual(renderMarkdown('```js\na < b\n```'), '<pre><code>a &lt; b</code></pre>');
        assert.strictEqual(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
        assert.strictEqual(renderMarkdown('[x](https://a.b/"onmouseover)'), '<p><a href="https://a.b/&quot;onmouseover">x</a></p>');
        assert.strictEqual(renderMarkdown('* Heading\nSome /org/ text'), '<h3>Heading</h3>\n<p>Some <em>org</em> text</p>');
        assert.strictEqual(renderMarkdown('1. a\n2. b'), '<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
    });
});
