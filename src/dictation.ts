// Dictation: Org: Dictate records from the microphone, and run again stops,
// sends the take to the orgs server's whisper (POST /voice/dictate) and puts
// the words in at the cursor, as worg's dictation in writing mode does.
//
// VS Code's webviews cannot reach the microphone, so an outside program
// records: sox (rec), ffmpeg or arecord, whichever is on the PATH, or the
// command line in org.dictationRecorder. The model - whisper's habits taken
// off, spoken commands, joining the text - is in dictation-model.ts.

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ODb } from './db';
import { RECORDERS, Recorder, dictated, dictateError, parseRecorder, pickRecorder, promptOf } from './dictation-model';

type Take = { proc: cp.ChildProcess; rec: Recorder; out: string; uri: vscode.Uri; stderr: string; exited: boolean; started: number };

let take: Take | undefined;
let busy = false;
let bar: vscode.StatusBarItem;
// What the last take put in, for "scratch that".
let last: { uri: string; range: vscode.Range; text: string } | undefined;

// Whether a program is on the PATH.
function onPath(name: string): Promise<boolean> {
    const which = process.platform === 'win32' ? 'where' : 'which';
    return new Promise(resolve => cp.execFile(which, [name], err => resolve(!err)));
}

async function findRecorder(out: string): Promise<Recorder | undefined> {
    const line = (vscode.workspace.getConfiguration('org').get<string>('dictationRecorder', '') || '').trim();
    if (line) {
        return parseRecorder(line, out);
    }
    const found: string[] = [];
    for (const n of RECORDERS) {
        if (await onPath(n)) found.push(n);
    }
    return pickRecorder(found, process.platform, out);
}

function showBar(text: string, tooltip: string, recording: boolean) {
    bar.text = text;
    bar.tooltip = tooltip;
    bar.command = recording ? 'org.dictate' : undefined;
    bar.backgroundColor = recording ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    bar.show();
}

async function start() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
        vscode.window.showWarningMessage('Put the cursor where the words should go, then dictate.');
        return;
    }
    // Asked first, so "whisper is not running" is said before the take
    // rather than after it.
    const conf = await ODb.api<{ Ok?: boolean; ready?: boolean; Msg?: string }>('/voice/config').catch(() => undefined);
    if (!conf || typeof conf !== 'object') {
        vscode.window.showErrorMessage('Dictation needs the orgs server (its whisper does the transcribing), and it did not answer.');
        return;
    }
    if (!conf.ready) {
        vscode.window.showErrorMessage(`Dictation needs whisper on the orgs server: ${conf.Msg || 'it is not set up'}. See voice: in orgs.yaml.`);
        return;
    }
    const out = path.join(os.tmpdir(), `org-dictation-${Date.now()}.wav`);
    const rec = await findRecorder(out);
    if (!rec) {
        vscode.window.showErrorMessage('No program to record with: install sox (rec), ffmpeg or arecord, or set org.dictationRecorder to a command line that records to {out}.');
        return;
    }
    let proc: cp.ChildProcess;
    try {
        proc = cp.spawn(rec.cmd, rec.args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
        vscode.window.showErrorMessage(`Could not start ${rec.cmd}: ${e.message}`);
        return;
    }
    const t: Take = { proc, rec, out, uri: ed.document.uri, stderr: '', exited: false, started: Date.now() };
    take = t;
    proc.stderr.on('data', d => { t.stderr = (t.stderr + d.toString()).slice(-2000); });
    proc.on('error', e => {
        t.exited = true;
        if (take === t) {
            take = undefined;
            bar.hide();
            vscode.window.showErrorMessage(`Could not record with ${rec.cmd}: ${e.message}`);
        }
    });
    proc.on('exit', code => {
        t.exited = true;
        // It stopped by itself: no microphone, or no permission to use it.
        if (take === t) {
            take = undefined;
            bar.hide();
            vscode.window.showErrorMessage(`${rec.name} stopped recording (${code}): ${t.stderr.trim() || 'no reason given'}. ` +
                (process.platform === 'darwin' ? 'On a Mac, VS Code needs microphone access (System Settings > Privacy & Security > Microphone).' : ''));
        }
    });
    showBar('$(circle-filled) Recording — click to stop', `Dictating with ${rec.name}. Click, or run Org: Dictate again, to stop and transcribe.`, true);
}

