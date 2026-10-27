// Docked worg following the editor: which heading the cursor is in, said the
// way worg's `worg:reveal` wants it (worg's reveal.ts). No vscode, unit tested.

import { headingAt, olpOf, parseHeading, COMMON_KEYWORDS } from './outline/model';

export interface WorgReveal {
    type: 'worg:reveal';
    file: string;       // as the server names it
    line: number;       // 0-based, the heading's line
    olp?: string[];     // titles from the top down to the heading, itself last
    heading?: string;
}

// The reveal for a cursor on `line` of a file, or undefined above the first
// heading (there is nothing to follow there).
export function revealAt(lines: string[], line: number, file: string, keywords: string[] = COMMON_KEYWORDS): WorgReveal | undefined {
    const h = headingAt(lines, line);
    if (h < 0 || h >= lines.length) {
        return undefined;
    }
    const parsed = parseHeading(lines[h], h, keywords);
    const olp = olpOf(lines, h, keywords);
    return { type: 'worg:reveal', file, line: h, olp, heading: parsed ? parsed.title : olp[olp.length - 1] };
}

// The server's name for a local file: org.serverPathMap (server prefix ->
// local prefix) read backwards. The same path when nothing maps it, which is
// also right for a server on this machine; worg matches a file by its tail
// when the roots differ anyway.
export function serverPath(local: string, map: { [server: string]: string } = {}): string {
    const name = local.replace(/\\/g, '/');
    for (const from of Object.keys(map)) {
        const to = (map[from] || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (to && (name === to || name.startsWith(to + '/'))) {
            return from.replace(/\\/g, '/').replace(/\/+$/, '') + name.substring(to.length);
        }
    }
    return name;
}

// Whether a move is to a different heading than the one last revealed.
export function sameReveal(a: WorgReveal | undefined, b: WorgReveal | undefined): boolean {
    return !!a && !!b && a.file === b.file && a.line === b.line;
}
