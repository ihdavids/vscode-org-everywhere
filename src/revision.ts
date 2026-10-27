// Revision notes as VS Code comment threads: worg's revision mode, where a
// note is an org comment line under its paragraph ("# NOTE: too slow", see
// revision-model.ts). The notes under a paragraph are one thread anchored to
// it; a note's quoted words are lit. Replying adds a note, and a note's
// buttons edit, tick off, reopen or delete it - each a rewrite of the org
// comment lines with replaceLines, so one undo. The file stays the truth: the
// threads are read again from it as it changes.

import * as vscode from 'vscode';
import { replaceLines, linesOf } from './edit-lines';
import { Note, NoteGroup, parseNotes, noteGroups, addNote, setNoteState, setNoteText, deleteNote, nextNote } from './revision-model';

const CONTROLLER = 'org-revision';

function enabled(): boolean {
    return vscode.workspace.getConfiguration('org').get<boolean>('revisionNotes', true);
}

function isOrg(doc: vscode.TextDocument): boolean {
    return doc.languageId === 'org';
}

class NoteComment implements vscode.Comment {
    body: string | vscode.MarkdownString = '';
    mode = vscode.CommentMode.Preview;
    author: vscode.CommentAuthorInformation = { name: 'Note' };
    label?: string;
    contextValue?: string;
    // The note as last read from the file, and the text before an edit began.
    note: Note;
    before = '';

    constructor(note: Note, readonly thread: vscode.CommentThread, readonly doc: vscode.TextDocument) {
        this.read(note);
    }

    read(note: Note) {
        this.note = note;
        // Someone typing in the box keeps what they typed.
        if (this.mode === vscode.CommentMode.Editing) {
            return;
        }
        this.body = note.text;
        const bits = [note.anchor ? `“${note.anchor}”${note.at ? '' : ' (gone)'}` : '', note.state === 'done' ? 'done' : ''].filter(Boolean);
        this.label = bits.length ? bits.join(' · ') : undefined;
        this.contextValue = note.state === 'done' ? 'done' : 'open';
    }
}

let controller: vscode.CommentController;
const threadsOf = new Map<string, vscode.CommentThread[]>();
const ours = new WeakSet<vscode.CommentThread>();
let anchorDeco: vscode.TextEditorDecorationType;

function sameRange(a: vscode.Range, b: vscode.Range): boolean {
    return a.isEqual(b);
}

function disposeThreads(uri: string) {
    (threadsOf.get(uri) || []).forEach(t => t.dispose());
    threadsOf.delete(uri);
}

// Read the document's notes and make its threads match: threads are reused
// in order, so one being replied to or edited is not thrown away.
function sync(doc: vscode.TextDocument) {
    const uri = doc.uri.toString();
    if (!enabled() || !isOrg(doc)) {
        disposeThreads(uri);
        return;
    }
    const notes = parseNotes(linesOf(doc));
    const groups = noteGroups(notes);
    const threads = threadsOf.get(uri) || [];
    const out: vscode.CommentThread[] = [];
    groups.forEach((g, i) => {
        const end = Math.min(g.range[1], doc.lineCount - 1);
        const range = new vscode.Range(g.range[0], 0, end, doc.lineAt(end).text.length);
        let t = threads[i];
        if (!t) {
            t = controller.createCommentThread(doc.uri, range, []);
            t.contextValue = 'orgRevision';
            t.canReply = true;
            t.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
            ours.add(t);
        } else if (!sameRange(t.range, range)) {
            t.range = range;
        }
        fill(t, g, doc);
        out.push(t);
    });
    threads.slice(groups.length).forEach(t => t.dispose());
    threadsOf.set(uri, out);
    lightAnchors(doc, notes);
}

function fill(t: vscode.CommentThread, g: NoteGroup, doc: vscode.TextDocument) {
    const old = t.comments.filter(c => c instanceof NoteComment) as NoteComment[];
    const comments = g.notes.map((n, j) => {
        const c = old[j];
        if (c) {
            c.read(n);
            return c;
        }
        return new NoteComment(n, t, doc);
    });
    t.comments = comments;
    const open = g.notes.filter(n => n.state === 'open').length;
    t.label = open ? `${open} open` : 'all done';
    t.state = open ? vscode.CommentThreadState.Unresolved : vscode.CommentThreadState.Resolved;
}

