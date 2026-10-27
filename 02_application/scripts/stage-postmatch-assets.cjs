// Checked-in local assets only. Builds never download missing icons.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const source=path.join(root,'resources/postmatch-icons');
const registry=JSON.parse(fs.readFileSync(path.join(source,'registry.json'),'utf8'));
const outputRoot=path.join(root,'dist-obs');
const target=path.join(outputRoot,'assets/postmatch-icons');
for(const directory of [outputRoot,path.join(outputRoot,'assets'),target]) {
  if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw Error('Postmatch build output cannot be a filesystem link');
  fs.mkdirSync(directory,{recursive:true});
}
let count=0;
for(const [key,item] of Object.entries(registry.icons)) {
  if(!/^[A-Z0-9_]{1,80}$/.test(key)||item.file!==`${key}.png`||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('Invalid bundled icon registry');
  const file=path.join(source,item.file),stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>2*1024*1024)throw Error('Invalid bundled icon file');
  const bytes=fs.readFileSync(file);
  if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Bundled icon content differs from registry');
  fs.writeFileSync(path.join(target,item.file),bytes);count++;
}
fs.writeFileSync(path.join(target,'NOTICE.json'),JSON.stringify({source:registry.source,icons:registry.icons},null,2));
console.log(`Postmatch icon assets prepared: ${count}; no network or application data used.`);
