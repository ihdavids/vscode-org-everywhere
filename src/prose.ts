// Prose checking for org files, as worg's writing mode does it: only the
// prose is read (prose-model.ts), worg's built-in grammar and style rules run
// here (prose-rules-model.ts), and Harper runs on the orgs server (POST
// /harper/lint) when it has it. What they find are diagnostics, with quick
// fixes for their suggestions and "ignore this word / rule".
//
// - org.proseCheck: off (the default - prose rules on a TODO list would only
//   be noise), onSave or onType. Org: Check Prose In File runs once whatever
//   it says, and Org: Toggle Prose Check switches it on and off.
// - As you type only the paragraphs on screen are checked, a moment after
//   typing stops; answers are cached by paragraph text, so a paragraph is
//   asked about again only when it changes. In between, the diagnostics of
//   paragraphs that did not change are moved with them.
// - Harper is asked quietly: no server, no login, or no Harper on it, and
//   the built-in rules carry on alone. Its spelling and grammar replace the
//   built-in rules' where both mark the same words.

import * as vscode from 'vscode';
import { URL } from 'url';
import { Request, Headers } from 'node-fetch';
import { Auth, orgsAgent } from './auth';
import { Sets } from './sets';
import {
    walk, todoStates, paragraphs, issueRange, harperIssues, harperKey, harperText, mergeHarper, kept, ruleName,
    Issue, HarperLint, Prose,
} from './prose-model';
import { localIssues, nameIndex } from './prose-rules-model';

const fetchModule = import('node-fetch');
async function fetch(req: Request): Promise<any> {
    return (await fetchModule).default(req as any);
}

type Mode = 'off' | 'onSave' | 'onType';
type Scope = 'cached' | 'visible' | 'all';

function conf() {
    const c = vscode.workspace.getConfiguration('org');
    return {
        mode: c.get<Mode>('proseCheck', 'off'),
        dialect: c.get<string>('proseDialect', 'american'),
        harper: c.get<boolean>('proseHarper', true),
        style: c.get<boolean>('proseStyle', true),
        ignoreWords: c.get<string[]>('proseIgnoreWords', []) || [],
        ignoreRules: c.get<string[]>('proseIgnoreRules', []) || [],
        todo: (c.get<string[]>('todoKeywords', []) || []),
        done: (c.get<string[]>('doneKeywords', []) || []),
    };
}

// ---------------------------------------------------------------------------
// The server, asked quietly
// ---------------------------------------------------------------------------

// A request that never shows a login page or an error: undefined when the
// server is not there, not logged in to, or did not answer.
async function quietly(path: string, body?: any): Promise<any> {
    if (!Auth.get().isLoggedIn()) {
        return undefined;
    }
    try {
        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        headers.set('Accept', 'application/json');
        const token = Auth.get().getToken();
        if (token) {
            headers.set('Authorization', 'Bearer ' + token);
        }
        const res = await fetch(new Request(new URL(Sets.orgsConnection + path).toString(), {
            method: body === undefined ? 'GET' : 'POST',
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            agent: orgsAgent(),
        }));
        return res.ok ? await res.json() : undefined;
    } catch (e) {
        return undefined;
    }
}

// Whether the server has Harper: asked once per server, and again when the
// login changes. null while not known.
let serverHas: boolean | null = null;
let statusFor = '';
let asking = false;
// After a failed batch Harper is left alone for a while rather than asked
// (and waited on) for every paragraph typed.
let restUntil = 0;

const harperCache = new Map<string, Issue[] | 'failed'>();
const pending = new Map<string, string>();   // key -> text
let flushTimer: NodeJS.Timeout | undefined;

function remember<V>(m: Map<string, V>, k: string, v: V) {
    if (m.size > 3000) {
        m.delete(m.keys().next().value as string);
    }
    m.set(k, v);
}

function harperReady(): boolean {
    if (statusFor !== Sets.orgsConnection) {
        statusFor = Sets.orgsConnection;
        serverHas = null;
    }
    if (serverHas === null && !asking && Auth.get().isLoggedIn()) {
        asking = true;
        quietly('/harper/status').then(r => {
            serverHas = r === undefined ? null : !!(r.Ok && r.Enabled);
        }).finally(() => {
            asking = false;
            if (serverHas) {
                refreshAll('visible');
            }
        });
    }
    return serverHas === true && Date.now() >= restUntil;
}

function askHarper(key: string, text: string) {
    if (pending.has(key)) {
        return;
    }
    pending.set(key, text);
    if (!flushTimer) {
        // Every paragraph on screen is asked for in one go: gather them.
        flushTimer = setTimeout(flush, 50);
    }
}

