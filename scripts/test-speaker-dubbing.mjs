// Actual full-weight separator, packaged desktop, immutable child sources,
// track routing and concurrent MKV mix through the official MCP SDK.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
export async function verifySpeakerDubbing({call,context,job,args,projectRoot:previousRoot}) {
 const previous=await call('studio_get_project');
 const name='Overlapping voices 日本語',projectRoot=path.join(args['test-root'],name+'.dubproject');
 await call('studio_create_project',{parentPath:args['test-root'],name,source:'ja',target:'fr'});
 await job(await call('studio_import_media',{context:await context(),path:args.movie,audioStreamIndex:1,forceProxy:false}));
 await call('studio_add_dialogue',{context:await context(),options:{startMs:2000,endMs:4000,sourceText:'機械テスト。',targetText:'Une phrase du parent.'}});
 const seed=await call('studio_get_project'),seedLine=seed.dialogues[0],seedId=randomUUID(),seedPath='generations/'+seedId+'.wav';
 // A known two-second PCM fixture makes playback and overlap assertions
 // independent of the projects modified by earlier SDK checks. No TTS claim.
 const wave=Buffer.alloc(44+48000*2);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(24000,24);wave.writeUInt32LE(48000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
 for(let i=0;i<48000;i++)wave.writeInt16LE(Math.round(Math.sin(i/24000*440*2*Math.PI)*6000),44+i*2);
 await fs.writeFile(path.join(projectRoot,seedPath),wave);
 const parentTake={id:seedId,kind:'tts',dialogueId:seedLine.id,providerId:'cosyvoice3',modelId:'cosy3-official',path:seedPath,createdAt:new Date().toISOString(),sourcePath:seed.media.path,startMs:seedLine.startMs,endMs:seedLine.endMs,text:'Une phrase du parent.',language:'fr',characterId:null,durationMs:2000,sampleRate:24000,options:{variantId:'cosy3-official',device:'cpu',referenceMode:'current',referenceId:null,mode:'crossLingual',speed:1,seed:0},referenceTranscript:'機械テスト。',device:'cpu',deviceName:'Synthetic protocol fixture',peakVramMb:0,inputHash:createHash('sha256').update(wave).digest('hex')};
 // Real generation upgrades the project automatically; a directly injected
 // synthetic take must explicitly declare its supported project format too.
 await call('studio_project_patch',{context:await context(),patches:[{op:'replace',path:'/formatVersion',value:Math.max(5,seed.formatVersion)},{op:'add',path:'/generations/-',value:parentTake},{op:'add',path:'/dialogues/0/selectedGenerationIds/fr',value:seedId},{op:'replace',path:'/dialogues/0/status',value:'generated'}]});
 console.log('SPEAKER_DUBBING_STAGE synthetic parent prepared');
 const before=await call('studio_get_project'),line=before.dialogues.find((l)=>l.endMs-l.startMs>=1000&&l.endMs-l.startMs<=60000);
 assert(line);const hash=b=>createHash('sha256').update(b).digest('hex');
 const original=hash(await fs.readFile(path.join(projectRoot,before.media.path)));
 const status=await call('studio_speaker_separation_status');assert.equal(status.models.length,3);assert(status.models.every((m)=>m.installed));
 const id=await call('studio_separate_dialogue_speakers',{context:await context(),options:{lineId:line.id,modelId:'mossformer2-16k',sourceTrackId:'original',startMs:line.startMs,endMs:line.endMs,device:'cpu',prompt:'',windowSeconds:2}});await job(id);
 const result=await call('studio_speaker_separation_result',{context:await context(),id});assert.equal(result.stale,false);assert.deepEqual(result.outputs,['voice-1','voice-2']);console.log('SPEAKER_DUBBING_STAGE real MossFormer2 outputs ready');
 for(const outputId of result.outputs) assert((await fs.stat(await call('studio_speaker_separation_path',{context:await context(),id,outputId}))).size>44);
 const created=await call('studio_create_speaker_dubbings',{context:await context(),id,assignments:result.outputs.map((outputId,i)=>({outputId,label:`Personne ${i+1}`,characterId:null,sourceText:`声 ${i+1}`,targetText:`Bonjour ${i+1}.`}))});
 const group=created.speakerDubbings.at(-1);assert.equal(created.formatVersion,25);assert(group.active);assert.equal(group.voices.length,2);console.log('SPEAKER_DUBBING_STAGE independent children created');
 assert.deepEqual(created.generations,before.generations);assert.deepEqual(created.sourceCues,before.sourceCues);assert.deepEqual(created.targetCues,before.targetCues);
 for(const voice of group.voices){const l=created.dialogues.find((l)=>l.id===voice.lineId);assert.deepEqual(l.sourceCueIds,[]);assert.deepEqual(l.targetCueIds,[]);assert.equal(l.voiceSettings.referenceMode,'current');assert((await fs.stat(path.join(projectRoot,voice.audioPath))).size>44);}
 const basis=created.generations.find((g)=>g.kind==='tts');assert(basis);
 const patches=[];for(const voice of group.voices){const g={...structuredClone(basis),id:randomUUID(),dialogueId:voice.lineId,startMs:line.startMs,endMs:line.endMs,language:created.languages.target,characterId:null,text:voice.translations[created.languages.target],sourcePath:created.media.path};delete g.prosodyTransfer;delete g.takeOrigin;delete g.dubbingPipeline;patches.push({op:'add',path:'/generations/-',value:g},{op:'add',path:`/dialogues/${created.dialogues.findIndex((l)=>l.id===voice.lineId)}/selectedGenerationIds/${created.languages.target}`,value:g.id});}
 await call('studio_project_patch',{context:await context(),patches});
 const readyUntil=Date.now()+30000;while(!(await call('studio_get_state')).playback.ready){assert(Date.now()<readyUntil,'Group video did not become ready');await new Promise(r=>setTimeout(r,100));}
 await call('studio_playback',{action:'dub',lineId:line.id});let played=false;const playUntil=Date.now()+15000;
 while(Date.now()<playUntil){const s=(await call('studio_get_state')).playback;if(s.playing&&s.selection?.selection.trackId==='dubbing'){played=true;break;}await new Promise(r=>setTimeout(r,50));}
 assert(played,'Parent did not audition the active child mix');await call('studio_playback',{action:'pause'});
 const output=path.join(projectRoot,'exports','overlapping-voices.mkv');await job(await call('studio_export_mkv',{context:await context(),output,options:{includeOriginal:false,sourceSubtitles:true,targetSubtitles:true,codec:'flac',allowIncomplete:true}}));assert((await fs.stat(output)).size>1000);
 const saved=await call('studio_get_project');await call('studio_open_project',{path:projectRoot});const reopened=await call('studio_get_project');assert.deepEqual(reopened.speakerDubbings,saved.speakerDubbings);assert.deepEqual(reopened.generations,saved.generations);console.log('SPEAKER_DUBBING_STAGE concurrent MKV export and reopen passed');
 // Applying both outputs to one destination must replace once then add, keeping both.
 const id2=await call('studio_separate_dialogue_speakers',{context:await context(),options:result.options});await job(id2);
 const routed=await call('studio_apply_speaker_separation_result',{context:await context(),id:id2,destinations:result.outputs.map((outputId)=>({outputId,trackId:null,role:'speech',mode:'replace'})),muteSource:false});
 const layers=routed.generations.filter((g)=>g.operationId===id2);assert.deepEqual(layers.map((g)=>g.mode),['replace','add']);assert.equal(layers[0].trackId,layers[1].trackId);
 await call('studio_history',{context:await context(),direction:'undo'});assert.deepEqual((await call('studio_get_project')).generations,reopened.generations);
 assert.equal(hash(await fs.readFile(path.join(projectRoot,before.media.path))),original);
 assert.equal(hash(await fs.readFile(path.join(projectRoot,seedPath))),hash(wave));
 await call('studio_open_project',{path:previousRoot});const previousAfter=await call('studio_get_project');
 for(const key of ['generations','sourceCues','targetCues','speakerDubbings'])assert.deepEqual(previousAfter[key],previous[key]);
 return {realMossFormer2Cpu:true,outputs:2,independentChildren:true,subtitlesAndPreviousTakesPreserved:true,parentGroupPlayback:true,concurrentMkvExport:true,replaceThenAdd:true,undoAndReopen:true,sourceMovieUnchanged:true};
}
