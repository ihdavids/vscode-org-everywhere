// The parts of installing and running a local orgs server that need no
// vscode: which release archive fits this machine, the checksums file, version
// order, and the orgs.yaml written for it. Unit tested (test/orgs-server.test.ts).

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
}

// A yaml double-quoted string is a json string.
const q = (s: string) => JSON.stringify(s);

// The orgs.yaml for a server that only this machine's user talks to: http on
// one port, logins against its own keystore (orgs listens on every interface,
// so a server with noAuth would be anybody's on the network), babel off.
export function orgsYaml(c: OrgsConfig): string {
    return [
        '# Written by Org Everywhere (Org: Set Up a Local orgs Server), and yours to edit.',
        '# Saving it from VS Code reloads the server; a change to the port, orgDirs or',
        '# the keystore needs Org: Restart orgs Server. Every setting is described at',
        `# https://github.com/${ORGS_REPO}`,
        '',
        '# Where the orgs command line finds the server.',
        `url: ${q(`http://localhost:${c.port}`)}`,
        'server:',
        `  port: ${c.port}`,
        '  allowHttps: false',
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

// server.port out of an orgs.yaml: the plugin starts the server on it and
// connects to it. Line-based, which is enough for the file orgsYaml writes and
// most anything somebody edits it into.
export function configPort(yaml: string): number | undefined {
    let inServer = false;
    let indent = -1;
    for (const line of yaml.split(/\r?\n/)) {
        if (/^\s*(#|$)/.test(line)) {
            continue;
        }
        const lead = line.match(/^\s*/)[0].length;
        if (lead === 0) {
            inServer = /^server:\s*(#.*)?$/.test(line);
            indent = -1;
            continue;
        }
        if (!inServer) {
            continue;
        }
        if (indent < 0) {
            indent = lead;
        }
        const m = line.match(/^\s*port:\s*["']?(\d+)["']?\s*(#.*)?$/);
        if (lead === indent && m) {
            return +m[1];
        }
    }
    return undefined;
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
