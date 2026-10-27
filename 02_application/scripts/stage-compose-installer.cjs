// Copy the locally built Tauri installer into a reviewable release folder.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(config.version)||config.productName!=='SC2 Adjutant Compose')throw Error('Unexpected installer identity');
const name=`${config.productName}_${config.version}_x64-setup.exe`;
const source=path.join(root,'src-tauri/target/release/bundle/nsis',name);
const binary=path.join(root,'src-tauri/target/release/sc2-adjutant-compose.exe');
// Tauri restores the original executable after packaging, advancing its timestamp slightly.
if(!fs.existsSync(source)||fs.statSync(source).mtimeMs+2000<fs.statSync(binary).mtimeMs)throw Error('Build the current installer first: node scripts/compose.cjs build --bundles nsis');
const output=path.join(root,'release/compose-installer');
fs.mkdirSync(output,{recursive:true});
const target=path.join(output,name);
fs.copyFileSync(source,target);
const sha=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
fs.writeFileSync(path.join(output,'SHA256SUMS.txt'),`${sha}  ${name}\n`);
fs.writeFileSync(path.join(output,'README.txt'),[
  'SC2 Adjutant Compose - Windows x64 installation preview',
  `Run ${name}. Select English or Russian and the destination folder.`,
  'Installs for the current user. Existing Electron installation and profile are separate.',
  'Includes application resources, maps and Node. WebView2 is required; the installer downloads it if absent.',
  'Exit Compose from its tray menu before updating. Keep app data when uninstalling to preserve history/settings.',
  'This local installer is unsigned. No publication or automatic update service is configured.',
  'Verified gates and known limitations: docs/compose/STATUS.md and INSTALLATION.md.'
].join('\r\n')+'\r\n');
console.log(JSON.stringify({installer:target,bytes:fs.statSync(target).size,sha256:sha}));
