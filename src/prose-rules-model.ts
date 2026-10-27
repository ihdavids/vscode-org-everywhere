// worg's built-in grammar and style rules (writing.ts), for the paragraphs
// prose-model.ts finds: words said twice (the the), a or an, a small i, a
// sentence starting small, spacing round punctuation, common slips (could of),
// wordy and redundant phrases, filler words, the passive voice, long
// sentences, names spelt two ways and a word used again too soon. Pure; they
// run with or without Harper (prose.ts). Tested by test/prose.test.ts.

import { HEADING, LineState, TodoStates, Issue, IssueKind, proseSpans } from './prose-model';

const ABBREV = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'cf', 'al', 'fig', 'no', 'vol', 'approx', 'inc', 'ltd', 'co']);

// Where each sentence of `text` starts and ends (end exclusive, trailing
// space left out).
export function sentences(text: string): [number, number][] {
    const out: [number, number][] = [];
    let s = 0;
    while (s < text.length && /\s/.test(text[s])) s++;
    const re = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const end = m.index + m[0].length;
        if (m[0][0] === '.' && m[0].length === 1) {
            const word = /([A-Za-z.]+)$/.exec(text.slice(s, m.index));
            if (word && (ABBREV.has(word[1].toLowerCase()) || /^[A-Za-z]$/.test(word[1]))) continue;
        }
        if (end > s) out.push([s, end]);
        s = end;
        while (s < text.length && /\s/.test(text[s])) s++;
    }
    let e = text.length;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push([s, e]);
    return out;
}

// The sentence holding `pos`, or the one just before it when it is in the
// gap between two.
export function sentenceAt(text: string, pos: number): [number, number] {
    const all = sentences(text);
    let best: [number, number] = [pos, pos];
    for (const r of all) {
        if (r[0] <= pos) best = r;
        if (pos <= r[1]) break;
    }
    return best;
}

const A_AN_AN = /^(hour|honest|honou?r|heir|herb)/i;            // silent h: "an"
const A_AN_A = /^(uni(?!nt|mp|nf|nh|nd|ns|nv|nc|nl|nm|nr)|use|usu|usa|ute|uti|eu|ewe|one(?!r)|once|ubiq|ukr|uran|uri|uro)/i; // a "you" or "won" sound

function wantsAn(next: string): boolean {
    if (A_AN_AN.test(next)) return true;
    if (A_AN_A.test(next)) return false;
    // An acronym is read letter by letter: an FBI, a UFO.
    if (/^[A-Z]{2,}/.test(next)) return /^[AEFHILMNORSX]/.test(next);
    return /^[aeiou]/i.test(next);
}

const WORDY: [RegExp, string, string][] = [
    [/\bin order to\b/gi, 'to', 'Wordy: "to" says the same'],
    [/\bdue to the fact that\b/gi, 'because', 'Wordy'],
    [/\bin spite of the fact that\b/gi, 'although', 'Wordy'],
    [/\bat this point in time\b/gi, 'now', 'Wordy'],
    [/\bat the present time\b/gi, 'now', 'Wordy'],
    [/\ba large number of\b/gi, 'many', 'Wordy'],
    [/\bthe majority of\b/gi, 'most', 'Wordy'],
    [/\bis able to\b/gi, 'can', 'Wordy'],
    [/\bfor the purpose of\b/gi, 'for', 'Wordy'],
    [/\bwith regard to\b/gi, 'about', 'Wordy'],
    [/\bin the event that\b/gi, 'if', 'Wordy'],
    [/\beach and every\b/gi, 'each', 'Redundant'],
    [/\bfirst and foremost\b/gi, 'first', 'Redundant'],
    [/\bvery unique\b/gi, 'unique', 'Redundant: unique is not a matter of degree'],
    [/\bpast history\b/gi, 'history', 'Redundant'],
    [/\bend result\b/gi, 'result', 'Redundant'],
    [/\bfree gift\b/gi, 'gift', 'Redundant'],
    [/\bclose proximity\b/gi, 'proximity', 'Redundant'],
    [/\badded bonus\b/gi, 'bonus', 'Redundant'],
    [/\badvance planning\b/gi, 'planning', 'Redundant'],
    [/\brevert back\b/gi, 'revert', 'Redundant'],
    [/\bfuture plans\b/gi, 'plans', 'Redundant'],
];

