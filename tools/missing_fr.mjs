// Lists the screen texts that have no French yet:  node tools/missing_fr.mjs
import fs from 'fs';
import path from 'path';
globalThis.localStorage = { getItem: () => 'fr', setItem: () => {} };
const { t } = await import('../js/i18n.js');
const files = [];
const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
walk('js');
const keys = new Set();
const re = /\b(?:t|refuse|plural)\(\s*'((?:[^'\\]|\\.)*)'/g;
const re2 = /\bplural\([^,]+,\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'/g;
for (const f of files) {
  if (f.endsWith('i18n.js')) continue;
  const s = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(s))) keys.add(m[1].replace(/\\'/g, "'"));
  while ((m = re2.exec(s))) { keys.add(m[1]); keys.add(m[2]); }
}
const missing = [...keys].filter(k => t(k) === k && /[a-z]{2}/i.test(k)).sort();
console.log(missing.length + ' missing');
for (const k of missing) console.log(JSON.stringify(k));
