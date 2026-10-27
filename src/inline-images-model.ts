// Inline images as plain data: which links in a file are pictures, how wide
// org says to draw them, whether the file wants them shown, where an
// attachment: link's file is, and how big a picture is. No vscode here;
// src/inline-images.ts draws them. A port of worg's inlineimages.ts, so the
// editor and the web view agree about which links are pictures.
//
// - A picture is a link whose target ends in an image extension:
//   [[file:x.png]], [[./x.jpg][a caption]], [[https://.../x.webp]],
//   [[attachment:x.png]], or a bare file:x.png. A link whose description is
//   itself a picture link ([[file:big.png][file:thumb.png]]) shows the
//   description, as org does.
// - Width is org-display-inline-images': #+ATTR_ORG: :width, else
//   #+ATTR_HTML: :width, on the lines just above the link.
// - Shown or not: the reader's switch for the file, else the file's own
//   #+STARTUP: inlineimages / noinlineimages, else the org.inlineImages
//   setting.

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

export interface Width { px?: number; pct?: number; }

export interface ImageRef {
    line: number;       // zero based
    from: number;       // the link's columns in its line
    to: number;
    target: string;     // as written, file: and all
    desc: string;
    width: Width | null;
}

// The path of a target, less file: (or attachment:), a search option and a query.
export function targetPath(t: string): string {
    let s = t.trim().replace(/^(file|attachment):(\/\/)?/i, '');
    const i = s.indexOf('::');
    if (i >= 0) {
        s = s.slice(0, i);
    }
    return s.split(/[?#]/)[0];
}

export function isImageTarget(t: string): boolean {
    const s = t.trim();
    if (/^data:image\//i.test(s)) {
        return true;
    }
    // Other link types (id:, roam:, mailto: ...) are never pictures.
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(file|https?|attachment):/i.test(s)) {
        return false;
    }
    return IMAGE_EXT.test(targetPath(s));
}

// Fetched over the network, so only ever shown in a hover.
export function isRemote(t: string): boolean {
    return /^(https?:)?\/\//i.test(t.trim()) || /^data:/i.test(t.trim());
}

export function isAttachment(t: string): boolean {
    return /^attachment:/i.test(t.trim());
}

const BEGIN = /^\s*#\+begin_(src|example|export|comment)\b/i;
const END = /^\s*#\+end_(src|example|export|comment)\b/i;
const LINK = /\[\[([^\]\n]+)\](?:\[([^\]\n]*)\])?\]/g;
const BARE = /(^|[\s(])(file:[^\s\]\[()<>"']+)/g;
const AFFILIATED = /^\s*#\+(attr_[a-z]+|caption|name|label|results)(\[[^\]]*\])?:/i;

// Every picture link in the file, outside source, example, export and
// comment blocks.
export function imageLinks(lines: string[]): ImageRef[] {
    const out: ImageRef[] = [];
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (inBlock) {
            if (END.test(l)) {
                inBlock = false;
            }
            continue;
        }
        if (BEGIN.test(l)) {
            inBlock = true;
            continue;
        }
        if (l.indexOf('[[') < 0 && l.indexOf('file:') < 0) {
            continue;
        }
        if (/^\s*#\+/.test(l) || /^\s*:[\w-]+:/.test(l)) {
            continue;   // keywords, drawer lines
        }
        let width: Width | null | undefined;
        const covered: [number, number][] = [];
        LINK.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = LINK.exec(l)) !== null) {
            covered.push([m.index, m.index + m[0].length]);
            const target = m[1], desc = m[2] || '';
            const pic = desc && isImageTarget(desc) ? desc : isImageTarget(target) ? target : '';
            if (!pic) {
                continue;
            }
            if (width === undefined) {
                width = widthAbove(lines, i);
            }
            out.push({ line: i, from: m.index, to: m.index + m[0].length, target: pic, desc: pic === desc ? '' : desc, width });
        }
        BARE.lastIndex = 0;
        while ((m = BARE.exec(l)) !== null) {
            const from = m.index + m[1].length, to = from + m[2].length;
            if (covered.some(([a, b]) => from >= a && from < b) || !isImageTarget(m[2])) {
                continue;
            }
            if (width === undefined) {
                width = widthAbove(lines, i);
            }
            out.push({ line: i, from, to, target: m[2], desc: '', width });
        }
    }
    return out;
}