// Stops the recorder the way each wants, so the wav is finished properly.
function finish(t: Take): Promise<void> {
    return new Promise(resolve => {
        if (t.exited) return resolve();
        const timer = setTimeout(() => { t.proc.kill('SIGKILL'); resolve(); }, 4000);
        t.proc.once('exit', () => { clearTimeout(timer); resolve(); });
        if (t.rec.name === 'ffmpeg') {
            t.proc.stdin.write('q');
        } else {
            t.proc.kill('SIGINT');
        }
    });
}

async function stop() {
    const t = take;
    take = undefined;
    if (!t) return;
    busy = true;
    showBar('$(sync~spin) Transcribing…', 'Sending the take to whisper on the orgs server', false);
    try {
        await finish(t);
        const data = fs.existsSync(t.out) ? fs.readFileSync(t.out) : undefined;
        fs.promises.unlink(t.out).catch(() => undefined);
        // A wav header is 44 bytes; a take with no sound in it is little more.
        if (!data || data.length < 4000) {
            vscode.window.showWarningMessage(`Nothing was recorded${t.stderr.trim() ? ': ' + t.stderr.trim() : ''}. Check the microphone${process.platform === 'darwin' ? ' and that VS Code may use it' : ''}.`);
            return;
        }
        const doc = await vscode.workspace.openTextDocument(t.uri);
        const ed = vscode.window.visibleTextEditors.find(e => e.document === doc) || await vscode.window.showTextDocument(doc);
        const at = ed.selection.active;
        const before = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, at.line - 40), 0), at));
        const fields: { [k: string]: string } = { prompt: promptOf(before) };
        const lang = vscode.workspace.getConfiguration('org').get<string>('dictationLanguage', '');
        if (lang) fields.language = lang;
        const r = await ODb.upload<{ Ok: boolean; Msg?: string; text?: string }>('/voice/dictate', fields, 'audio', 'dictation.wav', data);
        if (!r) return; // upload said why
        if (!r.Ok && !r.text) {
            vscode.window.showErrorMessage(dictateError(undefined, r.Msg));
            return;
        }
        await put(ed, r.text || '');
    } finally {
        busy = false;
        bar.hide();
    }
}

// The words in at the cursor (over the selection), joined to what is before
// it; or a spoken command carried out.
async function put(ed: vscode.TextEditor, transcript: string) {
    const doc = ed.document;
    const sel = ed.selection;
    const before = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, sel.start.line - 40), 0), sel.start));
    const d = dictated(before, transcript);
    if ('nothing' in d) {
        vscode.window.setStatusBarMessage('Dictation: no words heard', 3000);
        return;
    }
    if ('command' in d) {
        if (d.command === 'scratch' && last && last.uri === doc.uri.toString() && doc.getText(last.range) === last.text) {
            const range = last.range;
            last = undefined;
            await ed.edit(b => b.delete(range));
        }
        return;
    }
    const start = sel.start;
    const ok = await ed.edit(b => b.replace(sel, d.insert));
    if (ok) {
        const end = doc.positionAt(doc.offsetAt(start) + d.insert.length);
        last = { uri: doc.uri.toString(), range: new vscode.Range(start, end), text: d.insert };
        ed.selection = new vscode.Selection(end, end);
    }
}

async function dictate() {
    if (busy) {
        vscode.window.setStatusBarMessage('Dictation: still transcribing the last take', 2000);
        return;
    }
    if (take) {
        await stop();
    } else {
        await start();
    }
}

export function activateDictation(ctx: vscode.ExtensionContext) {
    bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    ctx.subscriptions.push(bar, vscode.commands.registerCommand('org.dictate', dictate), {
        // A take still going when VS Code closes is not left recording.
        dispose: () => { if (take && !take.exited) take.proc.kill(); },
    });
}
