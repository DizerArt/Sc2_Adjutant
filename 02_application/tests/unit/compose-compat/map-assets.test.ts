import {it,expect} from "vitest";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {deflateSync} from "node:zlib";
import {mapMembers,primaryMapHash,readCachedMapImage,inflateMapSector} from "../../../src/compose-compat/map-assets.js";
const require=createRequire(import.meta.url);
const {hashString}=require("@replaysremastered/sc2readerjs/src/sc2mpq/storm") as {hashString:(s:string,t:number)=>number};
function encrypt(bytes:Buffer,name:string):Buffer{
  const table=new Uint32Array(0x500);let seed=0x100001;
  for(let i=0;i<256;i++)for(let j=0;j<5;j++){seed=(seed*125+3)%0x2aaaab;const hi=(seed&65535)<<16;seed=(seed*125+3)%0x2aaaab;table[i+j*256]=(hi|(seed&65535))>>>0;}
  let s=hashString(name,3),s2=0xeeeeeeee;const out=Buffer.alloc(bytes.length);
  for(let i=0;i<bytes.length;i+=4){s2=(s2+table[0x400+(s&255)])>>>0;const plain=bytes.readUInt32LE(i);out.writeUInt32LE((plain^(s+s2))>>>0,i);s=(((~s<<21)+0x11111111)|(s>>>11))>>>0;s2=(plain+s2+(s2<<5)+3)>>>0;}return out;
}
function archive(version=0){
  const files=[{name:"MapInfo",bytes:Buffer.from("IpaM-synthetic")},{name:"Minimap.tga",bytes:Buffer.from("synthetic TGA member")}];
  const headerSize=version===3?208:32;
  const hashes=Buffer.alloc(64,255),blocks=Buffer.alloc(32);let offset=headerSize+96;
  for(const[fileIndex,file]of files.entries()){let index=hashString(file.name,0)%4;while(hashes.readUInt32LE(index*16+12)!==0xffffffff)index=(index+1)%4;hashes.writeUInt32LE(hashString(file.name,1),index*16);hashes.writeUInt32LE(hashString(file.name,2),index*16+4);hashes.writeUInt32LE(0,index*16+8);hashes.writeUInt32LE(fileIndex,index*16+12);blocks.writeUInt32LE(offset,fileIndex*16);blocks.writeUInt32LE(file.bytes.length,fileIndex*16+4);blocks.writeUInt32LE(file.bytes.length,fileIndex*16+8);blocks.writeUInt32LE(0x81000000,fileIndex*16+12);offset+=file.bytes.length;}
  const head=Buffer.alloc(headerSize);head.write("MPQ\x1a",0,"binary");head.writeUInt32LE(headerSize,4);head.writeUInt32LE(offset,8);head.writeUInt16LE(version,12);head.writeUInt16LE(3,14);head.writeUInt32LE(headerSize,16);head.writeUInt32LE(headerSize+64,20);head.writeUInt32LE(4,24);head.writeUInt32LE(2,28);
  if(version===3){head.writeBigUInt64LE(BigInt(offset),44);head.writeBigUInt64LE(64n,68);head.writeBigUInt64LE(32n,76);}
  return Buffer.concat([head,encrypt(hashes,"(hash table)"),encrypt(blocks,"(block table)"),...files.map(f=>f.bytes)]);
}
it("uses only the last exact primary handle, never a mod or title",()=>{
  const first=Buffer.concat([Buffer.from("s2ma\0\0EU","binary"),Buffer.alloc(32,1)]),last=Buffer.concat([Buffer.from("s2ma\0\0EU","binary"),Buffer.alloc(32,2)]);
  expect(primaryMapHash({m_cacheHandles:[first,last]})).toBe("02".repeat(32));
  expect(primaryMapHash({m_cacheHandles:[first,Buffer.from("invalid")]})).toBeNull();
});
it("caps inflation before allocation and rejects mismatched output lengths",()=>{
  const plain=Buffer.alloc(2048,7),compressed=Buffer.concat([Buffer.from([2]),deflateSync(plain)]);
  expect(inflateMapSector(compressed,2048)).toEqual(plain);
  const bomb=Buffer.concat([Buffer.from([2]),deflateSync(Buffer.alloc(1024*1024))]);
  expect(()=>inflateMapSector(bomb,2048)).toThrow();
  expect(()=>inflateMapSector(compressed,4096)).toThrow(/size/);
});
it("reads real plain MPQ tables rather than requiring replay userdata magic",async()=>{
  const value=await mapMembers(archive());expect(value.mapInfo.toString()).toBe("IpaM-synthetic");expect(value.minimap.toString()).toBe("synthetic TGA member");
  expect((await mapMembers(archive(3))).minimap.toString()).toBe("synthetic TGA member");
  const invalid=archive();invalid.writeUInt32LE(65537,24);await expect(mapMembers(invalid)).rejects.toThrow(/limits/);
  const truncated=archive().subarray(0,110);await expect(mapMembers(truncated)).rejects.toThrow();
});
it("checks the local archive SHA and preserves sources, rejecting links and missing maps",async()=>{
  const root=await mkdtemp(join(tmpdir(),"compose-map-"));
  try{const raw=archive(),sha=createHash("sha256").update(raw).digest("hex"),cache=join(root,"Cache"),file=join(cache,sha.slice(0,2),sha.slice(2,4),sha+".s2ma");await mkdir(join(cache,sha.slice(0,2),sha.slice(2,4)),{recursive:true});await writeFile(file,raw);
    const value=await readCachedMapImage(sha,[cache]);expect(Buffer.from(String(value.mapInfoBase64),"base64").toString()).toBe("IpaM-synthetic");expect(await readFile(file)).toEqual(raw);
    await writeFile(file,Buffer.from("changed"));await expect(readCachedMapImage(sha,[cache])).rejects.toThrow(/checksum/);
    await expect(readCachedMapImage("f".repeat(64),[cache])).rejects.toThrow(/absent/);
    const link=join(root,"linked");await symlink(cache,link,"junction");await expect(readCachedMapImage(sha,[link])).rejects.toThrow(/links/);
  }finally{await rm(root,{recursive:true,force:true});}
});
