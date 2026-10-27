// Transitional parser/domain adapter. No application data, models or services are touched.
const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'resources', 'compose-runtime');

function copyPackage(name, seen = new Set()) {
  if (seen.has(name)) return;
  seen.add(name);
  const source = path.join(root, 'node_modules', name);
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  fs.cpSync(source, path.join(output, 'node_modules', name), { recursive: true, dereference: false });
  for (const dependency of Object.keys(metadata.dependencies || {})) copyPackage(dependency, seen);
}

async function main() {
  require('./verify-map-bank.cjs').verify();
  fs.mkdirSync(output, { recursive: true });
  await build({
    entryPoints: [path.join(root, 'src/compose-compat/worker.ts')],
    outfile: path.join(output, 'worker.mjs'),
    bundle: true, platform: 'node', target: 'node20', format: 'esm',
    external: ['@replaysremastered/sc2readerjs', '@replaysremastered/sc2readerjs/*']
  });
  copyPackage('@replaysremastered/sc2readerjs');
  fs.copyFileSync(process.execPath, path.join(output, process.platform === 'win32' ? 'node.exe' : 'node'));
  const runtimeLock = JSON.parse(fs.readFileSync(path.join(root, 'resources/compose-runtime.lock.json'), 'utf8'));
  if (process.version !== runtimeLock.nodeVersion) throw new Error(`Compose packaging requires Node ${runtimeLock.nodeVersion}; found ${process.version}`);
  const nodeLicense = path.join(root, 'resources/compose-node-LICENSE.txt');
  const licenseHash = createHash('sha256').update(fs.readFileSync(nodeLicense)).digest('hex');
  if (licenseHash !== runtimeLock.licenseSha256) throw new Error('Bundled Node license checksum differs from the runtime lock');
  fs.copyFileSync(nodeLicense, path.join(output, 'NODE-LICENSE.txt'));
  const hashes = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected link in bundled runtime');
      if (entry.isDirectory()) visit(filename);
      else if (entry.name !== 'manifest.json') hashes[path.relative(output, filename).replaceAll('\\', '/')] = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    }
  }
  visit(output);
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ schema: 1, transitional: true, node: process.version, hashes }, null, 2));
  console.log(`Compose compatibility resources prepared (${Object.keys(hashes).length} files, Node ${process.version}).`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