function lightAnchors(doc: vscode.TextDocument, notes: Note[]) {
    const ranges = notes.filter(n => n.at && n.state === 'open').map(n => new vscode.Range(n.at.line, n.at.from, n.at.line, n.at.to));
    vscode.window.visibleTextEditors.filter(e => e.document === doc).forEach(e => e.setDecorations(anchorDeco, ranges));
}

function syncAll() {
    const docs = new Set<vscode.TextDocument>();
    vscode.window.visibleTextEditors.forEach(e => docs.add(e.document));
    vscode.workspace.textDocuments.filter(d => threadsOf.has(d.uri.toString())).forEach(d => docs.add(d));
    docs.forEach(sync);
    if (!enabled()) {
        Array.from(threadsOf.keys()).forEach(disposeThreads);
        vscode.window.visibleTextEditors.forEach(e => e.setDecorations(anchorDeco, []));
    }
}

// ---------------------------------------------------------------------------
// Writing the notes back
// ---------------------------------------------------------------------------

async function editorFor(doc: vscode.TextDocument): Promise<vscode.TextEditor> {
    return vscode.window.visibleTextEditors.find(e => e.document === doc)
        || await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
}

async function write(doc: vscode.TextDocument, after: string[] | null): Promise<boolean> {
    if (!after) {
        return false;
    }
    const editor = await editorFor(doc);
    const ok = await replaceLines(editor, 0, doc.lineCount, after);
    sync(doc);
    return ok;
}

// The note a comment stands for, in the text now: on the line it was last
// read on if it still says the same, else the same words elsewhere.
function noteNow(c: NoteComment): Note | undefined {
    const notes = parseNotes(linesOf(c.doc));
    const was = c.note;
    return notes.find(n => n.line === was.line && n.text === was.text && n.anchor === was.anchor)
        || notes.find(n => n.text === was.text && n.anchor === was.anchor);
}

async function onComment(c: NoteComment, f: (lines: string[], line: number) => string[] | null) {
    if (!(c instanceof NoteComment)) {
        return;
    }
    const n = noteNow(c);
    if (!n) {
        vscode.window.showWarningMessage('That note is no longer in the file.');
        sync(c.doc);
        return;
    }
    await write(c.doc, f(linesOf(c.doc), n.line));
}

// A reply to one of our threads is another note on its paragraph; the first
// comment of a new thread (the + in the gutter) is a note on that line,
// anchored to the words selected, if any.
async function reply(r: vscode.CommentReply) {
    const t = r.thread;
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === t.uri.toString());
    const text = r.text.trim();
    if (!doc || !text) {
        return;
    }
    if (ours.has(t)) {
        const first = (t.comments[0] as NoteComment).note;
        const line = first && first.para[0] >= 0 ? first.para[1] : t.range.start.line;
        await write(doc, addNote(linesOf(doc), line, text, '').lines);
        return;
    }
    const range = t.range;
    const anchor = range.isSingleLine && !range.isEmpty ? doc.getText(range) : '';
    t.dispose();
    const added = addNote(linesOf(doc), range.end.line, text, anchor);
    await write(doc, added.lines);
    expandAt(doc, added.line);
}

