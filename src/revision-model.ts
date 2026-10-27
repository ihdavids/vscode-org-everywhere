// Revision notes: worg's revision.ts (revision mode), pure, so the comment
// threads in revision.ts read and write exactly what worg does. Tested by
// test/revision.test.ts, which has worg's revision.test.ts cases.
//
// The format: an org comment line under the paragraph it is about.
//
//     The letter was waiting when Mara came in from the boats.
//     # NOTE: too slow, start with the letter itself
//     # NOTE "the boats": which boats? set this up in chapter one
//     # NOTE[done]: check the tide tables
//
// - A comment line is never exported, by orgs or by Emacs, so notes cannot
//   leak into a book and the file stays an ordinary org file.
// - NOTE is the marker, any case; "[done]" (or "[x]") marks it dealt with.
// - A quoted phrase before the colon anchors the note to those words in its
//   paragraph; a phrase no longer there leaves the note on the paragraph.
// - A note belongs to the paragraph (or heading) above it: the run of
//   non-blank lines ending at the line before the first of its notes.
// - Every write returns the file's lines after it; the caller writes them
//   back with replaceLines, one edit and one undo.

export type NoteState = 'open' | 'done';

export type Note = {
    line: number;            // the note's own line, zero based
    state: NoteState;
    anchor: string;          // the quoted phrase, or ''
    text: string;
    indent: string;
    para: [number, number];  // the lines it is about, inclusive; [-1, -1] for none
    // Where the anchor is in the paragraph, if it is still there.
    at: { line: number; from: number; to: number } | null;
};

export const NOTE_RE = /^(\s*)#\s+NOTE(?:\[(done|x| )\])?(?:\s+"([^"]*)")?\s*:\s?(.*)$/i;

export function isNoteLine(l: string): boolean {
    return NOTE_RE.test(l);
}

function blank(l: string): boolean { return l.trim() === ''; }
// Not prose: a heading, a keyword line, another comment, a drawer's line or
// a planning line. A paragraph stops at one.
function edge(l: string): boolean {
    return /^\*+\s/.test(l) || /^\s*#(\+|\s|$)/.test(l) || /^\s*:[\w-]*:/.test(l) || /^\s*(SCHEDULED|DEADLINE|CLOSED):/.test(l);
}

// The paragraph above line `i`: back over notes, then the run of non-blank
// lines up to a blank line or a heading (a heading is a paragraph of one).
function paragraphAbove(lines: string[], i: number): [number, number] {
    let k = i - 1;
    while (k >= 0 && isNoteLine(lines[k])) { k--; }
    if (k < 0 || blank(lines[k])) { return [-1, -1]; }
    const end = k;
    if (/^\*+\s/.test(lines[k])) { return [k, k]; }
    while (k - 1 >= 0 && !blank(lines[k - 1]) && !edge(lines[k - 1])) { k--; }
    return [k, end];
}