// :width from the #+ATTR_ lines straight above, #+ATTR_ORG first.
export function widthAbove(lines: string[], line: number): Width | null {
    let org: Width | null = null, html: Width | null = null;
    for (let j = line - 1; j >= 0 && AFFILIATED.test(lines[j]); j--) {
        const m = /^\s*#\+attr_([a-z]+)(?:\[[^\]]*\])?:(.*)$/i.exec(lines[j]);
        if (!m) {
            continue;
        }
        const w = parseWidth(m[2]);
        if (!w) {
            continue;
        }
        if (m[1].toLowerCase() === 'org') {
            org = org || w;
        } else if (m[1].toLowerCase() === 'html') {
            html = html || w;
        }
    }
    return org || html;
}

export function parseWidth(attrs: string): Width | null {
    const m = /(?:^|\s):width\s+("?)([0-9.]+)\s*(px|%)?\1(?=\s|$)/i.exec(attrs);
    if (!m) {
        return null;
    }
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) {
        return null;
    }
    if (m[3] === '%') {
        return { pct: Math.min(100, n) };
    }
    if (!m[3] && n <= 1 && m[2].includes('.')) {
        return { pct: n * 100 };   // org's 0.5 = half the column
    }
    return { px: Math.round(n) };
}

// The file's own say: true, false, or null for nothing said.
export function startupImages(lines: string[]): boolean | null {
    let v: boolean | null = null;
    for (const l of lines) {
        if (/^\*+\s/.test(l)) {
            break;   // #+STARTUP belongs above the first heading
        }
        const m = /^\s*#\+startup:(.*)$/i.exec(l);
        if (!m) {
            continue;
        }
        for (const w of m[1].trim().split(/\s+/)) {
            if (w.toLowerCase() === 'inlineimages') {
                v = true;
            } else if (w.toLowerCase() === 'noinlineimages') {
                v = false;
            }
        }
    }
    return v;
}

// Shown for this file? The reader's toggle (null when untouched) wins, then
// the file's #+STARTUP, then the setting.
export function fileOn(toggle: boolean | null, lines: string[], setting: boolean): boolean {
    if (toggle !== null) {
        return toggle;
    }
    const s = startupImages(lines);
    return s === null ? setting : s;
}

// The width in pixels to draw a picture at in a hover: org's, with a
// percentage read against `column` pixels.
export function pixelWidth(w: Width | null, column: number, fallback: number): number {
    if (w && w.px) {
        return w.px;
    }
    if (w && w.pct) {
        return Math.max(16, Math.round(column * w.pct / 100));
    }
    return fallback;
}

// -- Attachments ---------------------------------------------------------------

// The heading a line is under, and the :DIR: / :ATTACH_DIR: and :ID: in its
// property drawer, which decide where its attachments are (orgs'
// common.AttachDirFrom; :DIR: wins outright).
export function attachProps(lines: string[], line: number): { dir: string; id: string } {
    let h = -1;
    for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
        if (/^\*+\s/.test(lines[i])) {
            h = i;
            break;
        }
    }
    const out = { dir: '', id: '' };
    if (h < 0) {
        return out;
    }
    let i = h + 1;
    // Planning lines may sit between the headline and the drawer.
    while (i < lines.length && /^\s*(SCHEDULED|DEADLINE|CLOSED):/.test(lines[i])) {
        i++;
    }
    if (i >= lines.length || !/^\s*:PROPERTIES:\s*$/i.test(lines[i])) {
        return out;
    }
    for (i++; i < lines.length && !/^\s*:END:\s*$/i.test(lines[i]); i++) {
        const m = /^\s*:([^:\s]+):\s*(.*?)\s*$/.exec(lines[i]);
        if (!m) {
            continue;
        }
        const k = m[1].toUpperCase();
        if ((k === 'DIR' || k === 'ATTACH_DIR') && !out.dir) {
            out.dir = m[2];
        } else if (k === 'ID') {
            out.id = m[2];
        }
    }
    return out;
}

