// The Mentions panel's model: the wire types of /links/heading, /mentions and
// /mentions/link (orgs' mentions.go), and how a mention or a link is cut down
// to one line of a tree with its match picked out. A port of the parts of
// worg's mentions.ts the panel uses. No vscode here.
//
// What counts as a mention is decided by the server and nowhere else.

export interface LinkTarget {
    Kind: 'heading' | 'file' | string;
    Filename: string;
    Hash: string;
    Headline: string;
    Olp: string[] | null;
    Line: number;
    Title: string;
    Id: string;
    Terms: string[] | null;
    Skipped: string[] | null;
}

export interface LinkEnd { Filename: string; Hash: string; Headline: string; Olp: string[] | null; Level: number; Line: number; }

// A link, with the line it is written on cut at the link (Before/Shown/After,
// empty when the server could not find it there).
export interface LinkInContext {
    From: LinkEnd;
    To: LinkEnd;
    Raw: string;
    Desc: string;
    Kind: string;
    Broken: boolean;
    Context: string;
    Before: string;
    Shown: string;
    After: string;
}

export interface LinksAround { Ok: boolean; Msg: string; Target: LinkTarget; In: LinkInContext[] | null; Out: LinkInContext[] | null; }

export interface Mention {
    Filename: string;
    Line: number;   // zero based
    Col: number;    // a byte offset on the server's side: handed back, never used here
    Text: string;
    Term: string;
    Before: string;
    After: string;
    Hash: string;
    Headline: string;
    Olp: string[] | null;
    InHeadline: boolean;
}

export interface MentionsResult { Ok: boolean; Msg: string; Target: LinkTarget; Mentions: Mention[] | null; Total: number; Truncated: boolean; }

export interface MentionRef { Filename: string; Line: number; Col: number; Text: string; }
export interface MentionLinkRequest { Hash: string; Filename: string; Mentions: MentionRef[]; }
export interface MentionLinkOutcome extends MentionRef { Ok: boolean; Msg: string; Link: string; }
export interface MentionLinkResult { Ok: boolean; Msg: string; Linked: number; Id: string; NewId: boolean; Results: MentionLinkOutcome[] | null; }

// A label with one part of it to highlight, as a TreeItemLabel wants it.
export interface Marked { label: string; highlight: [number, number] | null; }

// A sentence cut down to about `width` characters around its match, cut at a
// word where there is one near, and marked with an ellipsis where it was cut.
// The match itself is never cut: it is the thing being shown.
export function snippet(before: string, match: string, after: string, width: number = 72): [string, string, string] {
    const room = Math.max(0, width - match.length);
    // A little more of what comes before than after: the words leading up to
    // a name are what say how it is being used.
    let b = before.replace(/\s+/g, ' ');
    let a = after.replace(/\s+/g, ' ');
    const wantB = Math.ceil(room * 0.55);
    const wantA = room - Math.min(b.length, wantB);
    if (b.length > wantB) {
        let cut = b.slice(b.length - wantB);
        const sp = cut.search(/\s/);
        if (sp >= 0 && sp < 12) {
            cut = cut.slice(sp + 1);
        }
        b = '…' + cut.replace(/^…/, '');
    }
    if (a.length > wantA) {
        let cut = a.slice(0, Math.max(0, wantA));
        const sp = cut.search(/\s\S*$/);
        if (sp > 0 && cut.length - sp < 12) {
            cut = cut.slice(0, sp);
        }
        a = cut.replace(/…$/, '') + '…';
    }
    return [b, match, a];
}

function marked(parts: [string, string, string]): Marked {
    const [b, m, a] = parts;
    const lead = b.replace(/^\s+/, '');
    return { label: lead + m + a.replace(/\s+$/, ''), highlight: m ? [lead.length, lead.length + m.length] : null };
}

// A mention as one line: its sentence, the match picked out.
export function mentionLabel(m: Mention, width: number = 72): Marked {
    return marked(snippet(m.Before, m.Text, m.After, width));
}

// The first place a needle is in a line, case insensitively, as the three
// parts around it. Null when it is not there.
export function splitOn(text: string, needle: string): [string, string, string] | null {
    const n = needle.trim();
    if (n === '') {
        return null;
    }
    const i = text.toLowerCase().indexOf(n.toLowerCase());
    if (i < 0) {
        return null;
    }
    return [text.slice(0, i), text.slice(i, i + n.length), text.slice(i + n.length)];
}

