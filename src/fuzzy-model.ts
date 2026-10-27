// Fuzzy list filtering, said again from worg/src/fuzzy.ts (itself the matcher
// in orgs' internal/common/dnd/fuzzy.go, letter for letter). Change one and
// change them all, or the letters that find a thing in worg stop finding it
// here. No vscode here.

// How good a match `pattern` is for `text`, as a subsequence: adjacent letters,
// letters that start a word and a match right at the front all count for more,
// and a big gap between letters counts for less. Null when the pattern is not
// in the text at all.
export function fuzzyScore(pattern: string, text: string): number | null {
    if (pattern === '') {
        return 0;
    }
    const pat = Array.from(pattern.toLowerCase());
    const txt = Array.from(text.toLowerCase());
    let score = 0;
    let pi = 0;
    let last = -1;
    for (let ti = 0; ti < txt.length && pi < pat.length; ti++) {
        if (txt[ti] !== pat[pi]) {
            continue;
        }
        score += 10;
        if (ti === 0) {
            score += 20;
        } else if (last === ti - 1) {
            score += 12;   // running on from the previous letter
        } else if (isBoundary(txt[ti - 1])) {
            score += 10;   // the start of a word
        }
        if (last >= 0 && ti - last > 1) {
            score -= Math.min(ti - last - 1, 6);
        }
        last = ti;
        pi++;
    }
    if (pi < pat.length) {
        return null;
    }
    // A short option that matched is likelier to be meant than a long one.
    score -= Math.floor(txt.length / 12);
    return score;
}

// Every term has to match somewhere. A term matches the option's own name
// loosely, but whatever follows the name only on a whole word: fuzzy matching
// over a sentence matches almost anything.
export function fuzzyScoreAll(terms: string[], name: string, label: string): number | null {
    let rest = label.toLowerCase();
    const at = rest.indexOf(name.toLowerCase());
    if (at >= 0) {
        rest = rest.slice(at + name.length);
    }
    let total = 0;
    for (const t of terms) {
        const n = fuzzyScore(t, name);
        if (n !== null) {
            total += n * 2;
            continue;
        }
        const i = rest.indexOf(t);
        if (i >= 0) {
            // Worth having, but always below anything named for it.
            total += 20 - Math.floor(i / 8);
            continue;
        }
        return null;
    }
    return total;
}

// The terms of a filter: lowercased, split on whitespace.
export function fuzzyTerms(filter: string): string[] {
    return filter.trim().toLowerCase().split(/\s+/).filter(t => t !== '');
}

function isBoundary(c: string): boolean {
    return ' -_/(),.\':'.includes(c);
}
