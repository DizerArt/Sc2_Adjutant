const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const binary = path.join(root, 'src-tauri/target/release/sc2-adjutant-compose.exe');
if (!fs.existsSync(binary)) throw new Error('Build Compose first: npm run build:compose -- --no-bundle');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(args[1]))) {
  throw new Error('Usage: node scripts/stage-compose.cjs [--output release-folder-name]');
}
const output = path.join(root, 'release', args[1] || 'compose-preview');
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(binary, path.join(output, 'SC2 Adjutant Compose.exe'));
for (const folder of ['compose-runtime', 'voice-wasm', 'voice-models', 'map-bank']) {
  const source = path.join(root, 'resources', folder);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(output, folder), { recursive: true, filter: (source) => !source.endsWith('.gitignore') });
}
const obsWeb=path.join(root,'dist-obs');
if (!fs.existsSync(path.join(obsWeb,'obs.html'))) throw new Error('Build OBS resources before staging');
fs.cpSync(obsWeb,path.join(output,'obs-web'),{recursive:true});
fs.writeFileSync(path.join(output, 'README.txt'), 'Compose migration preview. Transitional Node parser/domain adapter is included.\r\nDefault data profile is separate from Electron. Use SC2_ASSISTANT_DATA_DIR to select an explicit copied profile.\r\nThis folder requires an installed WebView2 runtime; it is not a fully self-contained portable release.\r\nSee docs/compose/STATUS.md for verified gates and remaining parity work.\r\n');
console.log(`Staged preview: ${output}`);