async function flush() {
    flushTimer = undefined;
    const c = conf();
    const off = c.ignoreRules.map(ruleName);
    const all = Array.from(pending.entries());
    let answered = false;
    for (let i = 0; i < all.length; i += 40) {
        const part = all.slice(i, i + 40);
        const r = await quietly('/harper/lint', { Texts: part.map(([, t]) => harperText(t)), Dialect: c.dialect, Off: off });
        part.forEach(([k]) => pending.delete(k));
        if (r === undefined) {
            // Not there, or not logged in: asked again another time.
            continue;
        }
        if (!r.Ok || !Array.isArray(r.Lints)) {
            part.forEach(([k]) => remember(harperCache, k, 'failed'));
            restUntil = Date.now() + 2 * 60 * 1000;
            console.log('orgs: Harper: ' + ((r && r.Msg) || 'no answer'));
            break;
        }
        part.forEach(([k], n) => remember(harperCache, k, harperIssues((r.Lints[n] || []) as HarperLint[])));
        answered = true;
    }
    pending.clear();
    if (answered) {
        refreshAll('cached');
    }
}

// ---------------------------------------------------------------------------
// Checking a document
// ---------------------------------------------------------------------------

type Found = { range: vscode.Range; issue: Issue };

const localCache = new Map<string, Issue[]>();
let collection: vscode.DiagnosticCollection;
// What each document's diagnostics came from, for the quick fixes.
const found = new Map<string, Found[]>();
// Documents checked by hand while the setting is off: their diagnostics keep
// following the text until it is next checked.
const checkedByHand = new Set<string>();

function isOrg(doc: vscode.TextDocument): boolean {
    return doc.languageId === 'org';
}

function visibleLines(doc: vscode.TextDocument): [number, number][] {
    const out: [number, number][] = [];
    for (const e of vscode.window.visibleTextEditors) {
        if (e.document === doc) {
            e.visibleRanges.forEach(r => out.push([r.start.line, r.end.line]));
        }
    }
    return out;
}

function cursorIn(doc: vscode.TextDocument, r: vscode.Range): boolean {
    const e = vscode.window.activeTextEditor;
    return !!e && e.document === doc && r.contains(e.selection.active);
}

// Check one document. 'all' checks every paragraph, 'visible' those on
// screen, 'cached' none: it only places what is known for the text now.
// The number of issues found.
function check(doc: vscode.TextDocument, scope: Scope): number {
    const c = conf();
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const states = walk(lines);
    const todo = todoStates(text, c.todo, c.done);
    const names = nameIndex(lines, states, todo);
    const namesSig = Array.from(names.entries()).sort().map(([k, n]) => `${k}${n}`).join(',');
    const rules = { grammar: true, style: c.style };
    const useHarper = c.harper && harperReady();
    const off = c.ignoreRules.map(ruleName);
    const shown = scope === 'visible' ? visibleLines(doc) : [];
    const typing = c.mode === 'onType';

    const diags: vscode.Diagnostic[] = [];
    const list: Found[] = [];
    for (const p of paragraphs(lines, states, todo)) {
        const wanted = scope === 'all' || (scope === 'visible' && shown.some(([a, b]) => p.first <= b && p.last >= a));
        const lk = `${c.style ? 1 : 0}|${namesSig}\n${p.text}`;
        let local = localCache.get(lk);
        if (!local && wanted) {
            local = localIssues(p.text, names, rules);
            remember(localCache, lk, local);
        }
        if (!local) {
            continue;
        }
        let issues = local;
        if (c.harper) {
            const hk = harperKey(c.dialect, off, p.text);
            const h = harperCache.get(hk);
            if (h === undefined && wanted && useHarper) {
                askHarper(hk, p.text);
            }
            if (Array.isArray(h)) {
                issues = mergeHarper(local, h, (f, t) => (names.get(p.text.slice(f, t)) || 0) >= 3);
            }
        }
        for (const i of issues) {
            const d = toDiagnostic(doc, p, i, c.ignoreWords, c.ignoreRules, typing);
            if (d) {
                diags.push(d);
                list.push({ range: d.range, issue: i });
            }
        }
    }
    collection.set(doc.uri, diags);
    found.set(doc.uri.toString(), list);
    return diags.length;
}

