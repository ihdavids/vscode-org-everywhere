// Moving headings about: refile, copy and archive as one operation with three
// endings, said again from worg/src/move.ts. No vscode here.
//
// All three take some headings and put them somewhere; a refile leaves nothing
// behind, a copy does, and an archive works out where for itself from org's
// rules (:ARCHIVE:, then #+ARCHIVE:, then the server's default). The whole
// batch is one request, because a heading's hash does not survive its file
// being edited: the server finds them all before it writes anything.

import { fuzzyTerms, fuzzyScoreAll } from './fuzzy-model';
import { isHeadingLine, headingLevel, parseHeading, subtreeEnd } from './outline/model';

export type MoveOp = 'refile' | 'copy' | 'archive';

// One place a heading can go, as /refile/targets answers.
export interface RefileTarget {
    Hash: string;
    Filename: string;
    Olp: string[] | null;
    Level: number;
    Todo: string;
    Tags: string[] | null;
}

export interface MoveResult { Headline: string; Filename: string; Ok: boolean; Msg: string; Skipped: boolean; }
export interface MoveResponse { Ok: boolean; Msg: string; Results: MoveResult[]; Done: number; Failed: number; Skipped: number; }

export function baseName(path: string): string {
    const parts = (path || '').split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

// A target's identity within one listing. A file target has no hash.
export function targetKey(t: RefileTarget): string {
    return t.Hash || 'file:' + t.Filename;
}

// A target's identity across sessions, for the recent list: the file and the
// outline path, because a hash changes whenever anything above it in the file
// does.
export function recentKey(t: RefileTarget): string {
    return [t.Filename, ...(t.Olp || [])].join('\u0000');
}

// What a target is called: the outline path, or the file for a whole-file one.
export function targetLabel(t: RefileTarget): string {
    const olp = t.Olp || [];
    return olp.length === 0 ? baseName(t.Filename) : olp.join(' › ');
}

export function targetDetail(t: RefileTarget): string {
    return (t.Olp || []).length === 0 ? 'the end of the file' : baseName(t.Filename);
}

// Everything on a target's row the filter runs over: the path, the file, the
// keyword and the tags.
export function targetHay(t: RefileTarget): string {
    return [...(t.Olp || []), baseName(t.Filename), t.Todo, ...(t.Tags || [])].filter(Boolean).join(' ');
}

// The target's own heading title.
export function targetName(t: RefileTarget): string {
    const olp = t.Olp || [];
    return olp.length === 0 ? baseName(t.Filename) : olp[olp.length - 1];
}

// The targets matching what has been typed, best first. The name matches
// loosely and the rest of the row only on whole words; a shallower target wins
// a tie; nothing typed is the list in its own order. On top of worg's rules,
// recently used targets come first when nothing is typed and break ties when
// something is, as the palette treats its recents.
export function filterTargets(targets: RefileTarget[], query: string, limit: number = 200, recents: string[] = []): RefileTarget[] {
    const rank = new Map<string, number>();
    recents.forEach((k, i) => rank.set(k, recents.length - i));
    const terms = fuzzyTerms(query || '');
    if (terms.length === 0) {
        const used = targets.filter(t => rank.has(recentKey(t)))
            .sort((a, b) => (rank.get(recentKey(b)) || 0) - (rank.get(recentKey(a)) || 0));
        const usedSet = new Set(used);
        return [...used, ...targets.filter(t => !usedSet.has(t))].slice(0, limit);
    }
    const scored: { t: RefileTarget; score: number }[] = [];
    for (const t of targets) {
        const score = fuzzyScoreAll(terms, targetName(t), targetHay(t));
        if (score === null) {
            continue;
        }
        scored.push({ t, score: score * 10 - (t.Olp || []).length + Math.min(rank.get(recentKey(t)) || 0, 8) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.t);
}

// The Target the server wants: a heading by hash, a file by name (its end).
export function toApiTarget(t: RefileTarget): { Type: string; Filename: string; Id: string } {
    if (!t.Hash) {
        return { Type: 'file', Filename: t.Filename, Id: '' };
    }
    return { Type: 'hash', Filename: t.Filename, Id: t.Hash };
}

export function opTitle(op: MoveOp, n: number): string {
    const what = n === 1 ? 'heading' : `${n} headings`;
    return `${opVerb(op)} ${what}`;
}

export function opVerb(op: MoveOp): string {
    return op === 'copy' ? 'Copy' : op === 'archive' ? 'Archive' : 'Refile';
}

// Archive is not asked where: org works it out.
export function needsTarget(op: MoveOp): boolean {
    return op !== 'archive';
}

// What to say after. A batch that half worked says both halves, and a heading
// that went with its parent is not a failure.
export function summarise(res: MoveResponse, op: MoveOp): { tone: 'success' | 'warning' | 'danger'; text: string } {
    const did = op === 'copy' ? 'Copied' : op === 'archive' ? 'Archived' : 'Refiled';
    const bits: string[] = [];
    if (res.Done > 0) { bits.push(`${did} ${res.Done}`); }
    if (res.Skipped > 0) { bits.push(`${res.Skipped} went with a parent`); }
    if (res.Failed > 0) { bits.push(`${res.Failed} could not be`); }
    if (res.Failed > 0 && res.Done === 0) {
        return { tone: 'danger', text: bits.join(' · ') || res.Msg || 'Nothing moved.' };
    }
    if (res.Failed > 0) {
        return { tone: 'warning', text: bits.join(' · ') };
    }
    if (res.Done === 0) {
        return { tone: 'warning', text: res.Msg || 'Nothing to do.' };
    }
    return { tone: 'success', text: bits.join(' · ') };
}

export function failures(res: MoveResponse): MoveResult[] {
    return (res.Results || []).filter(r => !r.Ok && !r.Skipped);
}

// Newest first, each once, a dozen at most.
export function noteRecent(key: string, recents: string[], max: number = 12): string[] {
    return [key, ...recents.filter(r => r !== key)].slice(0, max);
}

// Where the moved headings land, said for the picker: the server puts them at
// the end of the destination's subtree, one level under it (or at the top
// level at the end of a file). `heading` is the destination's line in `lines`,
// -1 for a file target, or undefined when it could not be found.
export function landing(lines: string[], heading: number | undefined, moving: string[]): string {
    const what = moving.length === 1 ? `"${moving[0]}"` : `${moving.length} headings`;
    if (heading === undefined) {
        return `${what} go in last`;
    }
    const level = heading < 0 ? 0 : headingLevel(lines[heading]);
    const from = heading < 0 ? 0 : heading + 1;
    const end = heading < 0 ? lines.length : subtreeEnd(lines, heading);
    const kids: string[] = [];
    for (let i = from; i < end; i++) {
        if (isHeadingLine(lines[i]) && headingLevel(lines[i]) === level + 1) {
            kids.push(parseHeading(lines[i], i, []).title);
        }
    }
    const stars = '*'.repeat(level + 1);
    const verb = moving.length === 1 ? 'lands' : 'land';
    if (kids.length === 0) {
        return heading < 0 ? `${what} ${verb} as the file's first ${stars} heading` : `${what} ${verb} as its first child (${stars})`;
    }
    return `${what} ${verb} at ${stars} after "${kids[kids.length - 1]}" (${kids.length} there now)`;
}