// The link's own words: the text it was written with, or the target as
// written for a bare link.
export function linkWords(l: { Desc: string; Raw: string }): string {
    if (l.Desc !== '') {
        return l.Desc;
    }
    return l.Raw.replace(/^(file|id):/, '').replace(/::.*$/, '').replace(/^\*/, '');
}

// A link into the target as one line: the line it is written on, the link
// picked out where the server cut the line at it, else where its words are.
export function linkLabel(l: LinkInContext, width: number = 72): Marked {
    const parts: [string, string, string] | null = l.Shown ? [l.Before, l.Shown, l.After] : splitOn(l.Context || '', linkWords(l));
    if (!parts) {
        return { label: (l.Context || l.Raw).trim(), highlight: null };
    }
    return marked(snippet(parts[0], parts[1], parts[2], width));
}

export function refOf(m: Mention): MentionRef {
    return { Filename: m.Filename, Line: m.Line, Col: m.Col, Text: m.Text };
}

export function mentionKey(m: MentionRef): string {
    return `${m.Filename}:${m.Line}:${m.Col}`;
}

// The request that links these mentions to the target: a heading by its
// hash, a file by its name.
export function linkRequest(t: LinkTarget, ms: Mention[]): MentionLinkRequest {
    return { Hash: t.Kind === 'heading' ? t.Hash : '', Filename: t.Kind === 'file' ? t.Filename : '', Mentions: ms.map(refOf) };
}

// What to say after linking.
export function linkedNote(t: LinkTarget, res: MentionLinkResult | undefined): { ok: boolean; text: string } {
    if (!res || res.Ok === undefined) {
        return { ok: false, text: 'The server did not answer.' };
    }
    if (res.Linked === 0) {
        return { ok: false, text: res.Msg || 'Nothing was linked.' };
    }
    const failed = (res.Results || []).filter(r => !r.Ok);
    let text = res.Linked === 1 ? 'Linked one mention.' : `Linked ${res.Linked} mentions.`;
    if (res.NewId) {
        text += ` ${targetLabel(t)} was given an :ID: to link to.`;
    }
    if (failed.length > 0) {
        text += ` ${failed.length} could not be: ${failed[0].Msg}`;
    }
    return { ok: res.Ok && failed.length === 0, text };
}

// The files a link request changed, for waiting on the editor to reload them.
export function changedFiles(t: LinkTarget, res: MentionLinkResult | undefined): string[] {
    const files = ((res && res.Results) || []).filter(r => r.Ok).map(r => r.Filename);
    if (t.Filename) {
        files.push(t.Filename);
    }
    return Array.from(new Set(files));
}

export interface MentionGroup { file: string; mentions: Mention[]; }

// Mentions under their file, in the order they came - the server's file and
// line order.
export function groupByFile(ms: Mention[]): MentionGroup[] {
    const out: MentionGroup[] = [];
    for (const m of ms) {
        const last = out.length ? out[out.length - 1] : null;
        if (last && last.file === m.Filename) {
            last.mentions.push(m);
        } else {
            out.push({ file: m.Filename, mentions: [m] });
        }
    }
    return out;
}

// What the panel calls its target.
export function targetLabel(t: LinkTarget | null | undefined): string {
    if (!t) {
        return '';
    }
    if (t.Kind === 'heading') {
        return t.Headline || t.Title;
    }
    return t.Title || t.Filename.split('/').pop() || t.Filename;
}

// What was looked for and what was left out, because "no mentions" of a
// heading called Notes and of one called Apollo mean different things.
export function searchedNote(t: LinkTarget | null | undefined): string {
    if (!t) {
        return '';
    }
    const terms = t.Terms || [];
    const skipped = t.Skipped || [];
    const parts: string[] = [];
    if (terms.length > 0) {
        parts.push(`Looking for ${terms.map(s => `“${s}”`).join(', ')}`);
    }
    if (skipped.length > 0) {
        parts.push(`not searched: ${skipped.join('; ')}`);
    }
    return parts.join(' · ');
}

// The query a target is asked for by: file and line, never hash. Linking a
// mention in a headline changes that heading's hash and every one after it,
// and the id drawer is written below the target's headline, so its line is
// the one thing the panel's own writes never move (worg's LinksPanel).
export function targetParams(file: string, headingLine: number, all: boolean): { [k: string]: string } {
    const p: { [k: string]: string } = { filename: file };
    if (headingLine >= 0) {
        p.line = String(headingLine);
    }
    if (all) {
        p.all = 't';
    }
    return p;
}
