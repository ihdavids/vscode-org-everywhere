// Org: Move Subtree…: refile, copy and archive as one operation with three
// endings (worg's MoveDialog). Pick what to do, then where - typing finds the
// heading the way worg's picker does, each row says where the subtree will
// land, and the places used lately come first. Select across several headings
// to move them all in one request.

import * as vscode from 'vscode';
import { ODb } from './db';
import { sources } from './refile';
import { settled, headingsIn, readLines } from './org-files';
import {
    MoveOp, RefileTarget, MoveResponse, filterTargets, toApiTarget, targetKey, recentKey, targetName,
    opTitle, opVerb, needsTarget, summarise, failures, noteRecent, landing, baseName,
} from './move-model';

const RECENTS = 'org.move.recents';
let memory: vscode.Memento | undefined;

interface OpPick extends vscode.QuickPickItem { op: MoveOp; }
interface TargetPick extends vscode.QuickPickItem { target?: RefileTarget; }

async function pickOp(n: number): Promise<MoveOp | undefined> {
    const what = n === 1 ? 'this heading' : `these ${n} headings`;
    const pick = await vscode.window.showQuickPick<OpPick>([
        { op: 'refile', label: '$(export) Refile', description: 'move it, leaving nothing behind' },
        { op: 'copy', label: '$(copy) Copy', description: 'put a copy there, keep this one' },
        { op: 'archive', label: '$(archive) Archive', description: 'to where org says: its :ARCHIVE:, then the file\'s #+ARCHIVE:, then the server\'s default' },
    ], { placeHolder: `Move ${what}: refile, copy or archive?` });
    return pick ? pick.op : undefined;
}

// Every place the server will file under, and the end of each file.
export async function loadTargets(exclude: Set<string> = new Set()): Promise<RefileTarget[] | undefined> {
    const res: any = await ODb.refileTargets();
    if (!res) {
        return undefined;
    }
    if (!res.Ok) {
        vscode.window.showErrorMessage('No refile targets: ' + (res.Msg || 'the server did not say why'));
        return undefined;
    }
    const out: RefileTarget[] = [];
    const files = new Set<string>();
    for (const t of res.Targets || []) {
        files.add(t.Filename);
        if (t.Hash && !exclude.has(t.Hash)) {
            out.push({ Hash: t.Hash, Filename: t.Filename, Olp: t.Olp || [], Level: t.Level, Todo: t.Todo || '', Tags: t.Tags || [] });
        }
    }
    Array.from(files).sort().forEach(f => out.push({ Hash: '', Filename: f, Olp: [], Level: 0, Todo: '', Tags: [] }));
    if (res.Truncated) {
        vscode.window.setStatusBarMessage('The server sent only part of its refile targets', 4000);
    }
    return out;
}

// Where it lands, read from the target file as it is now.
function landingFor(t: RefileTarget, titles: string[], lineOf: Map<string, Map<string, number>>): string {
    if (!(t.Olp || []).length) {
        return landing(readLines(t.Filename), -1, titles);
    }
    let lines = lineOf.get(t.Filename);
    if (!lines) {
        lines = new Map(headingsIn(t.Filename).map(h => [[...h.olp, h.title].join('\u0000'), h.line] as [string, number]));
        lineOf.set(t.Filename, lines);
    }
    return landing(readLines(t.Filename), lines.get((t.Olp || []).join('\u0000')), titles);
}

