// Build step: split the hand-edited os.html into three served files
//   dist/index.html  — minimal markup (what "View Source" shows)
//   dist/styles.css  — extracted + lightly minified CSS
//   dist/app.js      — extracted + OBFUSCATED JS
// os.html stays the single source of truth (edit it as before); this only produces
// what gets served. Obfuscation keeps global function names (renameGlobals:false) so
// the inline onclick="..." handlers keep working — only internals get scrambled.
// Never throws: on any failure it leaves dist/ as-is so the server can fall back to os.html.
const fs = require('fs');
const path = require('path');

try {
  const root = __dirname;
  const src = fs.readFileSync(path.join(root, 'os.html'), 'utf8');

  const styleStart = src.indexOf('<style>');
  const styleEnd = src.indexOf('</style>', styleStart);
  const scriptStart = src.indexOf('<script>');
  const scriptEnd = src.lastIndexOf('</script>');
  if (styleStart < 0 || styleEnd < 0 || scriptStart < 0 || scriptEnd < 0) {
    throw new Error('Could not find <style>/<script> block boundaries in os.html');
  }

  const head    = src.slice(0, styleStart);
  const css     = src.slice(styleStart + '<style>'.length, styleEnd);
  const between = src.slice(styleEnd + '</style>'.length, scriptStart);
  const js      = src.slice(scriptStart + '<script>'.length, scriptEnd);
  const tail    = src.slice(scriptEnd + '</script>'.length);

  // Light, safe CSS minify: drop comments, collapse whitespace runs to single spaces.
  const cssMin = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();

  // Obfuscate the JS. renameGlobals:false is critical — inline handlers call globals.
  const JsObfuscator = require('javascript-obfuscator');
  const jsObf = JsObfuscator.obfuscate(js, {
    compact: true,
    renameGlobals: false,            // keep top-level function names for onclick="..."
    identifierNamesGenerator: 'mangled',
    stringArray: true,
    stringArrayThreshold: 0.7,
    stringArrayEncoding: [],          // arrayify but don't re-encode (safer/faster, esp. the big inlined game string)
    stringArrayRotate: true,
    stringArrayShuffle: true,
    splitStrings: false,
    controlFlowFlattening: false,     // off — risky/slow on a large hand-written app
    deadCodeInjection: false,
    numbersToExpressions: false,
    simplify: true,
    transformObjectKeys: false,
    selfDefending: false,
    unicodeEscapeSequence: false,
    target: 'browser',
  }).getObfuscatedCode();

  const indexHtml = head
    + '<link rel="stylesheet" href="/styles.css">'
    + between
    + '<script src="/app.js"></script>'
    + tail;

  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'styles.css'), cssMin);
  fs.writeFileSync(path.join(dist, 'app.js'), jsObf);
  fs.writeFileSync(path.join(dist, 'index.html'), indexHtml);

  console.log(`[build] dist/ written — index ${indexHtml.length}b, css ${cssMin.length}b, app.js ${jsObf.length}b (obfuscated)`);
} catch (e) {
  console.error('[build] FAILED, server will fall back to os.html:', e.message);
}
// Always succeed so an npm prestart hook never blocks the server from starting.
process.exit(0);
