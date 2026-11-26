'use strict';
// Usage: node scripts/verify-package.js [folder]   Checks manifest.json and that every referenced file exists.
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (m.manifest_version !== 3) throw new Error('manifest_version must be 3');
const refs = [...m.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]), ...Object.values(m.icons || {})];
const missing = refs.filter((f) => !fs.existsSync(path.join(root, f)));
for (const f of refs) new Function(f.endsWith('.js') ? fs.readFileSync(path.join(root, f), 'utf8') : '');
console.log(`manifest v${m.version}: ${refs.length} referenced files, permissions: ${JSON.stringify(m.permissions)}, hosts: ${JSON.stringify(m.content_scripts.map((c) => c.matches))}`);
if (missing.length) { console.error('MISSING:', missing); process.exit(1); }
console.log('OK: all referenced files exist and parse');