export function parseNotes(lines: string[]): Note[] {
    const out: Note[] = [];
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        // A "# NOTE" inside a source or example block is code, not a note.
        if (/^\s*#\+BEGIN_/i.test(l)) { inBlock = true; continue; }
        if (/^\s*#\+END_/i.test(l)) { inBlock = false; continue; }
        if (inBlock) { continue; }
        const m = NOTE_RE.exec(l);
        if (!m) { continue; }
        const para = paragraphAbove(lines, i);
        const anchor = m[3] || '';
        let at: Note['at'] = null;
        if (anchor && para[0] >= 0) {
            for (let p = para[0]; p <= para[1] && !at; p++) {
                const c = lines[p].indexOf(anchor);
                if (c >= 0) { at = { line: p, from: c, to: c + anchor.length }; }
            }
        }
        const s = (m[2] || '').toLowerCase();
        out.push({
            line: i, state: s === 'done' || s === 'x' ? 'done' : 'open', anchor, text: m[4] || '',
            indent: m[1], para, at,
        });
    }
    return out;
}

export function formatNote(n: { indent?: string; state: NoteState; anchor: string; text: string }): string {
    const anchor = n.anchor.replace(/"/g, '').replace(/\s+/g, ' ').trim();
    return `${n.indent || ''}# NOTE${n.state === 'done' ? '[done]' : ''}${anchor ? ` "${anchor}"` : ''}: ${n.text.replace(/\s*\n\s*/g, ' ').trim()}`;
}

// Where a new note about line `line` goes: under its paragraph, after any
// notes already there. A blank line, or a heading line, gets it right below.
export function noteSpot(lines: string[], line: number): { at: number; indent: string } {
    if (lines.length === 0) { return { at: 0, indent: '' }; }
    let k = Math.max(0, Math.min(line, lines.length - 1));
    if (!blank(lines[k]) && !/^\*+\s/.test(lines[k])) {
        while (k + 1 < lines.length && !blank(lines[k + 1]) && !edge(lines[k + 1])) { k++; }
    }
    const indent = /^\*+\s/.test(lines[k]) ? '' : (/^(\s*)/.exec(lines[k]) || ['', ''])[1];
    let at = k + 1;
    while (at < lines.length && isNoteLine(lines[at])) { at++; }
    return { at, indent };
}

// A note about line `line`, anchored to `anchor` (the selected words, '' for
// none): the lines after, and the line the note is on.
export function addNote(lines: string[], line: number, text: string, anchor: string): { lines: string[]; line: number } {
    const { at, indent } = noteSpot(lines, line);
    // Only words from one line, and not too many of them, make an anchor.
    const a = anchor.includes('\n') ? '' : anchor.trim().slice(0, 80);
    return { lines: [...lines.slice(0, at), formatNote({ indent, state: 'open', anchor: a, text }), ...lines.slice(at)], line: at };
}

function rewrite(lines: string[], line: number, f: (n: Note) => string | null): string[] | null {
    const n = parseNotes(lines).find(x => x.line === line);
    if (!n) { return null; }
    const v = f(n);
    return v === null ? [...lines.slice(0, line), ...lines.slice(line + 1)] : [...lines.slice(0, line), v, ...lines.slice(line + 1)];
}

export function setNoteState(lines: string[], line: number, state: NoteState): string[] | null {
    return rewrite(lines, line, n => formatNote({ ...n, state }));
}

export function setNoteText(lines: string[], line: number, text: string): string[] | null {
    return rewrite(lines, line, n => formatNote({ ...n, text }));
}

export function deleteNote(lines: string[], line: number): string[] | null {
    return rewrite(lines, line, () => null);
}

export function openCount(notes: Note[]): number {
    return notes.filter(n => n.state === 'open').length;
}

// Notes as comment threads: the notes under one paragraph together (they are
// always on consecutive lines), anchored to its lines; a note with no
// paragraph above it is anchored to its own line.
export type NoteGroup = { range: [number, number]; notes: Note[] };

export function noteGroups(notes: Note[]): NoteGroup[] {
    const out: NoteGroup[] = [];
    for (const n of notes) {
        const last = out[out.length - 1];
        const prev = last && last.notes[last.notes.length - 1];
        if (prev && prev.line === n.line - 1 && prev.para[0] === n.para[0] && prev.para[1] === n.para[1]) {
            last.notes.push(n);
        } else {
            out.push({ range: n.para[0] >= 0 ? [n.para[0], n.para[1]] : [n.line, n.line], notes: [n] });
        }
    }
    return out;
}

// The next note after line `line` (or before it, going back), round the end.
export function nextNote(notes: Note[], line: number, dir: 1 | -1): Note | undefined {
    if (notes.length === 0) { return undefined; }
    if (dir > 0) { return notes.find(n => n.line > line) || notes[0]; }
    for (let i = notes.length - 1; i >= 0; i--) {
        if (notes[i].line < line) { return notes[i]; }
    }
    return notes[notes.length - 1];
}