// An id's folder under the attachment root: the first two characters, then
// the rest (org-attach-id-uuid-folder-format).
export function attachIdPath(id: string): string {
    id = id.trim();
    return id.length < 3 ? id : id.slice(0, 2) + '/' + id.slice(2);
}

// The file an attachment: link names inside its heading's folder, or '' for
// one that would climb out of it.
export function attachName(target: string): string {
    const name = targetPath(target).replace(/^\/\//, '').trim();
    if (!name || name.startsWith('/') || name.split('/').some(p => p === '..')) {
        return '';
    }
    return name;
}

// -- Picture sizes -----------------------------------------------------------

// The natural size of a png, gif, jpeg, webp, bmp or svg, from its first
// bytes. Null when it cannot be told.
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
    const u16be = (o: number) => (b[o] << 8) | b[o + 1];
    const u16le = (o: number) => b[o] | (b[o + 1] << 8);
    const u32be = (o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
    const u32le = (o: number) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        return { w: u32be(16), h: u32be(20) };
    }
    if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
        return { w: u16le(6), h: u16le(8) };
    }
    if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
        return { w: u32le(18), h: Math.abs(u32le(22) | 0) };
    }
    if (b.length >= 30 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') {
        const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (kind === 'VP8X') {
            return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
        }
        if (kind === 'VP8 ') {
            return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
        }
        if (kind === 'VP8L') {
            const v = u32le(21);
            return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
        }
        return null;
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
        // Walk the jpeg's segments to the frame header.
        let o = 2;
        while (o + 9 < b.length) {
            if (b[o] !== 0xff) {
                o++;
                continue;
            }
            const marker = b[o + 1];
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { w: u16be(o + 7), h: u16be(o + 5) };
            }
            o += 2 + u16be(o + 2);
        }
        return null;
    }
    const head = String.fromCharCode(...Array.from(b.slice(0, Math.min(b.length, 2048))));
    if (/<svg[\s>]/i.test(head)) {
        const tag = /<svg[^>]*>/i.exec(head);
        const attr = (n: string) => {
            const m = tag ? new RegExp('\\s' + n + '\\s*=\\s*["\']\\s*([0-9.]+)\\s*(px)?["\']', 'i').exec(tag[0]) : null;
            return m ? Number(m[1]) : 0;
        };
        let w = attr('width'), h = attr('height');
        if ((!w || !h) && tag) {
            const vb = /viewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(tag[0]);
            if (vb) {
                w = w || Number(vb[1]);
                h = h || Number(vb[2]);
            }
        }
        return w && h ? { w, h } : null;
    }
    return null;
}

// A thumbnail's size: no taller than the line it sits on (VS Code cannot
// draw anything taller than its line inside the text), no wider than org's
// width, keeping the picture's shape.
export function thumbSize(natural: { w: number; h: number } | null, maxH: number, maxW: number): { w: number; h: number } {
    if (!natural || natural.w <= 0 || natural.h <= 0) {
        return { w: maxH, h: maxH };
    }
    let h = Math.min(maxH, natural.h);
    let w = natural.w * h / natural.h;
    if (w > maxW) {
        w = maxW;
        h = natural.h * w / natural.w;
    }
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

// An svg of exactly this size holding the picture, so the decoration draws
// at the size asked for whatever the picture's own size is.
export function sizedSvg(dataUri: string, w: number, h: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<image width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" xlink:href="${dataUri}" href="${dataUri}"/></svg>`;
}

export function mimeOf(file: string): string {
    const ext = (/\.([a-z0-9]+)$/i.exec(file) || ['', ''])[1].toLowerCase();
    switch (ext) {
        case 'jpg': case 'jpeg': return 'image/jpeg';
        case 'svg': return 'image/svg+xml';
        case 'gif': return 'image/gif';
        case 'webp': return 'image/webp';
        case 'avif': return 'image/avif';
        case 'bmp': return 'image/bmp';
        default: return 'image/png';
    }
}
