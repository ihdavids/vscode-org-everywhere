// The parts of installing and running a local orgs server that need no
// vscode: which release archive fits this machine, the checksums file, version
// order, and the orgs.yaml written for it. Unit tested (test/orgs-server.test.ts).

import * as crypto from 'crypto';

export const ORGS_REPO = 'ihdavids/orgs';
// The account the plugin makes in the keystore and logs in with.
export const ORGS_USER = 'vscode';

// goreleaser's name for the archive (.goreleaser.yaml in orgs):
// orgs_0.1.0_darwin_arm64.tar.gz, orgs_0.1.0_windows_amd64.zip. Undefined for
// a machine there is no build for.
export function assetName(tag: string, platform: string, arch: string): string | undefined {
    const os = ({ darwin: 'darwin', linux: 'linux', win32: 'windows' } as {[k: string]: string})[platform];
    const cpu = ({ x64: 'amd64', arm64: 'arm64' } as {[k: string]: string})[arch];
    if (!os || !cpu) {
        return undefined;
    }
    return `orgs_${tag.replace(/^v/, '')}_${os}_${cpu}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
}

export function binaryName(platform: string): string {
    return platform === 'win32' ? 'orgs.exe' : 'orgs';
}

// checksums.txt: "<sha256>  <file name>" a line.
export function parseChecksums(text: string): Map<string, string> {
    const sums = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
        if (m) {
            sums.set(m[2], m[1].toLowerCase());
        }
    }
    return sums;
}

function versionParts(v: string): number[] | undefined {
    const m = (v || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : undefined;
}

// Whether release tag a is newer than b. Something that is not a version is
// never newer, and anything is newer than nothing installed.
export function isNewer(a: string, b: string | undefined): boolean {
    const pa = versionParts(a);
    if (!pa) {
        return false;
    }
    const pb = versionParts(b || '');
    if (!pb) {
        return true;
    }
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) {
            return pa[i] > pb[i];
        }
    }
    return false;
}

export interface OrgsConfig {
    port: number;
    orgDirs: string[];
    keystore: string;
    // Random, made once: the salt the keystore hashes with, and the token keys,
    // which orgs would otherwise make afresh on every start and so throw away
    // every login with each restart.
    salt: string;
    jws: string;
    jwe: string;
    dayPagePath: string;
    // The certificate and key (orgs cert) to serve https only with. Without
    // them the server is http - for an orgs too old to make a certificate.
    tls?: Tls;
}

export interface Tls {
    crt: string;
    key: string;
}

// A yaml double-quoted string is a json string.
const q = (s: string) => JSON.stringify(s);

// The server: block's settings for https and nothing else on port, answering
// this machine only.
function httpsSettings(port: number, tls: Tls): [string, string][] {
    return [
        ['port', String(port)],
        ['tlsport', String(port)],
        ['allowHttps', 'true'],
        ['httpsOnly', 'true'],
        ['localhostOnly', 'true'],
        ['servercrt', q(tls.crt)],
        ['serverkey', q(tls.key)],
    ];
}

// The orgs.yaml for a server that only this machine's user talks to: https
// only, with a self-signed certificate, on the loopback, logins against its
// own keystore, babel off.
export function orgsYaml(c: OrgsConfig): string {
    const listen = c.tls
        ? httpsSettings(c.port, c.tls).map(([k, v]) => `  ${k}: ${v}`)
        : [`  port: ${c.port}`, '  allowHttps: false', '  localhostOnly: true'];
    return [
        '# Written by Org Everywhere (Org: Set Up a Local orgs Server), and yours to edit.',
        '# Saving it from VS Code reloads the server; a change to the port, orgDirs or',
        '# the keystore needs Org: Restart orgs Server. Every setting is described at',
        `# https://github.com/${ORGS_REPO}`,
        '',
        '# Where the orgs command line finds the server.',
        `url: ${q(`${c.tls ? 'https' : 'http'}://localhost:${c.port}`)}`,
        'server:',
        ...listen,
        `  keystore: ${q(c.keystore)}`,
        `  orgSalt: ${q(c.salt)}`,
        `  orgJWS: ${q(c.jws)}`,
        `  orgJWE: ${q(c.jwe)}`,
        '  orgDirs:',
        ...c.orgDirs.map(d => `    - ${q(d)}`),
        `  dayPagePath: ${q(c.dayPagePath)}`,
        '',
    ].join('\n');
}

