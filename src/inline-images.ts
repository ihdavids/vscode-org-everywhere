// Inline images: a thumbnail of the picture after each image link, and the
// picture itself, bigger, on hover. VS Code cannot draw anything taller than
// a line inside the text, so the thumbnail is line high; hover (or Show
// Pictures And Maths) for the full picture. Which links are pictures, and
// whether a file wants them, is src/inline-images-model.ts.
//
// Local pictures are read from disk, relative to the org file; attachment:
// links from their heading's :DIR:, or the attachment store under :ID:. Web
// pictures are never fetched for a thumbnail, only shown in the hover.
// Plain file: picture links already have a hover (src/links/providers.ts), so
// the hover here is for web and attachment: pictures only.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { resolvePath } from './org-files';
import {
    ImageRef, imageLinks, fileOn, isRemote, isAttachment, attachProps, attachIdPath, attachName, targetPath,
    imageSize, thumbSize, sizedSvg, mimeOf, pixelWidth,
} from './inline-images-model';

const TOGGLES = 'org.inlineImages.toggles';
// Bigger than this and a thumbnail costs more than it is worth.
const MAX_BYTES = 8 * 1024 * 1024;
// A % width is read against a column this wide.
const COLUMN_PX = 600;

let ctx: vscode.ExtensionContext;
let deco: vscode.TextEditorDecorationType;
// The reader's switch per file; a file not in here follows its #+STARTUP.
let toggles: { [file: string]: boolean } = {};
// Thumbnails made, by picture file, size and mtime.
const thumbs = new Map<string, vscode.Uri | null>();

function setting(): boolean {
    return vscode.workspace.getConfiguration('org').get<boolean>('inlineImages', true) !== false;
}

function lineHeight(): number {
    const ed = vscode.workspace.getConfiguration('editor');
    const lh = ed.get<number>('lineHeight', 0);
    const size = ed.get<number>('fontSize', 14);
    // lineHeight under 8 is a multiple of the font size.
    const px = lh <= 0 ? size * 1.35 : lh < 8 ? lh * size : lh;
    return Math.max(10, Math.floor(px) - 2);
}

function linesOf(doc: vscode.TextDocument): string[] {
    return doc.getText().split(/\r?\n/);
}

export function imagesOn(doc: vscode.TextDocument): boolean {
    const t = toggles[doc.uri.toString()];
    return fileOn(t === undefined ? null : t, linesOf(doc), setting());
}

// The file an attachment: link names: under its heading's :DIR:, or under
// the attachment store's folder for its :ID: (orgs' default store is data/
// beside the first org directory, so the workspace folders and the folders
// above the file are tried).
export function attachmentFile(docFile: string, lines: string[], ref: ImageRef): string {
    const name = attachName(ref.target);
    if (!name) {
        return '';
    }
    const { dir, id } = attachProps(lines, ref.line);
    if (dir) {
        return path.join(resolvePath(docFile, dir), name);
    }
    if (!id) {
        return '';
    }
    const roots: string[] = [];
    const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(docFile));
    for (let d = path.dirname(docFile); ; d = path.dirname(d)) {
        roots.push(d);
        if ((ws && d === ws.uri.fsPath) || path.dirname(d) === d) {
            break;
        }
    }
    (vscode.workspace.workspaceFolders || []).forEach(f => roots.push(f.uri.fsPath));
    for (const r of roots) {
        const f = path.join(r, 'data', attachIdPath(id), name);
        if (fs.existsSync(f)) {
            return f;
        }
    }
    return '';
}

// The picture a link shows, on disk; '' for a web picture or one not found.
export function localFile(docFile: string, lines: string[], ref: ImageRef): string {
    if (isRemote(ref.target)) {
        return '';
    }
    const f = isAttachment(ref.target) ? attachmentFile(docFile, lines, ref) : resolvePath(docFile, decodeURI(targetPath(ref.target)));
    return f && fs.existsSync(f) ? f : '';
}

// A thumbnail of a picture at most maxW wide, line high: an svg of exactly
// that size holding the picture, written once into the extension's storage.
function thumbnail(file: string, maxH: number, maxW: number): vscode.Uri | null {
    let st: fs.Stats;
    try {
        st = fs.statSync(file);
    } catch (e) {
        return null;
    }
    if (st.size > MAX_BYTES || st.size === 0) {
        return null;
    }
    const key = `${file}|${st.mtimeMs}|${st.size}|${maxH}|${maxW}`;
    if (thumbs.has(key)) {
        return thumbs.get(key) || null;
    }
    let uri: vscode.Uri | null = null;
    try {
        const bytes = fs.readFileSync(file);
        const size = thumbSize(imageSize(bytes), maxH, maxW);
        const svg = sizedSvg(`data:${mimeOf(file)};base64,${bytes.toString('base64')}`, size.w, size.h);
        const dir = path.join(ctx.globalStorageUri.fsPath, 'inline-images');
        fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, crypto.createHash('sha1').update(key).digest('hex') + '.svg');
        if (!fs.existsSync(out)) {
            fs.writeFileSync(out, svg);
        }
        uri = vscode.Uri.file(out);
    } catch (e) {
        uri = null;
    }
    thumbs.set(key, uri);
    return uri;
}