const WRONG: [RegExp, (m: RegExpExecArray) => string, string][] = [
    [/\b(could|should|would|must|might) of\b/gi, m => `${m[1]} have`, '"of" here is "have"'],
    [/\balot\b/gi, () => 'a lot', '"a lot" is two words'],
    [/\birregardless\b/gi, () => 'regardless', 'Not standard: "regardless"'],
    [/\byour welcome\b/gi, m => (m[0][0] === 'Y' ? "You're" : "you're") + ' welcome', '"you\'re" (you are)'],
    [/\bshould(?:n't| not) of\b/gi, m => m[0].replace(/of$/i, 'have'), '"of" here is "have"'],
    [/\b(its) (a|an|the|not|going|time)\b/g, m => `it's ${m[2]}`, '"it\'s" (it is) rather than "its" (belonging to it)?'],
    [/\b(then)(?= (?:ever|before|expected|usual|most|anyone|anything)\b)/gi, m => (m[1][0] === 'T' ? 'Than' : 'than'), '"than" compares; "then" is time'],
    [/\bless (people|things|items|words|cars|books|errors|mistakes)\b/gi, m => `fewer ${m[1]}`, '"fewer" for things you can count'],
];

const FILLER = /\b(very|really|quite|basically|actually|literally|totally|simply|just)\b/gi;
const BE = '(?:is|are|was|were|be|been|being|am|is being|are being|was being|were being)';
const IRREGULAR = 'awoken|born|beaten|begun|bent|bet|bitten|blown|broken|brought|built|burnt|bought|caught|chosen|cost|cut|dealt|done|drawn|driven|drunk|eaten|fed|felt|fought|found|flown|forbidden|forgotten|forgiven|frozen|given|grown|hung|heard|hidden|hit|held|hurt|kept|known|laid|led|left|lent|let|lost|made|meant|met|paid|put|read|ridden|rung|run|said|seen|sold|sent|set|shaken|shot|shown|shut|sung|sunk|spoken|spent|spun|spread|stolen|stuck|struck|sworn|swept|taken|taught|torn|told|thought|thrown|understood|woken|worn|won|written';
const PASSIVE = new RegExp(`\\b${BE}\\s+(?:\\w+ly\\s+)?((?:\\w+ed)|${IRREGULAR})\\b`, 'gi');
// Verbs that take no object (gone, come, risen, fallen) are left out of the
// list above: "had been gone" is not passive.
// -ed words that are adjectives far more often than participles.
const NOT_PASSIVE = /^(tired|interested|excited|bored|married|worried|pleased|supposed|used|scared|concerned|prepared|related|based|done|ashamed|limited|advanced|detailed|experienced|qualified|talented|crowded|complicated|dedicated|determined|naked|wicked|sacred|beloved)$/i;

export type Rules = { grammar: boolean; style: boolean };

// The built-in rules over a paragraph's prose. Offsets are into `text`.
export function grammarIssues(text: string, rules: Rules = { grammar: true, style: true }): Issue[] {
    const out: Issue[] = [];
    const add = (from: number, to: number, kind: IssueKind, msg: string, fixes: string[], rule: string) => {
        if (kind === 'style' ? rules.style : rules.grammar) out.push({ from, to, kind, msg, fixes, rule });
    };
    let m: RegExpExecArray | null;

    // The the.
    const rep = /\b(\p{L}+)(\s+)(\1)\b/giu;
    while ((m = rep.exec(text)) !== null) {
        if (/^(that|had|is|do|bye|no|yes|ha|so|very|really|ho|la|knock|tsk|win|chop|puff|choo|bang|boo|pom|dum)$/i.test(m[1])) continue;
        if (m[1].toLowerCase() !== m[3].toLowerCase()) continue;
        add(m.index, m.index + m[0].length, 'grammar', `"${m[1]}" twice`, [m[1]], 'repeat');
        rep.lastIndex = m.index + m[1].length;
    }

    // A / an.
    const art = /\b(a|an|A|An)(\s+)([\p{L}][\p{L}\-]*)/gu;
    while ((m = art.exec(text)) !== null) {
        const an = m[1].toLowerCase() === 'an';
        const want = wantsAn(m[3]);
        if (an !== want) {
            const cap = m[1][0] === 'A';
            const fix = (want ? (cap ? 'An' : 'an') : (cap ? 'A' : 'a'));
            add(m.index, m.index + m[1].length, 'grammar', `"${fix}" before "${m[3]}"`, [fix], 'article');
        }
        art.lastIndex = m.index + m[1].length;
    }

    // i on its own.
    const i = /(^|[\s"(“])i(?=['’](?:m|d|ll|ve)\b|[\s,;:!?]|\.(?!\w)|$)/g;
    while ((m = i.exec(text)) !== null) {
        const at = m.index + m[1].length;
        add(at, at + 1, 'grammar', '"I" is always a capital', ['I'], 'pronoun');
    }

    // A sentence starting small. The first sentence of a paragraph is left
    // alone: a list item or a heading is often lower case on purpose.
    for (const [s] of sentences(text).slice(1)) {
        const c = text[s];
        if (c && /\p{Ll}/u.test(c)) {
            const prev = text.slice(0, s).trimEnd();
            const word = /([A-Za-z.]+)\.$/.exec(prev);
            if (word && ABBREV.has(word[1].toLowerCase())) continue;
            add(s, s + 1, 'grammar', 'A sentence starts with a capital', [c.toUpperCase()], 'capital');
        }
    }

    // Spacing round punctuation.
    const before = /(\p{L}) +([,;:!?](?!\S*[=/]))/gu;
    while ((m = before.exec(text)) !== null) {
        if (m[2] === ':' && text[m.index + m[0].length] === ':') continue;   // a description list's ::
        add(m.index + 1, m.index + m[0].length, 'grammar', `No space before "${m[2]}"`, [m[2]], 'space-before');
    }
    const after = /(\p{Ll}{2,})([,;])(\p{L})/gu;
    while ((m = after.exec(text)) !== null) {
        add(m.index + m[1].length, m.index + m[1].length + 1, 'grammar', `A space after "${m[2]}"`, [`${m[2]} `], 'space-after');
    }
    const twice = /(\p{L}[,;]?)( {2,})(?=\p{L})/gu;
    while ((m = twice.exec(text)) !== null) {
        add(m.index + m[1].length, m.index + m[0].length, 'style', 'Two spaces between words', [' '], 'spaces');
    }

    for (const [re, fix, msg] of WRONG) {
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) add(m.index, m.index + m[0].length, 'grammar', msg, [fix(m)], 'usage');
    }
    for (const [re, fix, msg] of WORDY) {
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            const f = /^[A-Z]/.test(m[0]) ? fix[0].toUpperCase() + fix.slice(1) : fix;
            add(m.index, m.index + m[0].length, 'style', `${msg}: "${f}"`, [f], 'wordy');
        }
    }
    FILLER.lastIndex = 0;
    while ((m = FILLER.exec(text)) !== null) {
        // Removing the word takes one of the spaces round it.
        const sp = text[m.index + m[0].length] === ' ' ? 1 : 0;
        add(m.index, m.index + m[0].length + sp, 'style', `"${m[0]}" seldom adds anything`, [''], 'filler');
    }
    PASSIVE.lastIndex = 0;
    while ((m = PASSIVE.exec(text)) !== null) {
        if (NOT_PASSIVE.test(m[1])) continue;
        add(m.index, m.index + m[0].length, 'style', 'Passive voice: who does it?', [], 'passive');
    }
    for (const [s, e] of sentences(text)) {
        const n = (text.slice(s, e).match(/\p{L}+/gu) || []).length;
        if (n > 40) add(s, e, 'style', `A long sentence (${n} words): could it be two?`, [], 'long');
    }
    return out.sort((a, b) => a.from - b.from || a.to - b.to);
}


// Capitalised words not starting a sentence, counted over the whole file:
// the people and places a story is about.
export function nameIndex(lines: string[], states: LineState[], todo: TodoStates): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < lines.length; i++) {
        if (!states[i] || HEADING.test(lines[i])) continue;
        for (const s of proseSpans(lines[i], states[i], todo)) {
            const t = lines[i].slice(s.from, s.to);
            const re = /(^|[^.!?:;"“'‘(\s])(\s+)(\p{Lu}\p{Ll}{2,})(?=[\s,.;:!?'’"”)]|$)/gu;
            let m: RegExpExecArray | null;
            while ((m = re.exec(t)) !== null) {
                out.set(m[3], (out.get(m[3]) || 0) + 1);
                re.lastIndex = m.index + m[1].length + m[2].length + m[3].length;
            }
        }
    }
    return out;
}

