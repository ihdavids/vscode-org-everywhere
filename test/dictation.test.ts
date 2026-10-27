// Dictation's model (src/dictation-model.ts), after worg's dictation.test.ts.
// No vscode: mocha --ui tdd out/test/dictation.test.js
import * as assert from 'assert';
import {
    cleanTranscript, commandOf, joinText, promptOf, dictated, recorderFor, pickRecorder, parseRecorder, dictateError,
} from '../src/dictation-model';

suite('Dictation', () => {
    test('whisper’s noises and phantom sign-offs go', () => {
        assert.strictEqual(cleanTranscript('[BLANK_AUDIO]'), '');
        assert.strictEqual(cleanTranscript(' Thank you. '), '');
        assert.strictEqual(cleanTranscript('(sighs) She turned away.'), 'She turned away.');
        assert.strictEqual(cleanTranscript('...'), '');
        assert.strictEqual(cleanTranscript('Thank you for the tea, she said.'), 'Thank you for the tea, she said.');
    });

    test('commands only when said alone', () => {
        assert.strictEqual(commandOf('New paragraph.'), 'paragraph');
        assert.strictEqual(commandOf(' new line '), 'line');
        assert.strictEqual(commandOf('Scratch that!'), 'scratch');
        assert.strictEqual(commandOf('Stop dictating.'), 'stop');
        assert.strictEqual(commandOf('She started a new paragraph of her life.'), null);
    });

    test('takes join the text with the right space and capital', () => {
        assert.strictEqual(joinText('', 'the keeper climbed.'), 'The keeper climbed.');
        assert.strictEqual(joinText('He was tired.', 'the lamp was out.'), ' The lamp was out.');
        assert.strictEqual(joinText('He was tired and', 'Mara waited.'), ' Mara waited.');
        assert.strictEqual(joinText('He was tired and ', 'old.'), 'old.');
        assert.strictEqual(joinText('He was tired', ', very tired.'), ', very tired.');
        assert.strictEqual(joinText('* Chapter One\n', 'morning came.'), 'Morning came.');
        assert.strictEqual(joinText('“Wait,” she said. ', 'he did not.'), 'He did not.');
    });

    test('the prompt is the end of this heading’s text, without its drawer', () => {
        const before = '* One\nOld text.\n* Two\n:PROPERTIES:\n:POV: Mara\n:END:\nMara waited by the door.';
        assert.strictEqual(promptOf(before), 'Two Mara waited by the door.');
        assert.ok(promptOf('a '.repeat(500) + 'end.', 20).length <= 20);
    });

    test('a transcript becomes text, a command or nothing', () => {
        assert.deepStrictEqual(dictated('He was tired.', 'the lamp was out.'), { insert: ' The lamp was out.' });
        assert.deepStrictEqual(dictated('x', 'New paragraph.'), { insert: '\n\n' });
        assert.deepStrictEqual(dictated('x', 'Scratch that.'), { command: 'scratch' });
        assert.deepStrictEqual(dictated('x', '[BLANK_AUDIO]'), { nothing: true });
    });

    test('recorders write 16 kHz mono wav on each platform', () => {
        assert.deepStrictEqual(recorderFor('sox', 'darwin', '/t/a.wav').args, ['-q', '-d', '-r', '16000', '-c', '1', '-b', '16', '/t/a.wav']);
        assert.deepStrictEqual(recorderFor('ffmpeg', 'darwin', 'o.wav').args.slice(4, 8), ['-f', 'avfoundation', '-i', ':0']);
        assert.ok(recorderFor('ffmpeg', 'linux', 'o.wav').args.includes('pulse'));
        assert.ok(recorderFor('ffmpeg', 'win32', 'o.wav').args.includes('dshow'));
        assert.strictEqual(recorderFor('arecord', 'darwin', 'o.wav'), undefined);
        assert.strictEqual(pickRecorder(['arecord', 'ffmpeg'], 'linux', 'o.wav').name, 'ffmpeg');
        assert.strictEqual(pickRecorder(['arecord'], 'darwin', 'o.wav'), undefined);
        assert.strictEqual(pickRecorder([], 'linux', 'o.wav'), undefined);
    });

    test('a recorder from the setting', () => {
        assert.deepStrictEqual(parseRecorder('rec -q {out} trim 0 60', '/t/a.wav'), { name: 'rec', cmd: 'rec', args: ['-q', '/t/a.wav', 'trim', '0', '60'] });
        assert.deepStrictEqual(parseRecorder('"/opt/my rec/rec" -c 1', 'o.wav'), { name: 'rec', cmd: '/opt/my rec/rec', args: ['-c', '1', 'o.wav'] });
        assert.strictEqual(parseRecorder('  ', 'o.wav'), undefined);
    });

    test('failures say what to do', () => {
        assert.match(dictateError(502, 'no answer from the whisper server at http://x'), /voice:/);
        assert.match(dictateError(404, ''), /update orgs/);
    });
});
