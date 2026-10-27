// Org: Quick Add Task: one line, `Write spec @ian ^fri 3h >design`, read the
// way worg's quick add reads it (quick-add-model.ts) and said back in the box
// as it is typed. The task goes in as the last child of the heading at the
// cursor (or at the end of the file): through the orgs server's /gantt/add
// when it is there, so it is written exactly as worg writes it, and straight
// into the editor - the same lines, one undo - when it is not. Outside an org
// file it asks where, from the server's refile targets.

import * as vscode from 'vscode';
import { ODb } from './db';
import { Auth } from './auth';
import { Sets } from './sets';
import { linesOf, replaceLines } from './edit-lines';
import { headingAt, parseHeading, getProperty, setProperty, isHeadingLine, fileKeywords } from './outline/model';
import { settled, headingsIn, readLines, openAt } from './org-files';
import { loadTargets, pickTarget } from './move-dialog';
import {
    parseQuickAdd, addRequest, newHeadingLines, describeQuick, findByName, idFor, insertPoint, insertTask, ganttStamp, QuickLine, GanttAdd,
} from './quick-add-model';
import { dayKey } from './when-model';

const PLACEHOLDER = 'Write spec @ian ^fri 3h >design #tag !A KEY=value   (^^fri: a deadline, NEXT first: the keyword)';

interface Heading { title: string; line: number; }

function personProp(): string {
    return vscode.workspace.getConfiguration('org').get<string>('quickAddPersonProperty', 'ASSIGNEE') || 'ASSIGNEE';
}

function keywords(lines: string[]): string[] {
    const own = fileKeywords(lines);
    const todo = own ? own.todo : (Sets.getProp<string[]>('todoKeywords', ['TODO']) || []);
    const done = own ? own.done : (Sets.getProp<string[]>('doneKeywords', ['DONE']) || []);
    return todo.concat(done).filter(k => k);
}

function headingsOf(lines: string[], kw: string[]): Heading[] {
    const out: Heading[] = [];
    lines.forEach((l, i) => {
        if (isHeadingLine(l)) {
            out.push({ title: parseHeading(l, i, kw).title, line: i });
        }
    });
    return out;
}

// The line, asked for with what it will make said back as it is typed.
function askLine(where: string, statuses: string[], heads: Heading[]): Promise<QuickLine | undefined> {
    const box = vscode.window.createInputBox();
    box.title = 'Quick add a task ' + where;
    box.placeholder = PLACEHOLDER;
    box.ignoreFocusOut = true;
    const show = () => {
        const q = parseQuickAdd(box.value, statuses);
        if (!box.value.trim()) {
            box.prompt = 'Type a title; @who, ^when, 3h, >what it waits on, #tags, !A and KEY=value are picked out of it';
            box.validationMessage = undefined;
            return;
        }
        let text = describeQuick(q, { personProp: personProp() });
        if (q.after && !findByName(heads, q.after)) {
            text += `  -  nothing here is called "${q.after}"`;
        }
        box.prompt = text;
        box.validationMessage = q.headline ? undefined : 'It needs a title';
    };
    show();
    return new Promise(resolve => {
        let out: QuickLine | undefined;
        box.onDidChangeValue(show);
        box.onDidAccept(() => {
            const q = parseQuickAdd(box.value, statuses);
            if (q.headline) {
                out = q;
                box.hide();
            }
        });
        box.onDidHide(() => { box.dispose(); resolve(out); });
        box.show();
    });
}

// The id the dependency is known by, and whether it has to be given one.
function depId(lines: string[], dep: Heading | null, hash: string, taken: Set<string>): { id: string, fresh: boolean } | undefined {
    if (!dep) {
        return undefined;
    }
    const have = getProperty(lines, dep.line, 'ID') || getProperty(lines, dep.line, 'CUSTOM_ID');
    if (have) {
        return { id: have, fresh: false };
    }
    let id = idFor(dep.title, hash);
    for (let n = 2; taken.has(id); n++) {
        id = `${idFor(dep.title, hash)}-${n}`;
    }
    return { id, fresh: true };
}