function toDiagnostic(doc: vscode.TextDocument, p: Prose, i: Issue, words: string[], rules: string[], typing: boolean): vscode.Diagnostic | undefined {
    const r = issueRange(p, i.from, i.to);
    if (!r || r.end.line >= doc.lineCount) {
        return undefined;
    }
    const range = new vscode.Range(r.start.line, r.start.col, r.end.line, r.end.col);
    const word = doc.getText(range);
    if (!kept(i, word, words, rules)) {
        return undefined;
    }
    // The word being typed is not misspelt yet.
    if (typing && i.kind === 'spell' && cursorIn(doc, range)) {
        return undefined;
    }
    const d = new vscode.Diagnostic(range, i.msg, i.kind === 'style' ? vscode.DiagnosticSeverity.Hint : vscode.DiagnosticSeverity.Information);
    d.source = i.rule.startsWith('harper:') ? 'Harper' : 'prose';
    d.code = ruleName(i.rule);
    return d;
}

function refresh(doc: vscode.TextDocument, scope: Scope) {
    if (!isOrg(doc)) {
        return;
    }
    const mode = conf().mode;
    if (mode === 'off' && !checkedByHand.has(doc.uri.toString())) {
        return;
    }
    check(doc, mode === 'off' ? 'cached' : scope);
}

function refreshAll(scope: Scope) {
    const seen = new Set<vscode.TextDocument>();
    vscode.window.visibleTextEditors.forEach(e => seen.add(e.document));
    for (const doc of seen) {
        refresh(doc, scope);
    }
    // Documents not on screen keep what they had, moved to the text now.
    vscode.workspace.textDocuments.filter(d => !seen.has(d) && found.has(d.uri.toString())).forEach(d => refresh(d, 'cached'));
}

function clearAll() {
    collection.clear();
    found.clear();
    checkedByHand.clear();
}

// ---------------------------------------------------------------------------
// Quick fixes
// ---------------------------------------------------------------------------

class ProseFixes implements vscode.CodeActionProvider {
    provideCodeActions(doc: vscode.TextDocument, range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
        const list = found.get(doc.uri.toString()) || [];
        const out: vscode.CodeAction[] = [];
        for (const d of ctx.diagnostics) {
            if (d.source !== 'prose' && d.source !== 'Harper') {
                continue;
            }
            const f = list.find(x => x.range.isEqual(d.range) && x.issue.msg === d.message);
            if (!f) {
                continue;
            }
            const word = doc.getText(d.range);
            f.issue.fixes.forEach((fix, n) => {
                const a = new vscode.CodeAction(fix === '' ? `Remove “${word.trim()}”` : `Replace with “${fix}”`, vscode.CodeActionKind.QuickFix);
                a.edit = new vscode.WorkspaceEdit();
                a.edit.replace(doc.uri, d.range, fix);
                a.diagnostics = [d];
                a.isPreferred = n === 0;
                out.push(a);
            });
            if (f.issue.kind === 'spell' && word.trim()) {
                const a = new vscode.CodeAction(`Ignore “${word}”`, vscode.CodeActionKind.QuickFix);
                a.command = { command: 'org.proseIgnoreWord', title: a.title, arguments: [word] };
                a.diagnostics = [d];
                out.push(a);
            }
            const rule = ruleName(f.issue.rule);
            const a = new vscode.CodeAction(`Ignore the rule “${rule}”`, vscode.CodeActionKind.QuickFix);
            a.command = { command: 'org.proseIgnoreRule', title: a.title, arguments: [rule] };
            a.diagnostics = [d];
            out.push(a);
        }
        return out;
    }
}

// A setting changed where the user keeps it: the workspace's if it has its
// own, else the user's.
async function updateSetting(key: string, value: any) {
    const c = vscode.workspace.getConfiguration('org');
    const i = c.inspect(key);
    const target = i && i.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await c.update(key, value, target);
}

