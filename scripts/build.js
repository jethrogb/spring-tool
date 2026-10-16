// Builds spring-tool.html: the template with the solver and the app code
// inlined at the //@SOLVER@ and //@APP@ lines. Run: npm run build
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

let html = read('src', 'template.html');
for (const [name, file] of [
  ['SOLVER', 'solver.js'],
  ['APP', 'app.js'],
]) {
  const marker = new RegExp(`^//@${name}@\\r?\\n`, 'm');
  if (!marker.test(html)) throw new Error(`src/template.html has no //@${name}@ line`);
  const code = read('src', file);
  // a function replacement, so "$" in the code is taken literally
  html = html.replace(marker, () => (code.endsWith('\n') ? code : `${code}\n`));
}

const out = path.join(root, 'spring-tool.html');
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(process.cwd(), out)} (${html.length} bytes)`);
