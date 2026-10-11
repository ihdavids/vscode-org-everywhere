#!/usr/bin/env node
// Takes the manual's screenshots. It opens VS Code on the demo workspace with
// the plugin under development and a debugging port, lets tools/docs/scenes.js
// set each scene up, and captures the window through the Chrome DevTools
// Protocol - no screen recording permission needed. The pictures are scaled to
// 1600 pixels across with macOS's sips.
//
// With --clips it records the README's animations instead: tools/docs/clips.js
// plays each one while the window is screencast, and ffmpeg and gifski turn
// the frames into a GIF of --width pixels (default 960) across.
//
//   node tools/docs/screenshots.js --demo <dir> --out docs/images --orgs <url> [--vscode <path>] [--scenes a,b]
//   node tools/docs/screenshots.js --clips 1 --demo <dir> --out images/demos --orgs <url> [--scenes a,b]

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const root = path.resolve(__dirname, '../..');
const demo = path.resolve(args.demo);
const outDir = path.resolve(args.out || path.join(root, 'docs/images'));
const vscodePath = args.vscode || process.env.VSCODE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const debugPort = 9300 + Math.floor(Math.random() * 500);
const clips = !!args.clips;
// Clips are shown near their own size in a README, so a smaller window with
// larger text than the manual's screenshots.
const windowSize = clips ? { width: 1200, height: 750 } : { width: 1440, height: 900 };
const gifWidth = Number(args.width || 960);
fs.mkdirSync(outDir, { recursive: true });

// A profile of its own: one theme, no chat panel or minimap, nothing to sign
// in to - the same window every time.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iorg-shots-'));
const extensions = path.join(profile, 'extensions');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.mkdirSync(extensions);
fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.disableAIFeatures': true,
    'workbench.tips.enabled': false,
    'workbench.layoutControl.enabled': false,
    'window.commandCenter': false,
    'window.restoreWindows': 'none',
    'editor.minimap.enabled': false,
    'editor.fontSize': clips ? 15 : 14,
    'editor.lineHeight': clips ? 23 : 22,
    'editor.cursorBlinking': clips ? 'solid' : 'blink',
    'editor.renderWhitespace': 'none',
    'git.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.ignoreRecommendations': true,
    'org.orgsConnection': args.orgs,
}, null, 2));

