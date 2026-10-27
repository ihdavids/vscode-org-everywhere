// Dictation's model, ported from worg's src/dictation.ts (server POST
// /voice/dictate in internal/app/orgs/voice.go), and the recorder command
// lines. No vscode here: tested by test/dictation.test.ts.
//
// A webview cannot reach the microphone, so a take is recorded by an outside
// program (sox, ffmpeg or arecord) into a 16 kHz mono wav - what whisper
// works in - and sent whole when the writer stops. Its text then has
// whisper's habits taken off (cleanTranscript), is checked for a spoken
// command (commandOf), and is joined to the text before the cursor
// (joinText) - spaces and capitals are about the join, which whisper cannot
// see.

// What whisper writes for no words at all - silence, breath, the room -
// and whole clips that are only a sign-off it learnt from subtitles.
const NOISE = /\[(?:blank_audio|music|silence|noise|inaudible|no speech|sound|applause|laughter)[^\]]*\]|\((?:silence|music|inaudible|noise|sighs?|coughs?|laughs?|breathing|background noise)[^)]*\)|\*(?:sighs?|coughs?|laughs?|breathes?)\*/gi;
const PHANTOMS = new Set([
    'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!', 'thank you for watching',
    'thank you for watching.', 'you', 'bye', 'bye.', '.', 'subtitles by the amara.org community',
]);

export function cleanTranscript(text: string): string {
    const t = (text || '').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    if (PHANTOMS.has(t.toLowerCase())) return '';
    // A clip that is only punctuation is nothing.
    if (!/[\p{L}\p{N}]/u.test(t)) return '';
    return t;
}

export type Command = 'paragraph' | 'line' | 'scratch' | 'stop';

// A take that is only a command, said alone: "new paragraph", "new line",
// "scratch that", "stop dictating". Mid-sentence, the words are just words.
export function commandOf(text: string): Command | null {
    const t = (text || '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    switch (t) {
        case 'new paragraph': case 'next paragraph':
            return 'paragraph';
        case 'new line': case 'next line': case 'newline':
            return 'line';
        case 'scratch that': case 'delete that': case 'undo that':
            return 'scratch';
        case 'stop dictating': case 'stop dictation': case 'end dictation':
            return 'stop';
    }
    return null;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*\s*$/;
const NO_SPACE_BEFORE = /^[,.;:!?…)\]}”’'%]/;

// What goes in at the cursor for a take: a space before it unless the cursor
// is at the start of a line or after a space (or the take begins with
// punctuation), and a capital at the start of a sentence. Mid-sentence the
// take's own capital is left alone: whisper starts every clip as a sentence,
// but a name is a name.
export function joinText(before: string, text: string): string {
    let t = text.trim();
    if (!t) return '';
    const atStart = before === '' || /\n\s*$/.test(before) || /^\s*$/.test(before);
    const startsSentence = atStart || SENTENCE_END.test(before);
    if (startsSentence) t = t.charAt(0).toUpperCase() + t.slice(1);
    const space = !atStart && !/\s$/.test(before) && !NO_SPACE_BEFORE.test(t);
    return (space ? ' ' : '') + t;
}

// The text before the cursor, as whisper's prompt: the last few sentences of
// this heading, so it keeps the spelling of names and the punctuation style.
export function promptOf(before: string, max = 400): string {
    let t = before;
    const heading = t.search(/\n\*+ [^\n]*\n(?![\s\S]*\n\*+ )/);
    if (heading >= 0) t = t.slice(heading);
    t = t.replace(/^\s*:[A-Z_]+:.*$/gm, '').replace(/^\*+ /gm, '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    t = t.slice(t.length - max);
    const sp = t.indexOf(' ');
    return sp >= 0 ? t.slice(sp + 1) : t;
}

// What a transcript does at the cursor: text to insert, or a command.
export type Dictated = { insert: string } | { command: Command } | { nothing: true };

export function dictated(before: string, transcript: string): Dictated {
    const t = cleanTranscript(transcript);
    if (!t) return { nothing: true };
    const c = commandOf(t);
    if (c === 'paragraph') return { insert: '\n\n' };
    if (c === 'line') return { insert: '\n' };
    if (c) return { command: c };
    return { insert: joinText(before, t) };
}

// ---------------------------------------------------------------------------
// Recorders
// ---------------------------------------------------------------------------

export type Recorder = { name: string; cmd: string; args: string[] };

// The programs tried, in order, by the name to look for on the PATH.
export const RECORDERS = ['rec', 'sox', 'ffmpeg', 'arecord'];

// The command line that records the default microphone to `out` as 16 kHz
// mono 16 bit wav, for a program found on the PATH. Undefined when that
// program cannot record on this platform.
export function recorderFor(name: string, platform: string, out: string): Recorder | undefined {
    const wav = ['-r', '16000', '-c', '1', '-b', '16'];
    switch (name) {
        case 'rec':
            return { name, cmd: 'rec', args: ['-q', ...wav, out] };
        case 'sox':
            // -d is the default audio device; on windows sox wants -t waveaudio.
            return platform === 'win32'
                ? { name, cmd: 'sox', args: ['-q', '-t', 'waveaudio', '-d', ...wav, out] }
                : { name, cmd: 'sox', args: ['-q', '-d', ...wav, out] };
        case 'ffmpeg': {
            const input = platform === 'darwin' ? ['-f', 'avfoundation', '-i', ':0']
                : platform === 'win32' ? ['-f', 'dshow', '-i', 'audio=default']
                    : ['-f', 'pulse', '-i', 'default'];
            return { name, cmd: 'ffmpeg', args: ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', out] };
        }
        case 'arecord':
            return platform === 'linux' ? { name, cmd: 'arecord', args: ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', out] } : undefined;
    }
    return undefined;
}

// The first recorder this platform can use among the programs found.
export function pickRecorder(found: string[], platform: string, out: string): Recorder | undefined {
    for (const n of RECORDERS) {
        if (found.includes(n)) {
            const r = recorderFor(n, platform, out);
            if (r) return r;
        }
    }
    return undefined;
}

// A command line from the org.dictationRecorder setting: words split on
// spaces, quotes keep spaces in, and {out} is the wav to write (added at the
// end when the line does not say where).
export function parseRecorder(line: string, out: string): Recorder | undefined {
    const words: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    for (let m = re.exec(line); m; m = re.exec(line)) words.push(m[1] ?? m[2] ?? m[3]);
    if (!words.length) return undefined;
    let placed = false;
    const args = words.slice(1).map(w => {
        if (!w.includes('{out}')) return w;
        placed = true;
        return w.split('{out}').join(out);
    });
    if (!placed) args.push(out);
    return { name: words[0].split(/[\\/]/).pop() || words[0], cmd: words[0], args };
}

// A transcription's failure in words for the user.
export function dictateError(status: number | undefined, msg: string | undefined): string {
    const m = (msg || '').trim();
    if (status === 404) return 'This orgs server has no dictation (POST /voice/dictate): update orgs.';
    if (status === 502 || /whisper/i.test(m)) return `Transcription failed: ${m || 'the whisper server did not answer'}. Dictation needs a whisper server set up in orgs.yaml (voice:).`;
    return `Transcription failed: ${m || 'no answer from the server'}`;
}