// Optimal string alignment distance: insert, delete, change, and swapping
// two neighbours - the commonest slip of all, so it costs less.
export function distance(a: string, b: string): number {
    const d: number[][] = [];
    for (let i = 0; i <= a.length; i++) d.push([i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const c = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 0.75);
        }
    }
    return d[a.length][b.length];
}

function close(a: string, b: string): boolean {
    return a !== b && a[0] === b[0] && distance(a, b) <= (Math.min(a.length, b.length) >= 7 ? 2 : 1);
}

// A name written once or twice that is one slip away from a name written far
// more often: Marra for Mara.
export function nameIssues(text: string, names: Map<string, number>): Issue[] {
    const out: Issue[] = [];
    const re = /\p{Lu}\p{Ll}{2,}/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const w = m[0];
        const n = names.get(w) || 0;
        if (n > 2) continue;
        let best = '';
        let bestN = 0;
        names.forEach((c, k) => { if (c >= 3 && c > bestN && c >= 3 * Math.max(n, 1) && close(w, k)) { best = k; bestN = c; } });
        if (best) out.push({ from: m.index, to: m.index + w.length, kind: 'spell', msg: `"${w}" - elsewhere it is "${best}" (${bestN} times)`, fixes: [best], rule: 'name' });
    }
    return out;
}

