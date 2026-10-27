import {describe,expect,it} from 'vitest';
import {parseMapBackground} from '../../../src/renderer/postmatch/postmatch-session.js';
import {terrainCaption,terrainGeometry} from '../../../src/renderer/postmatch/replay-story-scene.mjs';
import {mapPoint} from '../../../src/renderer/postmatch/replay-story.mjs';

const mapSha='a'.repeat(64),imageSha='b'.repeat(64);
const background=()=>({status:'ready',map_sha256:mapSha,image_sha256:imageSha,source_kind:'editor-export',url:`/api/overlay/maps/${imageSha}/image`,image_size:[1000,500],bounds:{min_x:20,min_y:40,max_x:220,max_y:140},registration:{accuracy:'approximate'},path:'C:/private/map.png'});

describe('postmatch local map backgrounds',()=>{
  it('accepts a content-addressed native map and exports only display metadata',()=>{
    const actual=parseMapBackground(background(),mapSha);
    expect(actual.status).toBe('ready');expect(actual).not.toHaveProperty('path');
    expect(actual.bounds).toEqual(background().bounds);
    expect(parseMapBackground({...background(),source_kind:'minimap',registration:{accuracy:'validated'}},mapSha).status).toBe('ready');
  });
  it('rejects remote, mismatched, malformed and distorted terrain without breaking schematic fallback',()=>{
    for(const change of [
      {url:'https://remote.invalid/map.png'}, {url:`//remote.invalid/api/overlay/maps/${imageSha}/image`},
      {url:`/api/overlay/maps/${'c'.repeat(64)}/image`}, {url:`/api/overlay/maps/${imageSha}/image?path=C:/private`},
      {image_size:[0,500]},{image_size:[1000,1000]},{image_size:[4097,2048]},
      {bounds:{min_x:0,min_y:0,max_x:Infinity,max_y:100}}, {bounds:{min_x:220,min_y:40,max_x:20,max_y:140}},
      {source_kind:'file'},{registration:{accuracy:'invented'}},
    ])expect(parseMapBackground({...background(),...change},mapSha).status).toBe('unavailable');
    expect(parseMapBackground(background(),'f'.repeat(64)).status).toBe('unavailable');
    expect(parseMapBackground(undefined).status).toBe('unavailable');
  });
  it('uses one contained rectangle and north-up world coordinates on wide and tall canvases',()=>{
    for(const [w,h]of [[1200,400],[400,1200]]){
      const geometry=terrainGeometry(background(),w,h),{fit,bounds,padding,strict}=geometry;
      expect(fit.width/fit.height).toBe(2);expect(fit.x).toBeGreaterThanOrEqual(0);expect(fit.y).toBeGreaterThanOrEqual(0);
      expect(fit.x+fit.width).toBeLessThanOrEqual(w);expect(fit.y+fit.height).toBeLessThanOrEqual(h);
      expect(mapPoint(bounds,20,140,padding,strict)).toEqual([0,0]);
      expect(mapPoint(bounds,220,40,padding,strict)).toEqual([1,1]);
      expect(mapPoint(bounds,120,90,padding,strict)).toEqual([.5,.5]);
      expect(mapPoint(bounds,19,90,padding,strict)).toBeNull();
    }
  });
  it('labels approximate editor alignment without claiming measured accuracy',()=>{
    expect(terrainCaption(background())).toContain('приблизительная');
    expect(terrainCaption(background(),true)).toContain('approximate');
    expect(terrainCaption({...background(),source_kind:'minimap'})).toBe('Подложка миникарты');
    expect(terrainCaption({...background(),registration:{accuracy:'validated'}},true)).toBe('Map Editor export');
  });
});