// An existing orgs.yaml switched to https only (the settings orgsYaml writes
// for it), keeping everything else in it as it was.
export function withHttps(yaml: string, port: number, tls: Tls): string {
    const lines = yaml.split(/\r?\n/);
    const url = `url: ${q(`https://localhost:${port}`)}`;
    const urlAt = lines.findIndex(l => /^url:/.test(l));
    if (urlAt >= 0) {
        lines[urlAt] = url;
    } else {
        lines.unshift(url);
    }
    let serverAt = lines.findIndex(l => /^server:\s*(#.*)?$/.test(l));
    if (serverAt < 0) {
        lines.push('server:');
        serverAt = lines.length - 1;
    }
    const block = serverBlock(lines, serverAt);
    let added = 0;
    for (const [key, value] of httpsSettings(port, tls)) {
        const at = block.children.find(i => new RegExp(`^\\s*${key}:`).test(lines[i]));
        const line = ' '.repeat(block.indent) + `${key}: ${value}`;
        if (at !== undefined) {
            lines[at] = line;
        } else {
            // In order, at the top of server:, ahead of what was there.
            lines.splice(serverAt + 1 + added++, 0, line);
            block.children = block.children.map(i => i + 1);
        }
    }
    return lines.join('\n');
}

// The lines that are direct settings of the server: block starting at
// serverAt, and how far they are indented.
function serverBlock(lines: string[], serverAt: number): { indent: number, children: number[] } {
    let indent = -1;
    const children: number[] = [];
    for (let i = serverAt + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(#|$)/.test(line)) {
            continue;
        }
        const lead = line.match(/^\s*/)[0].length;
        if (lead === 0) {
            break;
        }
        if (indent < 0) {
            indent = lead;
        }
        if (lead === indent) {
            children.push(i);
        }
    }
    return { indent: indent < 0 ? 2 : indent, children };
}

// A setting directly under server: in an orgs.yaml, unquoted, or undefined.
// Line-based, which is enough for the file orgsYaml writes and most anything
// somebody edits it into.
export function serverValue(yaml: string, key: string): string | undefined {
    const lines = yaml.split(/\r?\n/);
    const serverAt = lines.findIndex(l => /^server:\s*(#.*)?$/.test(l));
    if (serverAt < 0) {
        return undefined;
    }
    for (const i of serverBlock(lines, serverAt).children) {
        const m = lines[i].match(new RegExp(`^\\s*${key}:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|([^#]*?))\\s*(#.*)?$`));
        if (m) {
            return m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] !== undefined ? m[2] : m[3];
        }
    }
    return undefined;
}

// server.port out of an orgs.yaml.
export function configPort(yaml: string): number | undefined {
    const v = serverValue(yaml, 'port');
    return v && /^\d+$/.test(v) ? +v : undefined;
}

// How and where the server this orgs.yaml describes answers: https on its
// tlsport when it serves nothing else, http on its port otherwise.
export function configListen(yaml: string): { scheme: 'http' | 'https', port: number | undefined } {
    if (serverValue(yaml, 'httpsOnly') === 'true') {
        const v = serverValue(yaml, 'tlsport');
        return { scheme: 'https', port: v && /^\d+$/.test(v) ? +v : 443 };
    }
    return { scheme: 'http', port: configPort(yaml) };
}

// Whether url is this machine on port, by scheme (http unless said).
export function isLocalUrl(url: string, port: number, scheme: 'http' | 'https' = 'http'): boolean {
    const m = (url || '').trim().match(/^(https?):\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\]):(\d+)\/*$/i);
    return !!m && m[1].toLowerCase() === scheme && +m[3] === port;
}

// The orgs manual: docs/docs.html on main, one page built by orgs' docex.
export const ORGS_DOCS_DIR = `https://raw.githubusercontent.com/${ORGS_REPO}/main/docs/`;
export const ORGS_DOCS_URL = ORGS_DOCS_DIR + 'docs.html';

// docs.html made fit for a webview. Its pictures are relative (images/...),
// so they are pointed at github - a <base> would do it too, but would send
// every #anchor in the contents off to github as well. A content security
// policy lets in what it loads: highlight.js, mermaid and the fonts. And it
// follows VS Code's theme: the page goes by prefers-color-scheme, which in a
// webview is the OS's, unless the reader has picked one with its switch.
export function docsForWebview(html: string, dark: boolean): string {
    const csp = [
        "default-src 'none'",
        'img-src https: data:',
        "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com data:',
        "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
        'connect-src https://cdn.jsdelivr.net',
    ].join('; ');
    const theme = `<script>(function () {
  var dark = ${dark}, chosen = null;
  try { chosen = localStorage.getItem('docsTheme'); } catch (e) { /* none */ }
  if (chosen) return;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  var mm = window.matchMedia && window.matchMedia.bind(window);
  window.matchMedia = function (q) {
    if (!/prefers-color-scheme/.test(q) || !mm) return mm(q);
    var matches = /dark/.test(q) === dark;
    return { matches: matches, media: q, onchange: null,
      addListener: function () {}, removeListener: function () {},
      addEventListener: function () {}, removeEventListener: function () {},
      dispatchEvent: function () { return false; } };
  };
})();</script>`;
    const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n${theme}\n`;
    const out = html.replace(/((?:src|href)=["'])(?![a-z][a-z0-9+.-]*:|#|\/)([^"']+)/gi, (_m, attr, rel) => attr + ORGS_DOCS_DIR + rel);
    return /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, m => m + '\n' + head) : head + out;
}

// What a client sends in place of a password: a hash of it under the user's
// salt. orgs' common.ClientHash and worg's clienthash.ts again - the prefix,
// separators and order must match both exactly (the same vector pins all three).
export function clientHash(username: string, salt: string, password: string): string {
    return 'sha256c:' + crypto.createHash('sha256')
        .update('orgs-client-v1:' + username + ':' + salt + ':' + password, 'utf8')
        .digest('hex');
}

// A fresh salt for a new user, as orgs' common.NewSalt makes one.
export function newSalt(): string {
    return crypto.randomBytes(16).toString('hex');
}

// Why orgs would refuse this as a user name (common.ValidUsername), or
// undefined when it would not.
export function usernameProblem(name: string): string | undefined {
    if (!name) {
        return 'A user needs a name';
    }
    if (name.length > 64) {
        return 'That name is longer than 64 characters';
    }
    if (/\s/.test(name)) {
        return 'A user name cannot have whitespace in it';
    }
    if (/[:/?#[\]@]/.test(name)) {
        return 'A user name cannot contain any of  : / ? # [ ] @';
    }
    return undefined;
}
