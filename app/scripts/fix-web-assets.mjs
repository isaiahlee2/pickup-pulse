// Upload tools (e.g. Netlify Drop) often skip folders named node_modules.
// Expo's web export puts some router icons under dist/assets/node_modules/,
// so move them to dist/assets/nm/ and rewrite the bundle references.
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? 'dist');
const from = path.join(dist, 'assets', 'node_modules');
const to = path.join(dist, 'assets', 'nm');
if (!fs.existsSync(from)) { console.log('nothing to fix'); process.exit(0); }
fs.renameSync(from, to);

let files = 0;
const walk = (dir) => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html|json|css)$/.test(f)) {
      const s = fs.readFileSync(p, 'utf8');
      if (s.includes('assets/node_modules/')) { fs.writeFileSync(p, s.split('assets/node_modules/').join('assets/nm/')); files++; }
    }
  }
};
walk(dist);
console.log(`moved router assets to assets/nm, rewrote ${files} file(s)`);
