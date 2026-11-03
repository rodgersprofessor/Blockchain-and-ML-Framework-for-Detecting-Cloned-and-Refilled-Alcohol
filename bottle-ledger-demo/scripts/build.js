// Inlines src/engine.js into src/template.html and writes index.html (a single self-contained file).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const engine = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
const tpl = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
if (!tpl.includes('/*__ENGINE__*/')) throw new Error('placeholder /*__ENGINE__*/ missing from template');
fs.writeFileSync(path.join(root, 'index.html'), tpl.replace('/*__ENGINE__*/', () => engine));
console.log('Wrote index.html (' + fs.statSync(path.join(root, 'index.html')).size + ' bytes)');