function decorate(editor: vscode.TextEditor) {
    const doc = editor.document;
    if (doc.languageId !== 'org') {
        return;
    }
    if (!imagesOn(doc)) {
        editor.setDecorations(deco, []);
        return;
    }
    const lines = linesOf(doc);
    const maxH = lineHeight();
    const out: vscode.DecorationOptions[] = [];
    for (const ref of imageLinks(lines)) {
        const file = localFile(doc.fileName, lines, ref);
        if (!file) {
            continue;
        }
        const uri = thumbnail(file, maxH, pixelWidth(ref.width, COLUMN_PX, 10 * maxH));
        if (!uri) {
            continue;
        }
        out.push({
            range: new vscode.Range(ref.line, ref.to, ref.line, ref.to),
            renderOptions: { after: { contentIconPath: uri, margin: '0 0 0 4px' } },
        });
    }
    editor.setDecorations(deco, out);
}

function decorateAll() {
    vscode.window.visibleTextEditors.forEach(decorate);
}

// Web and attachment: pictures on hover, at org's width.
class ImageHover implements vscode.HoverProvider {
    provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
        const lines = linesOf(doc);
        // Everything above the line, for the block it may be in and its #+ATTR_ width.
        const full = imageLinks(lines.slice(0, pos.line + 1)).find(r => r.line === pos.line && pos.character >= r.from && pos.character <= r.to);
        if (!full || !(isRemote(full.target) || isAttachment(full.target))) {
            return undefined;
        }
        const ref = full;
        const range = new vscode.Range(ref.line, ref.from, ref.line, ref.to);
        let src = '';
        let width = pixelWidth(full.width, COLUMN_PX, 360);
        if (isRemote(full.target)) {
            src = full.target.trim().replace(/^\/\//, 'https://');
        } else {
            const file = localFile(doc.fileName, lines, full);
            if (!file) {
                return new vscode.Hover(new vscode.MarkdownString(`$(warning) No attachment found for \`${full.target}\``, true), range);
            }
            src = vscode.Uri.file(file).toString();
            try {
                const n = imageSize(fs.readFileSync(file).subarray(0, 64 * 1024));
                if (n && !full.width) {
                    width = Math.min(width, n.w);
                }
            } catch (e) {
                // drawn at the default width
            }
        }
        const md = new vscode.MarkdownString(`![${full.desc || path.basename(targetPath(full.target))}](${src}|width=${width})`);
        return new vscode.Hover(md, range);
    }
}

async function toggle() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'org') {
        return;
    }
    const on = !imagesOn(editor.document);
    toggles[editor.document.uri.toString()] = on;
    await ctx.workspaceState.update(TOGGLES, toggles);
    decorateAll();
    vscode.window.setStatusBarMessage(on ? '$(file-media) Inline images shown' : '$(file-media) Inline images hidden', 2000);
}

export function activateInlineImages(context: vscode.ExtensionContext) {
    ctx = context;
    toggles = Object.assign({}, context.workspaceState.get<{ [file: string]: boolean }>(TOGGLES, {}));
    deco = vscode.window.createTextEditorDecorationType({});
    let pending: NodeJS.Timeout | undefined;
    const soon = (editor?: vscode.TextEditor) => {
        if (pending) {
            clearTimeout(pending);
        }
        pending = setTimeout(() => editor ? decorate(editor) : decorateAll(), 300);
    };
    context.subscriptions.push(
        deco,
        vscode.commands.registerCommand('org.toggleInlineImages', toggle),
        vscode.languages.registerHoverProvider('org', new ImageHover()),
        vscode.window.onDidChangeVisibleTextEditors(() => soon()),
        vscode.workspace.onDidChangeTextDocument(e => {
            const ed = vscode.window.visibleTextEditors.find(v => v.document === e.document);
            if (ed && e.document.languageId === 'org') {
                soon(ed);
            }
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('org.inlineImages') || e.affectsConfiguration('editor.lineHeight') || e.affectsConfiguration('editor.fontSize')) {
                soon();
            }
        }),
    );
    decorateAll();
}
