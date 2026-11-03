// Real saved project, official SDK, native undo/reopen and immutable test-owned WAVs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export async function verifySpeakerReset({call,context,client,projectRoot}) {
 await call('studio_open_project',{path:projectRoot});
 const original=await call('studio_get_project');
 assert(original.characters.length>0&&original.dialogues.length>0);
 await call('studio_project_patch',{context:await context(),patches:[{op:'replace',path:'/dialogues/0/characterId',value:original.characters[0].id}]});
 const before=await call('studio_get_project');
 const references=before.characters.flatMap(c=>c.references.map(r=>r.path));
 const banks=Object.values(before.characterProfiles??{}).flatMap(p=>[...(p.voiceLibrary?.sources??[]),...(p.voiceLibrary?.samples??[])].map(r=>r.reference.path));
 const files=[...new Set([...references,...banks,...(before.voiceReferences??[]).map(r=>r.path),...before.generations.filter(g=>g.kind==='tts').map(g=>g.path)])];
 const hashes=new Map();
 for(const file of files)hashes.set(file,createHash('sha256').update(await fs.readFile(path.join(projectRoot,file))).digest('hex'));
 const preserved=async(after)=>{
  for(const key of ['generations','sourceCues','targetCues','tracks','media','voiceReferences','voiceEdits','dubbingTiming','pronunciation'])assert.deepEqual(after[key],before[key],key);
  assert(after.dialogues.every(l=>l.characterId===null));
  for(const [i,line] of after.dialogues.entries())assert.deepEqual(line.selectedGenerationIds,before.dialogues[i].selectedGenerationIds);
  assert(!after.speakerAnalysis);
  for(const file of files)assert.equal(createHash('sha256').update(await fs.readFile(path.join(projectRoot,file))).digest('hex'),hashes.get(file),file);
 };
 const firstContext=await context();
 await call('studio_reset_speakers',{context:firstContext,mode:'assignments'});
 let after=await call('studio_get_project');await preserved(after);
 assert.deepEqual(after.characters,before.characters);assert.deepEqual(after.characterProfiles,before.characterProfiles);
 const stale=await client.callTool({name:'studio_reset_speakers',arguments:{context:firstContext,mode:'characters'}});assert(stale.isError);
 await call('studio_history',{context:await context(),direction:'undo'});
 assert.deepEqual((await call('studio_get_project')).dialogues,before.dialogues);
 await call('studio_reset_speakers',{context:await context(),mode:'characters'});
 after=await call('studio_get_project');await preserved(after);assert.equal(after.characters.length,0);assert.equal(Object.keys(after.characterProfiles??{}).length,0);
 await call('studio_history',{context:await context(),direction:'undo'});
 assert.deepEqual((await call('studio_get_project')).characters,before.characters);
 await call('studio_history',{context:await context(),direction:'redo'});
 await call('studio_open_project',{path:projectRoot});
 after=await call('studio_get_project');await preserved(after);assert.equal(after.characters.length,0);
 return {bothExplicitModes:true,profilesAndLibrariesRetained:true,fullResetRemovesRecords:true,subtitlesTracksAndTakesPreserved:true,selectedTakesRetained:true,wavFilesUnchanged:files.length,undoRedo:true,reopen:true,staleContextRejected:true};
}
