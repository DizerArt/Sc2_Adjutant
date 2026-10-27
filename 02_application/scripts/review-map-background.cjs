// Explicit offline visual probe. Reads only a selected owned smoke cache, never replay facts.
const fs=require('node:fs');
const path=require('node:path');
const {createReviewServer}=require('./review-browser.cjs');
async function main(){
  const appRoot=path.resolve(__dirname,'..'),testRoot=fs.realpathSync(path.join(appRoot,'.compose-test-data'));
  const profile=fs.realpathSync(process.argv[2]||'');
  if(!profile.startsWith(testRoot+path.sep))throw Error('Select an owned .compose-test-data profile');
  const root=fs.realpathSync(path.join(profile,'map-backgrounds'));
  if(!root.startsWith(profile+path.sep))throw Error('Cache escaped owned profile');
  const names=fs.readdirSync(root).filter(n=>/^[0-9a-f]{64}\.json$/.test(n));
  if(names.length!==1)throw Error('Expected exactly one prepared map');
  const background=JSON.parse(fs.readFileSync(path.join(root,names[0]),'utf8'));
  if(!/^[0-9a-f]{64}$/.test(background.image_sha256))throw Error('Invalid image identity');
  const file=fs.realpathSync(path.join(root,background.image_sha256+'.png'));
  if(path.dirname(file)!==root||fs.statSync(file).size>16*1024*1024)throw Error('Invalid map image');
  const review=await createReviewServer({appRoot,mapFixture:{background,bytes:fs.readFileSync(file)}});
  console.log(JSON.stringify({url:review.origin+'/widgets/postmatch.html?kind=battle_map&lang=ru&preview=1',runDir:review.runDir,source:background.source_kind}));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>review.close().then(()=>process.exit(0)));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