function expandAt(doc: vscode.TextDocument, noteLine: number) {
    const t = (threadsOf.get(doc.uri.toString()) || []).find(x => x.comments.some(c => (c as NoteComment).note && (c as NoteComment).note.line === noteLine));
    if (t) {
        t.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function addAtCursor() {
    const e = vscode.window.activeTextEditor;
    if (!e || !isOrg(e.document)) {
        return;
    }
    const sel = e.selection;
    const text = await vscode.window.showInputBox({ prompt: 'A revision note about this paragraph', placeHolder: 'too slow - start with the letter itself' });
    if (!text || !text.trim()) {
        return;
    }
    const anchor = sel.isSingleLine && !sel.isEmpty ? e.document.getText(sel) : '';
    const added = addNote(linesOf(e.document), sel.active.line, text, anchor);
    if (!enabled()) {
        await replaceLines(e, 0, e.document.lineCount, added.lines);
        return;
    }
    await write(e.document, added.lines);
    expandAt(e.document, added.line);
}

function go(dir: 1 | -1) {
    const e = vscode.window.activeTextEditor;
    if (!e || !isOrg(e.document)) {
        return;
    }
    const n = nextNote(parseNotes(linesOf(e.document)), e.selection.active.line, dir);
    if (!n) {
        vscode.window.setStatusBarMessage('No revision notes in this file', 3000);
        return;
    }
    const pos = new vscode.Position(n.line, e.document.lineAt(n.line).firstNonWhitespaceCharacterIndex);
    e.selection = new vscode.Selection(pos, pos);
    e.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    sync(e.document);
    expandAt(e.document, n.line);
}

async function toggle() {
    const c = vscode.workspace.getConfiguration('org');
    const i = c.inspect('revisionNotes');
    const target = i && i.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await c.update('revisionNotes', !enabled(), target);
    vscode.window.setStatusBarMessage(`Revision notes: ${enabled() ? 'shown' : 'hidden'}`, 3000);
}

export function activateRevision(context: vscode.ExtensionContext) {
    controller = vscode.comments.createCommentController(CONTROLLER, 'Revision notes');
    controller.options = { prompt: 'Add a revision note', placeHolder: 'A note about this paragraph' };
    controller.commentingRangeProvider = {
        provideCommentingRanges: (doc: vscode.TextDocument) =>
            enabled() && isOrg(doc) && doc.lineCount > 0 ? [new vscode.Range(0, 0, doc.lineCount - 1, 0)] : [],
    };
    anchorDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
        borderRadius: '2px',
    });

    const timers = new Map<string, NodeJS.Timeout>();
    const later = (doc: vscode.TextDocument) => {
        const k = doc.uri.toString();
        clearTimeout(timers.get(k));
        timers.set(k, setTimeout(() => { timers.delete(k); sync(doc); }, 300));
    };

    context.subscriptions.push(
        controller,
        anchorDeco,
        vscode.commands.registerCommand('org.addRevisionNote', addAtCursor),
        vscode.commands.registerCommand('org.toggleRevisionNotes', toggle),
        vscode.commands.registerCommand('org.nextRevisionNote', () => go(1)),
        vscode.commands.registerCommand('org.previousRevisionNote', () => go(-1)),
        vscode.commands.registerCommand('org.revisionNoteReply', reply),
        vscode.commands.registerCommand('org.revisionNoteEdit', (c: NoteComment) => {
            c.before = typeof c.body === 'string' ? c.body : c.body.value;
            c.mode = vscode.CommentMode.Editing;
            c.thread.comments = [...c.thread.comments];
        }),
        vscode.commands.registerCommand('org.revisionNoteCancel', (c: NoteComment) => {
            c.mode = vscode.CommentMode.Preview;
            c.body = c.before;
            c.thread.comments = [...c.thread.comments];
        }),
        vscode.commands.registerCommand('org.revisionNoteSave', async (c: NoteComment) => {
            const text = (typeof c.body === 'string' ? c.body : c.body.value).trim();
            c.mode = vscode.CommentMode.Preview;
            // Emptied is deleted, as in worg.
            await onComment(c, (lines, line) => text ? setNoteText(lines, line, text) : deleteNote(lines, line));
        }),
        vscode.commands.registerCommand('org.revisionNoteDone', (c: NoteComment) => onComment(c, (l, n) => setNoteState(l, n, 'done'))),
        vscode.commands.registerCommand('org.revisionNoteReopen', (c: NoteComment) => onComment(c, (l, n) => setNoteState(l, n, 'open'))),
        vscode.commands.registerCommand('org.revisionNoteDelete', (c: NoteComment) => onComment(c, (l, n) => deleteNote(l, n))),
        vscode.workspace.onDidChangeTextDocument(ev => {
            if (isOrg(ev.document) && ev.contentChanges.length && enabled()) {
                later(ev.document);
            }
        }),
        vscode.window.onDidChangeVisibleTextEditors(() => syncAll()),
        vscode.workspace.onDidCloseTextDocument(doc => disposeThreads(doc.uri.toString())),
        vscode.workspace.onDidChangeConfiguration(ev => {
            if (ev.affectsConfiguration('org.revisionNotes')) {
                syncAll();
            }
        }),
    );
    syncAll();
}
