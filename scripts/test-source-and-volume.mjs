// Real packaged desktop, native WAV processing and original-language Whisper.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export async function verifySourceAndVolume({call,context,args,baseId,projectRoot}) {
 const before=await call('studio_get_project'),g=before.generations.find(g=>g.id===baseId);
 const dry=await fs.readFile(path.join(projectRoot,g.path)),hash=b=>createHash('sha256').update(b).digest('hex');
 const ffmpeg=path.join(path.dirname(args.exe),'binaries','ffmpeg.exe');
 const pcm=file=>new Float32Array(Uint8Array.from(execFileSync(ffmpeg,['-v','error','-i',file,'-ac','1','-ar','24000','-f','f32le','pipe:1'],{maxBuffer:32*1024*1024})).buffer);
 const rms=v=>Math.sqrt(v.reduce((sum,x)=>sum+x*x,0)/v.length);
 const values=[];
 // Baseline retains any existing local editing before changing global gain.
 const baseEdit=before.voiceEdits?.[baseId];
 const baseFile=await call('studio_generation_path',{id:baseId,edit:baseEdit??null});const baseline=pcm(baseFile);
 for(const gain of [1.5,1.75,0,1]) {
   const saved=await call('studio_set_voice_output_gain',{context:await context(),id:baseId,gain});
   assert.equal(saved.formatVersion,22);assert.deepEqual(saved.generations,before.generations);
   const rendered=await call('studio_generation_path',{id:baseId,edit:saved.voiceEdits[baseId]});const samples=pcm(rendered);
   assert.equal(samples.length,baseline.length);assert(samples.every(x=>Math.abs(x)<.981));
   const ratio=rms(samples)/rms(baseline);assert(Math.abs(ratio-gain)<.008,{gain,ratio});
   if(baseEdit)assert.deepEqual(saved.voiceEdits[baseId].pieces,baseEdit.pieces);
   assert.equal(hash(await fs.readFile(path.join(projectRoot,g.path))),hash(dry));values.push({gain,ratio,frames:samples.length});
 }
 await call('studio_history',{context:await context(),direction:'undo'});assert.equal((await call('studio_get_project')).voiceEdits[baseId].outputGain,0);
 await call('studio_history',{context:await context(),direction:'redo'});await call('studio_open_project',{path:projectRoot});assert.equal((await call('studio_get_project')).voiceEdits[baseId].outputGain,undefined);
 // Fresh project to exercise the complete audio extraction -> ASR -> proposal -> accept flow.
 const name='Source ASR 日本語',movie=path.join(args['test-root'],'source-asr.mp4');
 const fixture=path.resolve('.cache/reference-transcription/Référence 日本語/ja.wav');
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=size=160x120:rate=25:duration=14','-i',fixture,'-map','0:v','-map','1:a','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest','-y',movie]);
 await call('studio_create_project',{parentPath:args['test-root'],name,source:'ja',target:'fr'});
 const wait=async id=>{const until=Date.now()+600000;while(Date.now()<until){const j=(await call('studio_list_jobs')).find(j=>j.id===id);if(j?.status==='succeeded')return j;if(j&&['failed','cancelled','interrupted'].includes(j.status))throw Error(JSON.stringify(j));await new Promise(r=>setTimeout(r,400));}throw Error('ASR deadline');};
 await wait(await call('studio_import_media',{context:await context(),path:movie,audioStreamIndex:1,forceProxy:false}));
 const asrRoot=path.join(args['test-root'],name+'.dubproject');
 for(const [role,text] of [['source','誤った字幕。'],['target','Une traduction conservée.']]){const file=path.join(args['test-root'],`asr-${role}.srt`);await fs.writeFile(file,`1\n00:00:00,000 --> 00:00:10,000\n${text}\n`);await call('studio_import_subtitles',{context:await context(),path:file,role});}
 const prior=await call('studio_get_project'),lineId=prior.dialogues[0].id;
 const id=await call('studio_transcribe_dialogue_source',{context:await context(),options:{lineId,language:'ja',trackId:'original'}});
 await wait(id);assert.equal(await call('studio_latest_source_transcription',{lineId}),id);
 const proposal=await call('studio_source_transcription_result',{id});assert(!proposal.stale);assert(proposal.segments[0].text.includes('中学'),JSON.stringify(proposal));assert(!proposal.segments[0].noSpeech);
 assert.deepEqual((await call('studio_get_project')).sourceCues,prior.sourceCues);
 const applied=await call('studio_apply_source_transcription',{context:await context(),id,texts:proposal.segments.map(s=>s.text)});assert.equal(applied.sourceCues[0].id,prior.sourceCues[0].id);assert.equal(applied.sourceCues[0].endMs,10000);assert.deepEqual(applied.targetCues,prior.targetCues);assert.deepEqual(applied.generations,prior.generations);
 let stale=false;try{await call('studio_apply_source_transcription',{context:await context(),id,texts:['stale']});}catch(e){stale=String(e).includes('STALE_REVISION');}assert(stale);
 await call('studio_history',{context:await context(),direction:'undo'});assert.deepEqual((await call('studio_get_project')).sourceCues,prior.sourceCues);await call('studio_open_project',{path:asrRoot});assert.deepEqual((await call('studio_get_project')).sourceCues,prior.sourceCues);
 return {realGainRenders:values,originalHash:hash(dry),allExistingTakesPreserved:true,undoRedoAndReopen:true,realJapaneseAsr:proposal.segments[0].text,sourceTimingPreserved:true,proposalOnlyUntilAccepted:true,staleRejected:true};
}