function idsIn(lines: string[]): Set<string> {
    return new Set(lines.map(l => /^\s*:(?:CUSTOM_)?ID:\s*(\S+)/i.exec(l)).filter(m => m).map(m => m[1]));
}

async function serverHash(file: string, line: number): Promise<string | undefined> {
    try {
        const h = await ODb.lookuphash(file, line);
        return typeof h === 'string' && h !== '' && !/ /.test(h) ? h : undefined;
    } catch (e) {
        return undefined;
    }
}

// After the server wrote it: the new heading's line, the last with its title
// at that level from `from` on.
function findNew(lines: string[], from: number, add: GanttAdd, level: number): number {
    let found = -1;
    for (let i = Math.max(0, from); i < lines.length; i++) {
        const l = lines[i];
        if (isHeadingLine(l) && /^\*+/.exec(l)[0].length === level && l.indexOf(add.Headline.trim()) >= 0) {
            found = i;
        }
    }
    return found;
}

// Through the server: the dependency's ID first (as worg does), then the add,
// then a deadline when both dates were typed.
// The new heading's line, -1 when it was added but not found again, undefined
// when it failed.
async function addViaServer(file: string, parent: { hash?: string, line: number }, q: QuickLine, dep: Heading | null, lines: string[]): Promise<number | undefined> {
    let afterId: string | undefined;
    if (dep) {
        const depHash = await serverHash(file, dep.line);
        const d = depId(lines, dep, depHash || '', idsIn(lines));
        if (d && d.fresh) {
            if (!depHash) {
                vscode.window.showWarningMessage(`The orgs server does not know "${dep.title}", so the task is added without waiting on it.`);
            } else {
                const r: any = await ODb.apiPost('/property', { Hash: depHash, Name: 'ID', Value: d.id });
                if (!r || r.Ok === false) {
                    vscode.window.showWarningMessage(`Could not give "${dep.title}" an id (${r && r.Msg || 'no answer'}), so the task does not wait on it.`);
                } else {
                    afterId = d.id;
                }
            }
        } else if (d) {
            afterId = d.id;
        }
    }
    const add = addRequest(q, { personProp: personProp(), afterId });
    if (parent.hash) {
        add.ParentHash = parent.hash;
    } else {
        add.Filename = file;
    }
    const res: any = await ODb.apiPost('/gantt/add', add);
    await settled([file]);
    if (!res || res.Ok === false) {
        vscode.window.showErrorMessage('Quick add failed: ' + (res && res.Msg || 'the orgs server did not answer'));
        return undefined;
    }
    const now = readLines(file);
    const level = parent.line < 0 ? 1 : /^\*+/.exec(now[parent.line] || '*')[0].length + 1;
    const at = findNew(now, parent.line + 1, add, level);
    if (q.start && q.deadline && at >= 0) {
        const h = await serverHash(file, at);
        if (h) {
            await ODb.apiPost('/date/change', { Hash: h, Name: 'DEADLINE', Value: ganttStamp(dayKey(q.deadline)) });
            await settled([file]);
        }
    }
    const shown = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === file);
    if (shown && at >= 0) {
        shown.selection = new vscode.Selection(at, now[at].length, at, now[at].length);
        shown.revealRange(new vscode.Range(at, 0, at, 0));
    }
    vscode.window.setStatusBarMessage(`$(check) Added ${q.headline}${afterId ? ` after ${dep.title}` : ''}`, 4000);
    return at;
}