async function cdp(wsUrl) {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    const listeners = new Map();
    ws.onmessage = m => {
        const d = JSON.parse(m.data);
        if (waiting.has(d.id)) {
            waiting.get(d.id)(d);
            waiting.delete(d.id);
        } else if (d.method && listeners.has(d.method)) {
            listeners.get(d.method)(d.params);
        }
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    return {
        send: (method, params = {}) => new Promise(resolve => {
            const i = ++id;
            waiting.set(i, resolve);
            ws.send(JSON.stringify({ id: i, method, params }));
        }),
        on: (method, fn) => listeners.set(method, fn),
        close: () => ws.close(),
    };
}

async function workbench() {
    for (let t = 0; t < 60; t++) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
            const page = targets.find(x => x.type === 'page' && /workbench/.test(x.url));
            if (page) {
                return page;
            }
        } catch (e) {
            // not up yet
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('VS Code did not come up');
}

let page;
let sized = false;
async function ensureSized() {
    page = page || await workbench();
    if (!sized) {
        // The same window size every time.
        const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
        const browser = await cdp(version.webSocketDebuggerUrl);
        const win = await browser.send('Browser.getWindowForTarget', { targetId: page.id });
        if (win.result) {
            await browser.send('Browser.setWindowBounds', { windowId: win.result.windowId, bounds: { windowState: 'normal' } });
            await browser.send('Browser.setWindowBounds', { windowId: win.result.windowId, bounds: Object.assign({ left: 40, top: 40 }, windowSize) });
        }
        browser.close();
        sized = true;
        await new Promise(r => setTimeout(r, 800));
    }
}

async function capture(name) {
    await ensureSized();
    const conn = await cdp(page.webSocketDebuggerUrl);
    const shot = await conn.send('Page.captureScreenshot', { format: 'png' });
    conn.close();
    const raw = path.join(profile, name + '.png');
    fs.writeFileSync(raw, Buffer.from(shot.result.data, 'base64'));
    const out = path.join(outDir, name + '.png');
    try {
        execFileSync('sips', ['-Z', '1600', raw, '--out', out], { stdio: 'ignore' });
    } catch (e) {
        fs.copyFileSync(raw, out);   // no sips: full size
    }
    console.log('  ' + path.relative(root, out));
}

// A recording: every frame the window paints, with when it was painted. The
// window only paints when something changes, so a frame lasts until the next.
let rec = null;
async function recordStart(name) {
    await ensureSized();
    const conn = await cdp(page.webSocketDebuggerUrl);
    rec = { name, conn, frames: [] };
    conn.on('Page.screencastFrame', p => {
        rec.frames.push({ data: p.data, at: p.metadata.timestamp });
        conn.send('Page.screencastFrameAck', { sessionId: p.sessionId });
    });
    await conn.send('Page.startScreencast', { format: 'png', maxWidth: windowSize.width, maxHeight: windowSize.height, everyNthFrame: 1 });
}

async function recordStop() {
    const { name, conn, frames } = rec;
    rec = null;
    await conn.send('Page.stopScreencast');
    conn.close();
    if (frames.length < 2) {
        throw new Error(`clip ${name}: no frames`);
    }
    const dir = fs.mkdtempSync(path.join(profile, name + '-'));
    const list = [];
    frames.forEach((f, i) => {
        const file = path.join(dir, `in${String(i).padStart(5, '0')}.png`);
        fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
        const next = i + 1 < frames.length ? frames[i + 1].at : f.at + 1.5;   // hold the last frame
        list.push(`file '${file}'`, `duration ${Math.max(0.01, next - f.at).toFixed(3)}`);
    });
    list.push(`file '${path.join(dir, `in${String(frames.length - 1).padStart(5, '0')}.png`)}'`);
    fs.writeFileSync(path.join(dir, 'list.txt'), list.join('\n'));
    // Even frames at 12 a second, scaled down, then gifski's palette per frame.
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
        '-vf', `fps=12,scale=${gifWidth}:-2:flags=lanczos`, path.join(dir, 'out%05d.png')]);
    const pngs = fs.readdirSync(dir).filter(f => /^out\d+\.png$/.test(f)).sort().map(f => path.join(dir, f));
    const out = path.join(outDir, name + '.gif');
    execFileSync('gifski', ['--quiet', '--fps', '12', '--quality', '80', '-o', out, ...pngs]);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  ${path.relative(root, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}

// A key or a word, large at the foot of the window, so a clip shows what was
// pressed. An empty text takes it away.
async function caption(text) {
    await ensureSized();
    const conn = await cdp(page.webSocketDebuggerUrl);
    await conn.send('Runtime.evaluate', { expression: `(() => {
        let el = document.getElementById('demo-caption');
        if (!el) {
            el = document.createElement('div');
            el.id = 'demo-caption';
            el.style.cssText = 'position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:100000;' +
                'padding:8px 18px;border-radius:8px;background:rgba(20,20,20,.88);color:#fff;' +
                'font:600 20px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.45);' +
                'border:1px solid rgba(255,255,255,.18);pointer-events:none;white-space:nowrap';
            document.body.appendChild(el);
        }
        el.textContent = ${JSON.stringify(text)};
        el.style.display = ${JSON.stringify(text)} ? 'block' : 'none';
    })()` });
    conn.close();
}

// Real keys into the window, so a clip goes through the keybindings and the
// pickers as a person's would. press('Tab', 'alt,shift'); type('Inbox', 60).
const KEYS = {
    Tab: 9, Enter: 13, Escape: 27, Backspace: 8, Space: 32, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35,
    F12: 123, Period: 190, Comma: 188, Minus: 189, Equal: 187,
};
const PUNCT = { Period: '.', Comma: ',', Minus: '-', Equal: '=', Space: ' ' };
async function press(key, mods) {
    await ensureSized();
    const m = (mods || '').split(',').filter(x => x);
    const modifiers = (m.includes('alt') ? 1 : 0) | (m.includes('ctrl') ? 2 : 0) | (m.includes('meta') ? 4 : 0) | (m.includes('shift') ? 8 : 0);
    let code, vk, k = key;
    if (/^[a-z]$/i.test(key)) {
        code = 'Key' + key.toUpperCase();
        vk = key.toUpperCase().charCodeAt(0);
    } else if (/^[0-9]$/.test(key)) {
        code = 'Digit' + key;
        vk = key.charCodeAt(0);
    } else {
        code = key;
        vk = KEYS[key];
        k = PUNCT[key] || key;
    }
    const conn = await cdp(page.webSocketDebuggerUrl);
    const base = { modifiers, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await conn.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
    await conn.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    conn.close();
}
async function type(text, delay) {
    await ensureSized();
    const conn = await cdp(page.webSocketDebuggerUrl);
    for (const ch of text) {
        await conn.send('Input.insertText', { text: ch });
        await new Promise(r => setTimeout(r, delay));
    }
    conn.close();
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const handlers = {
        '/press': () => press(url.searchParams.get('key'), url.searchParams.get('mods')),
        '/type': () => type(url.searchParams.get('text') || '', Number(url.searchParams.get('delay') || 55)),
        '/rec/start': () => recordStart(url.searchParams.get('name')),
        '/rec/stop': () => recordStop(),
        '/caption': () => caption(url.searchParams.get('text') || ''),
    };
    if (handlers[url.pathname]) {
        try {
            await handlers[url.pathname]();
            res.end('ok');
        } catch (e) {
            res.statusCode = 500;
            res.end(e.message);
        }
        return;
    }
    if (url.pathname === '/shot') {
        try {
            await capture(url.searchParams.get('name'));
            res.end('ok');
        } catch (e) {
            res.statusCode = 500;
            res.end(e.message);
        }
        return;
    }
    res.statusCode = 404;
    res.end();
});

server.listen(0, '127.0.0.1', () => {
    const shotPort = server.address().port;
    console.log(`${clips ? 'Recording clips' : 'Taking screenshots'} of ${path.relative(root, demo) || demo}:`);
    const code = spawn(vscodePath, [
        demo,
        `--extensionDevelopmentPath=${root}`,
        `--extensionTestsPath=${path.join(__dirname, clips ? 'clips.js' : 'scenes.js')}`,
        `--user-data-dir=${profile}`,
        `--extensions-dir=${extensions}`,
        `--remote-debugging-port=${debugPort}`,
        '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    ], { env: Object.assign({}, process.env, { SHOT_PORT: String(shotPort), DEMO_DIR: demo, SCENES: args.scenes || '' }), stdio: ['ignore', 'pipe', 'pipe'] });
    code.stderr.on('data', d => /(scene|clip) .* failed/.test(String(d)) && process.stderr.write(d));
    code.stdout.on('data', d => /(scene|clip) .* failed/.test(String(d)) && process.stderr.write(d));
    code.on('exit', () => {
        server.close();
        fs.rmSync(profile, { recursive: true, force: true });
    });
});
