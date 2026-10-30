// Actual full-weight separator, packaged desktop, immutable child sources,
// track routing and concurrent MKV mix through the official MCP SDK.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
export async function verifySpeakerDubbing({call,context,job,args,projectRoot}) {
 const before=await call('studio_get_project'),line=before.dialogues.find((l)=>l.endMs-l.startMs>=1000&&l.endMs-l.startMs<=60000);
 assert(line);const hash=b=>createHash('sha256').update(b).digest('hex');
 const original=hash(await fs.readFile(path.join(projectRoot,before.media.path)));
 const status=await call('studio_speaker_separation_status');assert.equal(status.models.length,3);assert(status.models.every((m)=>m.installed));
 const id=await call('studio_separate_dialogue_speakers',{context:await context(),options:{lineId:line.id,modelId:'mossformer2-16k',sourceTrackId:'original',startMs:line.startMs,endMs:line.endMs,device:'cpu',prompt:'',windowSeconds:2}});await job(id);
 const result=await call('studio_speaker_separation_result',{context:await context(),id});assert.equal(result.stale,false);assert.deepEqual(result.outputs,['voice-1','voice-2']);
 for(const outputId of result.outputs) assert((await fs.stat(await call('studio_speaker_separation_path',{context:await context(),id,outputId}))).size>44);
 const created=await call('studio_create_speaker_dubbings',{context:await context(),id,assignments:result.outputs.map((outputId,i)=>({outputId,label:`Personne ${i+1}`,characterId:null,sourceText:`声 ${i+1}`,targetText:`Bonjour ${i+1}.`}))});
 const group=created.speakerDubbings.at(-1);assert.equal(created.formatVersion,25);assert(group.active);assert.equal(group.voices.length,2);
 assert.deepEqual(created.generations,before.generations);assert.deepEqual(created.sourceCues,before.sourceCues);assert.deepEqual(created.targetCues,before.targetCues);
 for(const voice of group.voices){const l=created.dialogues.find((l)=>l.id===voice.lineId);assert.deepEqual(l.sourceCueIds,[]);assert.deepEqual(l.targetCueIds,[]);assert((await fs.stat(path.join(projectRoot,voice.audioPath))).size>44);}
 const basis=created.generations.find((g)=>g.kind==='tts');assert(basis);
 const patches=[];for(const voice of group.voices){const g={...structuredClone(basis),id:randomUUID(),dialogueId:voice.lineId,startMs:line.startMs,endMs:line.endMs,language:created.languages.target,characterId:null,text:voice.translations[created.languages.target],sourcePath:created.media.path};delete g.prosodyTransfer;delete g.takeOrigin;delete g.dubbingPipeline;patches.push({op:'add',path:'/generations/-',value:g},{op:'add',path:`/dialogues/${created.dialogues.findIndex((l)=>l.id===voice.lineId)}/selectedGenerationIds/${created.languages.target}`,value:g.id});}
 await call('studio_project_patch',{context:await context(),patches});
 const output=path.join(projectRoot,'exports','overlapping-voices.mkv');await job(await call('studio_export_mkv',{context:await context(),output,options:{includeOriginal:false,sourceSubtitles:true,targetSubtitles:true,codec:'flac',allowIncomplete:true}}));assert((await fs.stat(output)).size>1000);
 const saved=await call('studio_get_project');await call('studio_open_project',{path:projectRoot});const reopened=await call('studio_get_project');assert.deepEqual(reopened.speakerDubbings,saved.speakerDubbings);assert.deepEqual(reopened.generations,saved.generations);
 // Applying both outputs to one destination must replace once then add, keeping both.
 const id2=await call('studio_separate_dialogue_speakers',{context:await context(),options:result.options});await job(id2);
 const routed=await call('studio_apply_speaker_separation_result',{context:await context(),id:id2,destinations:result.outputs.map((outputId)=>({outputId,trackId:null,role:'speech',mode:'replace'})),muteSource:false});
 const layers=routed.generations.filter((g)=>g.operationId===id2);assert.deepEqual(layers.map((g)=>g.mode),['replace','add']);assert.equal(layers[0].trackId,layers[1].trackId);
 await call('studio_history',{context:await context(),direction:'undo'});assert.deepEqual((await call('studio_get_project')).generations,reopened.generations);
 assert.equal(hash(await fs.readFile(path.join(projectRoot,before.media.path))),original);
 return {realMossFormer2Cpu:true,outputs:2,independentChildren:true,subtitlesAndPreviousTakesPreserved:true,concurrentMkvExport:true,replaceThenAdd:true,undoAndReopen:true,sourceMovieUnchanged:true};
}