// Straight into the editor: the same lines /gantt/add writes, one undo.
async function addLocally(editor: vscode.TextEditor, parent: number, q: QuickLine, dep: Heading | null) {
    const lines = linesOf(editor.document);
    const d = depId(lines, dep, '', idsIn(lines));
    const edit = d && d.fresh ? setProperty(lines, dep.line, 'ID', d.id) : undefined;
    const add = addRequest(q, { personProp: personProp(), afterId: d && d.id });
    const at = insertPoint(lines, parent);
    const deadline = q.start && q.deadline ? dayKey(q.deadline) : undefined;
    const r = insertTask(lines, at.row, newHeadingLines(at.level, add, deadline), edit);
    if (r.start === r.end) {
        // replaceLines wants a line to work against: the one after, or at the
        // end of the file the one before.
        if (r.end < lines.length) {
            r.lines.push(lines[r.end]);
            r.end++;
        } else {
            r.lines.unshift(lines[r.start - 1]);
            r.start--;
        }
    }
    const head = r.lines[r.heading - r.start] || '';
    await replaceLines(editor, r.start, r.end, r.lines, r.heading, head.length);
    vscode.window.setStatusBarMessage(`$(check) Added ${q.headline}${d ? ` after ${dep.title}` : ''}`, 4000);
}

export async function quickAddTask(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'org') {
        const doc = editor.document;
        const lines = linesOf(doc);
        const kw = keywords(lines);
        const parent = headingAt(lines, editor.selection.active.line);
        const where = parent < 0 ? 'at the end of the file' : `under "${parseHeading(lines[parent], parent, kw).title}"`;
        const heads = headingsOf(lines, kw);
        const q = await askLine(where, kw, heads);
        if (!q) {
            return;
        }
        const dep = q.after ? findByName(heads, q.after) : null;
        if (q.after && !dep) {
            vscode.window.showWarningMessage(`Nothing here is called "${q.after}", so the task does not wait on anything.`);
        }
        // The server when it can write this file; the editor otherwise.
        if (!doc.isUntitled && Auth.get().isLoggedIn() && (!doc.isDirty || await doc.save())) {
            // Whether the server knows this file: it has a hash for the
            // heading, or (above the first heading) for any heading in it.
            const hash = parent < 0 ? undefined : await serverHash(doc.fileName, parent);
            const known = hash || (parent < 0 && heads.length > 0 && await serverHash(doc.fileName, heads[0].line));
            if (known) {
                await addViaServer(doc.fileName, { hash, line: parent }, q, dep, linesOf(doc));
                return;
            }
        }
        await addLocally(editor, parent, q, dep);
        return;
    }
    // Not in an org file: somewhere the server knows.
    const targets = await loadTargets();
    if (!targets) {
        return;
    }
    const to = await pickTarget('Quick add a task: where does it go?', 'Type to find a heading (its path, file, keyword or tags), or pick a file', ['the new task'], targets);
    if (!to) {
        return;
    }
    const lines = readLines(to.Filename);
    const kw = keywords(lines);
    const heads = headingsIn(to.Filename, kw).map(h => ({ title: h.title, line: h.line }));
    const olp = to.Olp || [];
    const parentRef = olp.length ? headingsIn(to.Filename, kw).find(h => [...h.olp, h.title].join('\u0000') === olp.join('\u0000')) : undefined;
    const q = await askLine(olp.length ? `under "${olp[olp.length - 1]}"` : 'at the end of ' + to.Filename, kw, heads);
    if (!q) {
        return;
    }
    const dep = q.after ? findByName(heads, q.after) : null;
    if (q.after && !dep) {
        vscode.window.showWarningMessage(`Nothing in that file is called "${q.after}", so the task does not wait on anything.`);
    }
    const at = await addViaServer(to.Filename, { hash: to.Hash || undefined, line: parentRef ? parentRef.line : -1 }, q, dep, lines);
    if (at !== undefined) {
        await openAt(to.Filename, at >= 0 ? at : parentRef ? parentRef.line : 0, 0, true);
    }
}

export function activateQuickAdd(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(vscode.commands.registerCommand('org.quickAddTask', quickAddTask));
}
