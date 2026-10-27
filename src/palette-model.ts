// How Org: Menu orders its entries, said again from worg's command palette
// (worg/src/palette.ts). No vscode here.
//
// With nothing typed the order is the one they came in (what fits the cursor
// first), with whatever was used recently lifted to the front - which is what
// makes the second use faster than the first. With something typed, recency is
// a nudge: it breaks ties between equally good matches and never lifts a worse
// one over a better.

import { fuzzyScoreAll, fuzzyTerms } from './fuzzy-model';

export interface PaletteEntry {
    // Stable across sessions: it is what the recents list stores.
    id: string;
    // What is read and matched loosely.
    name: string;
    // Matched too, but only on whole words.
    hint?: string;
}

function labelOf(c: PaletteEntry): string {
    return c.hint ? `${c.name} ${c.hint}` : c.name;
}

export function rankEntries<T extends PaletteEntry>(cmds: T[], filter: string, recents: string[] = []): T[] {
    const rank = new Map<string, number>();
    recents.forEach((id, i) => rank.set(id, recents.length - i));

    const terms = fuzzyTerms(filter);
    if (terms.length === 0) {
        const used = cmds.filter(c => rank.has(c.id))
            .sort((a, b) => (rank.get(b.id) || 0) - (rank.get(a.id) || 0));
        const usedIds = new Set(used.map(c => c.id));
        return [...used, ...cmds.filter(c => !usedIds.has(c.id))];
    }

    const hits: { c: T; score: number; i: number }[] = [];
    cmds.forEach((c, i) => {
        const score = fuzzyScoreAll(terms, c.name, labelOf(c));
        if (score === null) {
            return;
        }
        hits.push({ c, score: score + Math.min(rank.get(c.id) || 0, 8), i });
    });
    hits.sort((a, b) => (b.score - a.score) || (a.i - b.i));
    return hits.map(h => h.c);
}

// How many of a ranked, unfiltered list are there because they were used.
export function recentCount(ranked: PaletteEntry[], recents: string[]): number {
    const set = new Set(recents);
    let n = 0;
    while (n < ranked.length && set.has(ranked[n].id)) {
        n++;
    }
    return n;
}

export const RECENTS_MAX = 24;

// Newest first, each id once.
export function noteUse(id: string, recents: string[], max: number = RECENTS_MAX): string[] {
    return [id, ...recents.filter(r => r !== id)].slice(0, max);
}
