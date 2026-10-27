// The inline images model. No vscode: mocha --ui tdd out/test/inline-images.test.js
import * as assert from 'assert';
import {
    imageLinks, isImageTarget, isRemote, parseWidth, widthAbove, startupImages, fileOn, pixelWidth,
    attachProps, attachIdPath, attachName, imageSize, thumbSize, sizedSvg, targetPath,
} from '../src/inline-images-model';

suite('Inline images', () => {
    test('which targets are pictures', () => {
        assert.ok(isImageTarget('file:x.png'));
        assert.ok(isImageTarget('./a/b.JPG'));
        assert.ok(isImageTarget('https://e.com/x.webp?s=1'));
        assert.ok(isImageTarget('attachment:shot.png'));
        assert.ok(isImageTarget('data:image/png;base64,AAA'));
        assert.ok(!isImageTarget('id:1234.png'));
        assert.ok(!isImageTarget('file:notes.org'));
        assert.ok(!isImageTarget('file:x.png.org'));
        assert.ok(isRemote('https://e.com/x.png'));
        assert.ok(!isRemote('file:x.png'));
        assert.strictEqual(targetPath('file:a/b.png::x'), 'a/b.png');
    });

    test('picture links in a file, not in blocks or keywords', () => {
        const lines = [
            '#+STARTUP: inlineimages',
            '* H',
            '#+ATTR_ORG: :width 300',
            '#+CAPTION: hi',
            'see [[file:a.png]] and [[./b.jpg][a caption]] and file:c.gif',
            '[[file:big.png][file:thumb.png]]',
            '#+begin_src org',
            '[[file:no.png]]',
            '#+end_src',
            '[[notes.org][x]] [[id:abc]]',
        ];
        const refs = imageLinks(lines);
        assert.deepStrictEqual(refs.map(r => r.target), ['file:a.png', './b.jpg', 'file:c.gif', 'file:thumb.png']);
        assert.deepStrictEqual(refs[0].width, { px: 300 });
        assert.strictEqual(refs[1].desc, 'a caption');
        assert.strictEqual(refs[3].width, null);
        assert.strictEqual(refs[0].from, 4);
        assert.strictEqual(lines[4].slice(refs[0].from, refs[0].to), '[[file:a.png]]');
    });

    test('widths', () => {
        assert.deepStrictEqual(parseWidth(':width 50%'), { pct: 50 });
        assert.deepStrictEqual(parseWidth(':width 0.5'), { pct: 50 });
        assert.deepStrictEqual(parseWidth(':float t :width "200px"'), { px: 200 });
        assert.strictEqual(parseWidth(':height 20'), null);
        assert.deepStrictEqual(widthAbove(['#+ATTR_HTML: :width 100', '#+ATTR_ORG: :width 40', 'x'], 2), { px: 40 });
        assert.deepStrictEqual(widthAbove(['#+ATTR_HTML: :width 100', 'x'], 1), { px: 100 });
        assert.strictEqual(widthAbove(['#+ATTR_ORG: :width 40', 'text', 'x'], 2), null);
        assert.strictEqual(pixelWidth({ pct: 50 }, 600, 360), 300);
        assert.strictEqual(pixelWidth(null, 600, 360), 360);
    });

    test('startup and the toggle', () => {
        assert.strictEqual(startupImages(['#+STARTUP: overview noinlineimages']), false);
        assert.strictEqual(startupImages(['#+startup: inlineimages']), true);
        assert.strictEqual(startupImages(['* H', '#+STARTUP: inlineimages']), null);
        assert.strictEqual(fileOn(null, ['#+STARTUP: noinlineimages'], true), false);
        assert.strictEqual(fileOn(null, ['#+STARTUP: inlineimages'], false), true);
        assert.strictEqual(fileOn(null, [], false), false);
        assert.strictEqual(fileOn(true, ['#+STARTUP: noinlineimages'], false), true);
    });

    test('attachments', () => {
        const lines = [
            '* A',
            'SCHEDULED: <2026-01-01 Thu>',
            ':PROPERTIES:',
            ':ID:       8f3c1a20-1',
            ':END:',
            '[[attachment:x.png]]',
            '* B',
            ':PROPERTIES:',
            ':DIR: pics',
            ':ID: abc',
            ':END:',
            'text',
        ];
        assert.deepStrictEqual(attachProps(lines, 5), { dir: '', id: '8f3c1a20-1' });
        assert.deepStrictEqual(attachProps(lines, 11), { dir: 'pics', id: 'abc' });
        assert.strictEqual(attachIdPath('8f3c1a20-1'), '8f/3c1a20-1');
        assert.strictEqual(attachName('attachment:sub/x.png'), 'sub/x.png');
        assert.strictEqual(attachName('attachment:../x.png'), '');
    });

    test('picture sizes', () => {
        const png = new Uint8Array(24);
        png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        png.set([0, 0, 1, 0], 16);   // 256 wide
        png.set([0, 0, 0, 128], 20); // 128 high
        assert.deepStrictEqual(imageSize(png), { w: 256, h: 128 });
        const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0]);
        assert.deepStrictEqual(imageSize(gif), { w: 10, h: 20 });
        const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 50, 0, 100, 3, 0, 0]);
        assert.deepStrictEqual(imageSize(jpg), { w: 100, h: 50 });
        const svg = new Uint8Array(Buffer.from('<?xml version="1.0"?><svg viewBox="0 0 40 30">'));
        assert.deepStrictEqual(imageSize(svg), { w: 40, h: 30 });
        assert.strictEqual(imageSize(new Uint8Array([1, 2, 3])), null);
        assert.deepStrictEqual(thumbSize({ w: 256, h: 128 }, 20, 1000), { w: 40, h: 20 });
        assert.deepStrictEqual(thumbSize({ w: 256, h: 128 }, 20, 20), { w: 20, h: 10 });
        assert.deepStrictEqual(thumbSize(null, 18, 100), { w: 18, h: 18 });
        assert.ok(sizedSvg('data:image/png;base64,AA', 40, 20).indexOf('width="40" height="20"') > 0);
    });
});