// The target picker, also used by Quick Add Task outside an org file.
export function pickTarget(title: string, placeholder: string, titles: string[], targets: RefileTarget[]): Promise<RefileTarget | undefined> {
    const recents = memory ? memory.get<string[]>(RECENTS, []) : [];
    const recentSet = new Set(recents);
    const lineOf = new Map<string, Map<string, number>>();
    const previews = new Map<string, string>();
    const preview = (t: RefileTarget) => {
        const k = targetKey(t);
        if (!previews.has(k)) {
            previews.set(k, landingFor(t, titles, lineOf));
        }
        return previews.get(k);
    };
    const toItem = (t: RefileTarget, i: number, filtered: boolean): TargetPick => {
        const olp = t.Olp || [];
        const file = vscode.workspace.asRelativePath(t.Filename);
        return {
            label: (olp.length === 0 ? '$(file) ' : olp.length === 1 ? '$(symbol-class) ' : '$(symbol-field) ') +
                (t.Todo ? t.Todo + ' ' : '') + targetName(t),
            description: olp.length > 1 ? olp.slice(0, -1).join(' › ') : olp.length === 0 ? 'top level, at the end' : baseName(t.Filename),
            // Reading the files for the preview is only worth it for what is near the top.
            detail: i < 40 ? `${file} - ${preview(t)}` : file,
            alwaysShow: filtered,
            target: t,
        };
    };
    const build = (value: string): TargetPick[] => {
        const filtered = value.trim() !== '';
        const list = filterTargets(targets, value, 200, recents);
        const items: TargetPick[] = [];
        let band = '';
        list.forEach((t, i) => {
            if (!filtered) {
                const b = recentSet.has(recentKey(t)) ? 'Recent' : (t.Olp || []).length ? 'Headings' : 'Files';
                if (b !== band) {
                    items.push({ label: b, kind: vscode.QuickPickItemKind.Separator });
                    band = b;
                }
            }
            items.push(toItem(t, i, filtered));
        });
        return items;
    };
    const qp = vscode.window.createQuickPick<TargetPick>();
    qp.title = title;
    qp.placeholder = placeholder;
    qp.matchOnDescription = true;
    qp.matchOnDetail = false;
    qp.items = build('');
    qp.onDidChangeValue(v => { qp.items = build(v); });
    return new Promise(resolve => {
        let chosen: RefileTarget | undefined;
        qp.onDidAccept(() => {
            const p = qp.activeItems[0];
            if (p && p.target) {
                chosen = p.target;
                qp.hide();
            }
        });
        qp.onDidHide(() => { qp.dispose(); resolve(chosen); });
        qp.show();
    });
}

function report(res: MoveResponse, op: MoveOp) {
    const s = summarise(res, op);
    const bad = failures(res).map(r => `${r.Headline}: ${r.Msg}`);
    if (s.tone === 'success') {
        vscode.window.setStatusBarMessage('$(check) ' + s.text, 4000);
    } else if (s.tone === 'warning') {
        vscode.window.showWarningMessage([s.text, ...bad].join(' - '));
    } else {
        vscode.window.showErrorMessage([s.text, ...bad].join(' - '));
    }
}

export async function moveSubtree(opArg?: MoveOp): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const src = editor && await sources(editor);
    if (!src) {
        return;
    }
    const op = opArg && ['refile', 'copy', 'archive'].indexOf(opArg) >= 0 ? opArg : await pickOp(src.titles.length);
    if (!op) {
        return;
    }
    const file = src.targets[0].Filename;
    let to: RefileTarget | undefined;
    if (needsTarget(op)) {
        const targets = await loadTargets(new Set(src.targets.map(t => t.Id)));
        if (!targets) {
            return;
        }
        to = await pickTarget(opTitle(op, src.titles.length) + (src.titles.length === 1 ? `: "${src.titles[0]}"` : ''),
            `${opVerb(op)} to… type to find a heading (its path, file, keyword or tags)`, src.titles, targets);
        if (!to) {
            return;
        }
    }
    const res: MoveResponse = await ODb.move(op, src.targets, to ? toApiTarget(to) : undefined);
    if (!res) {
        return;
    }
    // The server wrote these files: let the editor catch up before going on.
    await settled([file, ...(to ? [to.Filename] : []), ...(res.Results || []).map(r => r.Filename)]);
    report(res, op);
    if (to && memory && res.Done > 0) {
        await memory.update(RECENTS, noteRecent(recentKey(to), memory.get<string[]>(RECENTS, [])));
    }
}

export function activateMoveDialog(ctx: vscode.ExtensionContext) {
    memory = ctx.globalState;
    ctx.subscriptions.push(
        vscode.commands.registerCommand('org.moveSubtree', (op?: MoveOp) => moveSubtree(typeof op === 'string' ? op : undefined)),
    );
}
