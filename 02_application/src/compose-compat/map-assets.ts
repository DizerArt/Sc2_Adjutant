/** Exact local SC2 map snapshots; no network, title guessing or writes to the cache. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { inflateSync, inflateRawSync } from "node:zlib";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
const require=createRequire(import.meta.url);
const MAX_ARCHIVE=64*1024*1024,MAX_EXPANDED=128*1024*1024;
type HashEntry={a:number;b:number;locale:number;platform:number;blockIndex:number};
type Block={filePosition:number;compressedSize:number;uncompressedSize:number;flags:number};
type Reader={read:(buffer:Buffer,offset:number,length:number,position:number)=>Promise<{bytesRead:number}>;close:()=>Promise<void>};
/** Each inflation is capped before output allocation; never truncate an oversized sector. */
export function inflateMapSector(data:Buffer,expected:number):Buffer {
  if(!Number.isSafeInteger(expected)||expected<1||expected>8*1024*1024)throw Error("Map sector output limit is invalid");
  if(data.length===expected)return data;
  if(!data.length||data.length>expected)throw Error("Invalid compressed map sector size");
  const method=data[0];if(!method||(method&~0x12))throw Error("Unsupported map compression flags");
  let out:Buffer=data.subarray(1);
  if(method&0x10){
    const bz=require("seek-bzip") as {decode:(input:Buffer,output:{writeByte:(b:number)=>void})=>unknown};
    const bytes=Buffer.alloc(expected);let written=0;
    bz.decode(out,{writeByte(byte){if(written>=expected)throw Error("Map bzip output exceeds limit");bytes[written++]=byte;}});
    out=bytes.subarray(0,written);
  }
  if(method&2){try{out=inflateSync(out,{maxOutputLength:expected});}catch{out=inflateRawSync(out,{maxOutputLength:expected});}}
  if(out.length!==expected)throw Error("Decoded map sector size differs from table");return out;
}
export function primaryMapHash(details:Record<string,unknown>):string|null {
  if(!Array.isArray(details.m_cacheHandles)||!details.m_cacheHandles.length)return null;
  const last=details.m_cacheHandles.at(-1);
  if(!(last instanceof Uint8Array))return null;
  const bytes=Buffer.from(last);return bytes.length===40&&bytes.subarray(0,4).toString("ascii")==="s2ma"?bytes.subarray(8).toString("hex"):null;
}
export function mapCacheRoots():string[]{return [...new Set([process.env.PROGRAMDATA,process.env.LOCALAPPDATA].filter((v):v is string=>Boolean(v)).map(p=>join(p,"Blizzard Entertainment","Battle.net","Cache")))];}
async function safeCandidate(root:string,hash:string):Promise<string>{
  if(!isAbsolute(root)||root.startsWith("\\\\")||root.startsWith("//"))throw Error("Map cache root must be a local absolute directory");
  const parts=root.slice(parse(root).root.length).split(/[\\/]/);
  if(parts.some(p=>!p||/[<>:"|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)))throw Error("Map cache root contains a path alias");
  const base=resolve(root),file=join(base,hash.slice(0,2),hash.slice(2,4),hash+".s2ma");
  if(relative(base,file).startsWith(".."))throw Error("Map cache path escaped root");
  for(let part=file;;part=dirname(part)){
    try{if((await lstat(part)).isSymbolicLink())throw Error("Map cache links are unsupported");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(dirname(part)===part)break;
  }
  return file;
}
/** An owned bounded byte snapshot supplies the MPQ tables and member slices. */
export async function mapMembers(raw:Buffer):Promise<{mapInfo:Buffer;minimap:Buffer}>{
  if(raw.length<32||raw.length>MAX_ARCHIVE)throw Error("Map archive size is unsupported");
  const start=raw.subarray(0,4).equals(Buffer.from("MPQ\x1b","binary"))?raw.readUInt32LE(8):0;
  const region=(offset:number,length:number)=>{if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>raw.length)throw Error("Map archive range is invalid");return raw.subarray(offset,offset+length);};
  const fixed=region(start,32);if(!fixed.subarray(0,4).equals(Buffer.from("MPQ\x1a","binary")))throw Error("Map MPQ header is unavailable");
  const header={headerSize:fixed.readUInt32LE(4),archiveSize:fixed.readUInt32LE(8),formatVersion:fixed.readUInt16LE(12),blockSize:fixed.readUInt16LE(14),hashTableOffset:fixed.readUInt32LE(16),blockTableOffset:fixed.readUInt32LE(20),hashTableEntries:fixed.readUInt32LE(24),blockTableEntries:fixed.readUInt32LE(28)};
  if(header.formatVersion>3||header.headerSize<32||header.blockSize>9||!header.hashTableEntries||header.hashTableEntries>65536||!header.blockTableEntries||header.blockTableEntries>65536||header.archiveSize>raw.length-start)throw Error("Map MPQ header limits are unsupported");
  region(start,header.headerSize);
  if(header.formatVersion>=1){const extra=region(start+32,12);if(extra.readBigUInt64LE(0)!==0n||extra.readUInt16LE(8)!==0||extra.readUInt16LE(10)!==0)throw Error("Extended map table offsets are unsupported");}
  if(header.formatVersion>=2&&(header.headerSize<68||region(start+44,8).readBigUInt64LE()!==BigInt(header.archiveSize)))throw Error("Map extended archive size is invalid");
  if(header.formatVersion===3&&(header.headerSize<208||region(start+68,8).readBigUInt64LE()!==BigInt(header.hashTableEntries*16)||region(start+76,8).readBigUInt64LE()!==BigInt(header.blockTableEntries*16)))throw Error("Compressed map tables are unsupported");
  region(start+header.hashTableOffset,header.hashTableEntries*16);region(start+header.blockTableOffset,header.blockTableEntries*16);
  const reader:Reader={async read(buffer,offset,length,position){const bytes=region(position,length);bytes.copy(buffer,offset);return {bytesRead:length};},async close(){}};
  const {decryptTable,hashString,decryptBytes}=require("@replaysremastered/sc2readerjs/src/sc2mpq/storm") as {decryptTable:(r:Reader,entries:number,name:string,offset:number)=>Promise<Uint32Array>;hashString:(name:string,type:number)=>number;decryptBytes:(buffer:Buffer,seed:number)=>void};
  const hashes=await decryptTable(reader,header.hashTableEntries,"(hash table)",start+header.hashTableOffset);
  const hashTable:HashEntry[]=Array.from({length:header.hashTableEntries},(_,i)=>({a:hashes[i*4],b:hashes[i*4+1],locale:hashes[i*4+2]>>>16,platform:hashes[i*4+2]&65535,blockIndex:hashes[i*4+3]}));
  const blocks=await decryptTable(reader,header.blockTableEntries,"(block table)",start+header.blockTableOffset);
  const blockTable:Block[]=Array.from({length:header.blockTableEntries},(_,i)=>({filePosition:blocks[i*4],compressedSize:blocks[i*4+1],uncompressedSize:blocks[i*4+2],flags:blocks[i*4+3]}));
  let expanded=0;for(const b of blockTable){if(!(b.flags&0x80000000))continue;expanded+=b.uncompressedSize;if(expanded>MAX_EXPANDED)throw Error("Expanded map exceeds its limit");region(start+b.filePosition,b.compressedSize);}
  const member=async(name:string,max:number)=>{const a=hashString(name,1),b=hashString(name,2);let target:Block|undefined;
    for(let i=0;i<hashTable.length;i++){const item=hashTable[(hashString(name,0)+i)%hashTable.length];if(item.blockIndex===0xffffffff)break;if(item.a===a&&item.b===b&&item.blockIndex!==0xfffffffe){target=blockTable[item.blockIndex];break;}}
    if(!target||!target.uncompressedSize||target.uncompressedSize>max)throw Error("Map member is missing or oversized");
    if(!(target.flags&0x80000000)||(target.flags&0x100100))throw Error("Unsupported map member flags");
    const stored=region(start+target.filePosition,target.compressedSize),compressed=!!(target.flags&0x200),encrypted=!!(target.flags&0x10000);
    let seed=hashString(name.split(/[\\/]/).at(-1)!,3);if(target.flags&0x20000)seed=((seed+target.filePosition)^target.uncompressedSize)>>>0;
    const decrypt=(bytes:Buffer,index:number)=>{if(!encrypted)return bytes;const copy=Buffer.from(bytes);decryptBytes(copy,(seed+index)>>>0);return copy;};
    if(target.flags&0x1000000){const bytes=decrypt(stored,0);if(!compressed&&bytes.length!==target.uncompressedSize)throw Error("Map raw member size differs from table");return compressed?inflateMapSector(bytes,target.uncompressedSize):bytes;}
    const sectorSize=512*2**header.blockSize,count=Math.ceil(target.uncompressedSize/sectorSize),out=Buffer.alloc(target.uncompressedSize);
    let offsets:Buffer|undefined;if(compressed){if((count+1)*4>stored.length)throw Error("Map sector table exceeds member");offsets=decrypt(stored.subarray(0,(count+1)*4),-1);if(offsets.readUInt32LE(0)<(count+1)*4)throw Error("Map sectors overlap their table");}
    for(let i=0;i<count;i++){const expected=Math.min(sectorSize,out.length-i*sectorSize),lo=offsets?offsets.readUInt32LE(i*4):i*sectorSize,hi=offsets?offsets.readUInt32LE((i+1)*4):lo+expected;
      if(hi<=lo||hi>stored.length)throw Error("Map sector exceeds its member boundary");
      const bytes=decrypt(stored.subarray(lo,hi),i),decoded=compressed?inflateMapSector(bytes,expected):bytes;if(decoded.length!==expected)throw Error("Map raw sector size differs from table");decoded.copy(out,i*sectorSize);
    }return out;};
  return {mapInfo:await member("MapInfo",1024*1024),minimap:await member("Minimap.tga",8*1024*1024)};
}
export async function readCachedMapImage(hash:unknown,roots:readonly string[]=mapCacheRoots()):Promise<Record<string,unknown>>{
  if(typeof hash!=="string"||!/^[a-f0-9]{64}$/.test(hash))throw Error("Invalid primary map checksum");
  for(const root of roots){
    const candidate=await safeCandidate(root,hash);
    let info;try{info=await lstat(candidate);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}
    if(!info.isFile()||info.size<=0||info.size>MAX_ARCHIVE)throw Error("Map archive is oversized or unavailable");
    const file=await open(candidate,"r");let raw:Buffer;
    try{const held=await file.stat();if(!held.isFile()||held.size!==info.size||held.ino!==info.ino||held.dev!==info.dev)throw Error("Map archive changed before reading");
      const bytes=Buffer.alloc(info.size+1);let used=0;while(used<bytes.length){const part=await file.read(bytes,used,Math.min(65536,bytes.length-used),used);if(!part.bytesRead)break;used+=part.bytesRead;}
      const after=await file.stat();if(used!==info.size||after.size!==info.size||after.mtimeMs!==held.mtimeMs)throw Error("Map archive changed during reading");raw=bytes.subarray(0,used);
    }finally{await file.close();}
    if(createHash("sha256").update(raw).digest("hex")!==hash)throw Error("Cached map checksum differs from replay");
    const {mapInfo,minimap}=await mapMembers(raw);
    return {mapSha256:hash,mapInfoBase64:mapInfo.toString("base64"),minimapBase64:minimap.toString("base64")};
  }
  throw Error("Exact primary map is absent from the local SC2 cache");
}