async function addTo(key: string, value: string) {
    const now = vscode.workspace.getConfiguration('org').get<string[]>(key, []) || [];
    if (value && !now.includes(value)) {
        await updateSetting(key, [...now, value]);
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function checkFile() {
    const e = vscode.window.activeTextEditor;
    if (!e || !isOrg(e.document)) {
        vscode.window.showInformationMessage('Org: Check Prose In File works on an org file.');
        return;
    }
    // A manual check asks Harper again about what it failed on.
    harperCache.forEach((v, k) => { if (v === 'failed') { harperCache.delete(k); } });
    restUntil = 0;
    if (conf().mode === 'off') {
        checkedByHand.add(e.document.uri.toString());
    }
    const n = check(e.document, 'all');
    const c = conf();
    const harper = !c.harper ? 'Harper off' : serverHas ? (pending.size ? `asking Harper about ${pending.size} paragraphs` : 'with Harper')
        : 'built-in rules only (no Harper on the server)';
    vscode.window.setStatusBarMessage(`Prose: ${n} issue${n === 1 ? '' : 's'}, ${harper}`, 5000);
}

async function toggle(context: vscode.ExtensionContext) {
    const mode = conf().mode;
    if (mode === 'off') {
        const next = context.globalState.get<Mode>('org.proseCheckLast', 'onType');
        await updateSetting('proseCheck', next);
        vscode.window.setStatusBarMessage(`Prose check: ${next === 'onSave' ? 'on save' : 'as you type'}`, 3000);
    } else {
        await context.globalState.update('org.proseCheckLast', mode);
        await updateSetting('proseCheck', 'off');
        vscode.window.setStatusBarMessage('Prose check: off', 3000);
    }
}

export function activateProse(context: vscode.ExtensionContext) {
    collection = vscode.languages.createDiagnosticCollection('org-prose');
    context.subscriptions.push(collection);

    let typingTimer: NodeJS.Timeout | undefined;
    let typingDoc: vscode.TextDocument | undefined;
    const later = (doc: vscode.TextDocument, scope: Scope, ms: number) => {
        if (typingTimer) {
            clearTimeout(typingTimer);
            // Another document waiting gets what is known now.
            if (typingDoc && typingDoc !== doc) {
                refresh(typingDoc, 'cached');
            }
        }
        typingDoc = doc;
        typingTimer = setTimeout(() => { typingTimer = undefined; refresh(doc, scope); }, ms);
    };

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider({ language: 'org' }, new ProseFixes(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
        vscode.commands.registerCommand('org.checkProse', checkFile),
        vscode.commands.registerCommand('org.toggleProseCheck', () => toggle(context)),
        vscode.commands.registerCommand('org.proseIgnoreWord', (w: string) => addTo('proseIgnoreWords', w)),
        vscode.commands.registerCommand('org.proseIgnoreRule', (r: string) => addTo('proseIgnoreRules', r)),
        vscode.workspace.onDidChangeTextDocument(ev => {
            if (!isOrg(ev.document) || ev.contentChanges.length === 0) {
                return;
            }
            const mode = conf().mode;
            if (mode === 'onType') {
                later(ev.document, 'visible', 400);
            } else {
                // Unchanged paragraphs keep their diagnostics, moved to where
                // they are now; a changed one waits for the save.
                later(ev.document, 'cached', 150);
            }
        }),
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (isOrg(doc) && conf().mode === 'onSave') {
                check(doc, 'all');
            }
        }),
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (isOrg(doc) && conf().mode === 'onSave') {
                check(doc, 'all');
            }
        }),
        vscode.window.onDidChangeVisibleTextEditors(() => {
            if (conf().mode !== 'off') {
                refreshAll(conf().mode === 'onType' ? 'visible' : 'cached');
            }
        }),
        vscode.window.onDidChangeTextEditorVisibleRanges(ev => {
            if (isOrg(ev.textEditor.document) && conf().mode === 'onType') {
                later(ev.textEditor.document, 'visible', 250);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            collection.delete(doc.uri);
            found.delete(doc.uri.toString());
            checkedByHand.delete(doc.uri.toString());
        }),
        vscode.workspace.onDidChangeConfiguration(ev => {
            if (ev.affectsConfiguration('org.proseCheck')) {
                clearAll();
                const mode = conf().mode;
                if (mode === 'onSave') {
                    vscode.workspace.textDocuments.filter(isOrg).forEach(d => check(d, 'all'));
                } else if (mode === 'onType') {
                    refreshAll('visible');
                }
            } else if (['proseDialect', 'proseHarper', 'proseStyle', 'proseIgnoreWords', 'proseIgnoreRules', 'orgsConnection']
                .some(k => ev.affectsConfiguration('org.' + k))) {
                refreshAll(conf().mode === 'onSave' ? 'all' : 'visible');
            }
        }),
        // A login (or a server that needs none) may bring Harper with it.
        Auth.get().onAccessChanged(() => { serverHas = null; refreshAll('visible'); }),
        Auth.get().onTokenChanged(() => { serverHas = null; refreshAll('visible'); }),
    );

    const mode = conf().mode;
    if (mode === 'onSave') {
        vscode.workspace.textDocuments.filter(isOrg).forEach(d => check(d, 'all'));
    } else if (mode === 'onType') {
        refreshAll('visible');
    }
}