const ECHO_SKIP = new Set(('that this with from have they them their there were what when which while would could should about into than then your just like been more some only also over very much said each other after before because where these those being does didn').split(' '));

// A word (four letters or more, not a common one) used again within `window`
// words of the last time: the second is marked.
export function echoIssues(text: string, window = 25): Issue[] {
    const out: Issue[] = [];
    const seen = new Map<string, number>();
    const re = /\p{L}[\p{L}'’]*/gu;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(text)) !== null) {
        const w = m[0].toLowerCase().replace(/['’]s$/, '');
        n++;
        // A name said again is how stories go.
        if (/^\p{Lu}/u.test(m[0]) && m[0] !== m[0].toUpperCase() && w !== 'the') { if (n > 1 && !/[.!?]\s*$/.test(text.slice(0, m.index))) continue; }
        if (w.length < 4 || ECHO_SKIP.has(w)) continue;
        const last = seen.get(w);
        if (last !== undefined && n - last <= window) {
            out.push({ from: m.index, to: m.index + m[0].length, kind: 'style', msg: `"${m[0]}" again, ${n - last} words after the last`, fixes: [], rule: 'echo' });
        }
        seen.set(w, n);
    }
    return out;
}

// Every built-in issue in one paragraph's prose, as worg's checker runs them
// (less its dictionary: spelling is Harper's).
export function localIssues(text: string, names: Map<string, number>, rules: Rules = { grammar: true, style: true }): Issue[] {
    const out: Issue[] = [...nameIssues(text, names)];
    if (rules.grammar || rules.style) out.push(...grammarIssues(text, rules));
    if (rules.style) out.push(...echoIssues(text));
    return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
