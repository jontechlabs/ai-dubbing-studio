// Actual CPU detector, native frame seeking/crop and project preservation via SDK.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export async function verifyPortraitPreview({call,context,args}) {
 const fixture=JSON.parse(await fs.readFile(new URL('./portrait-preview-fixture.json',import.meta.url),'utf8'));
 const photo=Buffer.from(await(await fetch(fixture.url)).arrayBuffer());
 const hash=b=>createHash('sha256').update(b).digest('hex');
 assert.equal(photo.length,fixture.size);assert.equal(hash(photo),fixture.sha256);
 const image=path.join(args['test-root'],'public-face-sample.jpg'),movie=path.join(args['test-root'],'portrait-scenes.mp4');await fs.writeFile(image,photo);
 const ffmpeg=path.join(path.dirname(args.exe),'binaries/ffmpeg.exe');
 execFileSync(ffmpeg,['-v','error','-loop','1','-i',image,'-f','lavfi','-i','anullsrc=r=24000:cl=mono','-t','3','-vf',"scale=640:-2,setsar=1,hflip=enable='gte(t,1.5)'",'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-y',movie]);
 const original=hash(await fs.readFile(movie));
 const wait=async id=>{const until=Date.now()+600000;while(Date.now()<until){const j=(await call('studio_list_jobs')).find(j=>j.id===id);if(j?.status==='succeeded')return;if(j&&['failed','cancelled','interrupted'].includes(j.status))throw Error(JSON.stringify(j));await new Promise(r=>setTimeout(r,300));}throw Error('Portrait runtime deadline');};
 await wait(await call('studio_install_speaker_runtime'));
 const name='Portrait scenes 日本語',root=path.join(args['test-root'],name+'.dubproject');
 await call('studio_create_project',{parentPath:args['test-root'],name,source:'ja',target:'fr'});
 await wait(await call('studio_import_media',{context:await context(),path:movie,audioStreamIndex:1,forceProxy:false}));
 for(const [i,startMs] of [0,1600].entries())await call('studio_add_dialogue',{context:await context(),options:{startMs,endMs:startMs+1200,sourceText:'人物。',targetText:`Personnage ${i+1}.`}});
 const p=await call('studio_get_project');
 const chars=['portrait-a','portrait-b'].map((id)=>({id,name:id,color:'#82bda0',references:[],defaultReferenceId:null}));
 await call('studio_project_patch',{context:await context(),patches:[...chars.map(value=>({op:'add',path:'/characters/-',value})),...p.dialogues.map((l,i)=>({op:'replace',path:`/dialogues/${i}/characterId`,value:chars[i].id}))]});
 const before=await call('studio_get_project'),mediaHash=hash(await fs.readFile(path.join(root,before.media.path)));
 const first=await call('studio_preview_character_portrait',{context:await context(),options:{characterId:chars[0].id,lineId:before.dialogues[0].id,atMs:500,profile:'live'}});
 const second=await call('studio_preview_character_portrait',{context:await context(),options:{characterId:chars[1].id,lineId:before.dialogues[1].id,atMs:2000,profile:'live'}});
 for(const r of [first,second]){
  assert.equal(r.projectId,before.id);assert.equal(r.revision,before.revision);assert.equal(r.sourcePath,before.media.path);assert(r.faces.length>=2&&r.faces.length<=32);assert(r.width<=640&&r.height<=640);
  for(const f of r.faces)assert(f.x>=0&&f.y>=0&&f.width>0&&f.height>0&&f.x+f.width<=1.000001&&f.y+f.height<=1.000001);
 }
 assert.deepEqual(await call('studio_get_project'),before);
 const firstPng=await fs.readFile(first.imagePath),secondPng=await fs.readFile(second.imagePath);assert.notEqual(hash(firstPng),hash(secondPng));
 await call('studio_capture_character_portrait',{context:await context(),options:{characterId:chars[0].id,lineId:before.dialogues[0].id,atMs:500,crop:first.faces[1]}});
 const a=(await call('studio_get_project')).characterProfiles[chars[0].id].portrait;
 assert.equal(a.atMs,500);assert.deepEqual(a.crop,first.faces[1]);assert(a.confirmed);
 const aPath=await call('studio_character_asset_path',{path:a.path}),aBytes=await fs.readFile(aPath);assert.equal(aBytes.readUInt32BE(16),256);assert.equal(aBytes.readUInt32BE(20),256);
 await call('studio_capture_character_portrait',{context:await context(),options:{characterId:chars[1].id,lineId:before.dialogues[1].id,atMs:2000,crop:second.faces[0]}});
 const after=await call('studio_get_project');assert.deepEqual(after.characterProfiles[chars[0].id].portrait,a);assert.deepEqual(await fs.readFile(aPath),aBytes);
 assert.deepEqual(after.generations,before.generations);assert.deepEqual(after.sourceCues,before.sourceCues);assert.deepEqual(after.targetCues,before.targetCues);
 assert.equal(hash(await fs.readFile(movie)),original);assert.equal(hash(await fs.readFile(path.join(root,before.media.path))),mediaHash);
 return {actualPinnedCpuDetector:true,detectedFaces:[first.faces.length,second.faces.length],readOnlyPreview:true,differentScenesVerified:true,chosenSecondFaceCaptured:true,exactTimes:[500,2000],firstPortraitPreserved:true,thumbnailSize:[256,256],sourceMovieAndSubtitlesUnchanged:true,fixtureSha256:fixture.sha256};
}
