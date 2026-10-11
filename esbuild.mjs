// Bundles the extension into one minified file, dist/extension.js, which is all
// the packaged .vsix carries of the code. tsc still builds out/ for the tests.
//   node esbuild.mjs               a development build, with a source map
//   node esbuild.mjs --production  minified, no source map (vscode:prepublish)
//   node esbuild.mjs --watch       rebuild on change
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    // vscode is provided by the editor; encoding is node-fetch's optional extra.
    external: ['vscode', 'encoding'],
    alias: { 'whatwg-url': './tools/esbuild/whatwg-url.js' },
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    legalComments: production ? 'none' : 'inline',
    logLevel: 'info',
});

if (watch) {
    await ctx.watch();
} else {
    await ctx.rebuild();
    await ctx.dispose();
}
