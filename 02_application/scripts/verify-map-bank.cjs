// Offline packaging check for the user-supplied SC2 Editor terrain exports.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
function verify(){
  const root=path.resolve(__dirname,'../resources/map-bank'),catalog=path.join(root,'catalog.json');
  if(fs.lstatSync(root).isSymbolicLink()||fs.statSync(catalog).size>512*1024)throw Error('Invalid map bank root/catalog');
  const value=JSON.parse(fs.readFileSync(catalog,'utf8'));if(value.schema_version!==1||!Array.isArray(value.maps)||value.maps.length>256)throw Error('Invalid map bank catalog');
  let bytes=0,accepted=0;const seen=new Set();
  for(const row of value.maps){
    if(!/^[a-z0-9-]+\.png$/.test(row.image)||seen.has(row.image)||!Array.isArray(row.map_sha256)||!row.map_sha256.every(v=>/^[a-f0-9]{64}$/.test(v)))throw Error('Invalid map bank identity');seen.add(row.image);
    const file=path.join(root,row.image),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw Error('Invalid map bank image');
    const raw=fs.readFileSync(file);if(raw.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||createHash('sha256').update(raw).digest('hex')!==row.image_sha256)throw Error('Map bank image checksum mismatch');
    const [w,h]=[raw.readUInt32BE(16),raw.readUInt32BE(20)];if(w<1||h<1||w>4096||h>4096||row.image_size[0]!==w||row.image_size[1]!==h)throw Error('Map bank dimensions mismatch');
    const b=row.bounds;if(!b||!['min_x','min_y','max_x','max_y'].every(k=>Number.isFinite(b[k])&&b[k]>=0&&b[k]<=4096)||b.max_x<=b.min_x||b.max_y<=b.min_y||Math.abs(w/(b.max_x-b.min_x)*(b.max_y-b.min_y)-h)>1)throw Error('Invalid map bank world geometry');
    bytes+=raw.length;accepted+=row.map_sha256.length;if(bytes>512*1024*1024)throw Error('Map bank exceeds package limit');
  }
  console.log(`Map bank verified: ${value.maps.length} editor images, ${accepted} exact map revisions; ${(bytes/1024/1024).toFixed(1)} MiB; offline.`);
}
module.exports={verify};if(require.main===module)verify();
