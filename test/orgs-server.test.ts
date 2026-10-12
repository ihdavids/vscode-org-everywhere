// Installing a local orgs server: the model half, no vscode.
//   mocha --ui tdd out/test/orgs-server.test.js
import * as assert from 'assert';
import { assetName, binaryName, parseChecksums, isNewer, orgsYaml, configPort, docsForWebview, ORGS_DOCS_DIR } from '../src/orgs-server-model';

suite('orgs server install', () => {
    test('names the release archive for this machine', () => {
        assert.equal(assetName('v0.1.0', 'darwin', 'arm64'), 'orgs_0.1.0_darwin_arm64.tar.gz');
        assert.equal(assetName('v0.1.0', 'linux', 'x64'), 'orgs_0.1.0_linux_amd64.tar.gz');
        assert.equal(assetName('v1.2.3', 'win32', 'x64'), 'orgs_1.2.3_windows_amd64.zip');
        assert.equal(assetName('v0.1.0', 'freebsd', 'x64'), undefined);
        assert.equal(assetName('v0.1.0', 'linux', 'ia32'), undefined);
        assert.equal(binaryName('win32'), 'orgs.exe');
        assert.equal(binaryName('linux'), 'orgs');
    });
    test('reads checksums.txt', () => {
        const sums = parseChecksums(
            'B521A08FF465C143274B080B61B5F8594E235859B059E08435421E2236FF23D8  orgs_0.1.0_darwin_arm64.tar.gz\n' +
            'c26124bd0a7c693c8b107db0f46c3912e1b6c6543b24acb7c97e8002fe5ffb1b *orgs_0.1.0_linux_amd64.tar.gz\r\n' +
            'junk\n');
        assert.equal(sums.size, 2);
        assert.equal(sums.get('orgs_0.1.0_darwin_arm64.tar.gz'), 'b521a08ff465c143274b080b61b5f8594e235859b059e08435421e2236ff23d8');
        assert.ok(sums.has('orgs_0.1.0_linux_amd64.tar.gz'));
    });
    test('orders versions', () => {
        assert.ok(isNewer('v0.2.0', 'v0.1.9'));
        assert.ok(isNewer('v1.0.0', '0.9.9'));
        assert.ok(isNewer('v0.1.10', 'v0.1.9'));
        assert.ok(!isNewer('v0.1.0', 'v0.1.0'));
        assert.ok(!isNewer('v0.1.0', 'v0.2.0'));
        assert.ok(isNewer('v0.1.0', undefined));
        assert.ok(!isNewer('nightly', 'v0.1.0'));
    });
    test('writes a config it can read the port back out of', () => {
        const yaml = orgsYaml({
            port: 8012, orgDirs: ['/home/me/notes', 'C:\\Users\\me\\org'], keystore: '/x/keystore.yaml',
            salt: 's', jws: 'a+b/c=', jwe: 'd', dayPagePath: '/home/me/notes/daypages',
        });
        assert.ok(yaml.includes('url: "http://localhost:8012"'));
        assert.ok(yaml.includes('    - "C:\\\\Users\\\\me\\\\org"'));
        assert.ok(yaml.includes('  allowHttps: false'));
        assert.equal(configPort(yaml), 8012);
    });
    test('finds server.port and nothing else', () => {
        assert.equal(configPort('server:\n  orgDirs:\n    - x\n  port: 9000 # mine\n'), 9000);
        // voice.port is a different port.
        assert.equal(configPort('server:\n  voice:\n    port: 8081\n  port: "8020"\n'), 8020);
        assert.equal(configPort('port: 1\nserver:\n  orgDirs: []\n'), undefined);
        assert.equal(configPort('server:\n  orgDirs: []\nother:\n  port: 3\n'), undefined);
    });
    test('makes docs.html fit for a webview', () => {
        const page = '<html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/x"></head>' +
            '<body><a href="#intro">In</a><img src="images/cli-agenda.png"><a href=\'images/big.png\'>b</a>' +
            '<a href="https://github.com">gh</a><a href="mailto:me@x">m</a></body></html>';
        const out = docsForWebview(page, true);
        assert.ok(out.includes(`src="${ORGS_DOCS_DIR}images/cli-agenda.png"`));
        assert.ok(out.includes(`href='${ORGS_DOCS_DIR}images/big.png'`));
        assert.ok(out.includes('href="#intro"'), 'anchors stay in the page');
        assert.ok(out.includes('href="https://github.com"') && out.includes('href="mailto:me@x"'));
        assert.ok(out.includes('href="https://fonts.googleapis.com/x"'));
        // The policy and the theme go first in <head>, before any script of the page's.
        assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<meta charset'));
        assert.ok(out.includes('var dark = true'));
        assert.ok(docsForWebview(page, false).includes('var dark = false'));
    });
});
