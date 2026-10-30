import { type Page } from '@playwright/test';
import { demoProject } from '../../src/domain/project';
import type { Project } from '../../src/domain/types';
import fs from 'node:fs/promises';
export function wav(seconds=16) {
  const samples=48000*seconds,bytes=Buffer.alloc(44+samples*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*4,40);
  for(let i=0;i<samples;i++){const value=Math.round(Math.sin(i/48000*440*2*Math.PI)*1000);bytes.writeInt16LE(value,44+i*4);bytes.writeInt16LE(value,46+i*4);}return bytes;
}
export async function nativeMock(page: Page, large = false, seededProject?: Project) {
  // Read the fixture before navigation: a cold Windows filesystem read must
  // not hold the intercepted media response behind the readiness assertion.
  const previewData=await fs.readFile('public/demo.mp4');
  await page.route('**/preview.mp4',async route=>{
    const data=previewData,range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    if(range){const start=Number(range[1]),end=Math.min(data.length-1,range[2]?Number(range[2]):data.length-1);await route.fulfill({status:206,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${data.length}`},body:data.subarray(start,end+1)});}
    else await route.fulfill({status:200,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'},body:data});
  });
  await page.route('**/*.wav',async route=>{
    const data=wav(/reference-source/.test(route.request().url())?60:/\/(speech|music|sfx)\.wav$/.test(new URL(route.request().url()).pathname)?16:4);
    const range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    if(range){const start=Number(range[1]),end=Math.min(data.length-1,range[2]?Number(range[2]):data.length-1);await route.fulfill({status:206,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${data.length}`},body:data.subarray(start,end+1)});}
    else await route.fulfill({status:200,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes'},body:data});
  });
  await page.addInitScript(({initial})=>{
    const host=window as unknown as Record<string,any>,callbacks=new Map<number,(data:any)=>void>(),listeners=new Map<string,number>();let counter=0,project=JSON.parse(localStorage.getItem('nativeMockProject')||'null')||structuredClone(initial),job:any;
    const emit=(name:string,payload:any)=>{const id=listeners.get(name);if(id)callbacks.get(id)?.({event:name,id,payload});};
    host.__completeSpeakerSeparation=()=>{job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__timedJob=(value:any)=>{job=structuredClone(value);emit('job-changed',job);};
    host.__completeEffects=()=>{
      if(job.status==='cancelled')return;
      const o=host.__pendingEffects,id=crypto.randomUUID(),relative=`stems/patch-${id}.wav`;
      undoStack.push(structuredClone(project));project.formatVersion=Math.max(18,project.formatVersion);
      const old=project.generations.find((g:any)=>g.kind==='audioEffects'&&g.trackId===o.trackId);
      if(o.scope==='track'&&old){project.tracks.find((t:any)=>t.id===o.trackId).path=relative;old.path=relative;old.effects=o.effects;}
      else if(o.scope==='track'){
        const source=project.tracks.find((t:any)=>t.id===o.trackId),before=source.mute;
        project.tracks.push({...structuredClone(source),id,kind:'audio',path:relative,name:o.name,durationMs:project.media.durationMs,sourcePath:project.media.path,mute:!o.replaceInMix});
        if(o.replaceInMix)source.mute=true;
        project.generations.push({kind:'audioEffects',id,trackId:id,sourceTrackId:o.trackId,path:relative,sourcePath:project.media.path,sourceMuteBefore:before,replaceInMix:o.replaceInMix,effects:o.effects,effectsSourcePath:`stems/patch-${id}-dry.wav`});
      }else{
        const previous=project.generations.find((g:any)=>g.kind==='audioPatch'&&g.operation==='effects'&&g.trackId===o.trackId&&g.startMs===o.startMs&&g.endMs===o.endMs);
        project.generations=project.generations.filter((g:any)=>g!==previous);
        project.generations.push({kind:'audioPatch',id,operationId:id,operation:'effects',sourcePath:project.media.path,sourceTrackId:o.trackId,trackId:o.trackId,startMs:o.startMs,endMs:o.endMs,mode:'replace',path:relative,gain:1,effects:o.effects,effectsSourcePath:previous?.effectsSourcePath??`stems/patch-${id}-dry.wav`});
      }
      project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));
      job={...job,status:'succeeded',stage:'done',progress:1,timing:{elapsedMs:1250,observedAtMs:Date.now()}};emit('job-changed',job);
    };
    host.__calls=[];host.__downloadError=false;host.__installed=false;
    host.__getMockProject=()=>structuredClone(project);
    let mcpEnabled=localStorage.getItem('mockMcpEnabled')==='true';const mcpRequests=new Map<string,any>(),mcpAudit:any[]=[];
    host.__mcpReady=false;host.__mcpIds=[];
    host.__mcp=(tool:string,args:any={})=>new Promise(resolve=>{
      if(!mcpEnabled||!host.__mcpReady){resolve({error:'MCP_DISABLED'});return;}
      const id=crypto.randomUUID();host.__mcpIds.push(id);
      mcpRequests.set(id,{id,tool,arguments:structuredClone(args),resolve,claimed:false});mcpAudit.unshift({id,tool,status:'queued'});emit('mcp-request',id);
    });
    host.__mcpCancel=(id:string)=>{const row=mcpRequests.get(id);if(row){row.resolve({error:'MCP_CANCELLED'});mcpRequests.delete(id);}};
    let lips:any=null;
    host.__llmReady=true;
    const sourceAsrRows:any[]=JSON.parse(localStorage.getItem('mockSourceAsr')||'[]');
    const sourceBasis=(lineId:string)=>{const l=project.dialogues.find((l:any)=>l.id===lineId);return {projectId:project.id,lineId,sourceLanguage:project.languages.source,sourcePath:project.media.path,startMs:l.startMs,endMs:l.endMs,slots:l.sourceCueIds.length?l.sourceCueIds.map((id:string)=>{const c=project.sourceCues.find((c:any)=>c.id===id);return {cueId:c.id,startMs:c.startMs,endMs:c.endMs,text:c.text};}):[{cueId:null,startMs:l.startMs,endMs:l.endMs,text:''}]};};
    host.__completeSourceTranscription=(texts=['日本語の訂正。'],noSpeech=false)=>{if(job.status==='cancelled')return;const row=sourceAsrRows.find((r:any)=>r.id===job.id);row.segments=row.basis.slots.map((s:any,i:number)=>({text:noSpeech?s.text:(texts[i]??texts[0]),noSpeech}));localStorage.setItem('mockSourceAsr',JSON.stringify(sourceAsrRows));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};

    const proposals:any[]=JSON.parse(localStorage.getItem('nativeMockProposals')||'[]');
    host.__completeTranslation=(translations=['Une traduction proposée.'])=>{if(job.status==='cancelled')return;const row=proposals.find((p:any)=>p.id===job.id);row.result={basis:row.basis,translations,direction:row.direction??'',model:'Qwen3-4B-Instruct-2507 · GGUF Q4_K_M'};localStorage.setItem('nativeMockProposals',JSON.stringify(proposals));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__completeTranslationInstall=()=>{host.__llmReady=true;job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__inpaintReady=true;
    host.__completeFaceDetection=(ambiguous=false)=>{
      if(job.status==='cancelled')return;
      const s=host.__pendingFaceDetection.selection;
      const rows=project.dialogues.filter((l:any)=>(s.scope!=='selected'||s.lineIds.includes(l.id))&&l.selectedGenerationIds.fr&&!s.crops[l.id]);
      host.__faceResult={projectId:project.id,sourcePath:project.media.path,items:rows.map((l:any,i:number)=>({lineId:l.id,generationId:l.selectedGenerationIds.fr,fingerprint:'a'.repeat(64),crop:ambiguous&&i>0?null:{face:{x:.15,y:.1,width:.5,height:.8},endX:.15,endY:.1,mask:{x:.2,y:.55,width:.6,height:.4}},reason:ambiguous&&i>0?'FACE_MULTIPLE':null}))};
      job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);
    };
    host.__multilineCards=()=>{
      for(let i=0;i<project.sourceCues.length;i++)project.sourceCues[i].text=Array.from({length:i%5+1},(_,n)=>'ほらね　みんな今　私が死んだら悲しいって思ったでしょ？ '+n).join('\n');
      for(let i=0;i<project.targetCues.length;i++)project.targetCues[i].text=Array.from({length:i%7+1},(_,n)=>'Tu vois ? Tu as eu de la peine à l’idée que j’allais mourir, non ? '+n).join('\n');
      project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));
    };
    const lipBatchPlan=(s:any)=>{
      const r:any={requested:0,undubbed:0,existing:0,missingCrop:0,ready:[],blocked:[]};
      for(const l of project.dialogues){if(s.scope==='selected'&&!s.lineIds.includes(l.id))continue;r.requested++;
        const g=project.generations.find((g:any)=>g.kind==='tts'&&g.id===l.selectedGenerationIds.fr);if(!g){r.undubbed++;continue;}
        const variants=project.generations.filter((v:any)=>v.kind==='lipVideo'&&v.dialogueId===l.id);
        if(!s.force&&variants.some((v:any)=>v.generationId===g.id)){r.existing++;continue;}
        if(!s.crops[l.id]&&!(s.useSavedCrops&&variants.length)&&!s.useCommonCrop){r.missingCrop++;continue;}
        if(Math.min(g.durationMs,l.endMs-l.startMs)>(s.options.modelId?.startsWith('latentsync-')?120000:10000)){r.blocked.push({lineId:l.id,error:'INPAINT_WINDOW_INVALID'});continue;}
        r.ready.push(l.id);
      }return r;
    };
    const lipBatchUpdate=()=>{const rows=host.__lipRows,done=rows.filter((r:any)=>r.status!=='pending').length,succeeded=rows.filter((r:any)=>r.status==='succeeded').length,failed=done-succeeded;job={...job,kind:'inpaintBatch',status:done===rows.length?(failed?'failed':'succeeded'):'running',stage:done===rows.length?'done':'inpaintBatch',progress:null,error:failed?'INPAINT_BATCH_PARTIAL':null,batch:{total:rows.length,completed:done,succeeded,failed,skipped:host.__lipSkipped,currentLineId:rows.find((r:any)=>r.status==='pending')?.id??null}};emit('job-changed',job);};
    host.__advanceLipBatch=(error:string|null=null)=>{
      if(job.status==='cancelled')return;
      const row=host.__lipRows.find((r:any)=>r.status==='pending');if(!row)return;
      if(!error){const before=structuredClone(job),s=host.__pendingLipBatch,line=project.dialogues.find((l:any)=>l.id===row.id),saved=project.generations.filter((v:any)=>v.kind==='lipVideo'&&v.dialogueId===row.id).at(-1);
        host.__pendingInpaint={...s.options,...(s.crops[row.id]??(s.useSavedCrops?saved?.options:null)),lineId:row.id,generationId:line.selectedGenerationIds.fr};host.__completeInpaint();
        if(s.activate){const v=project.generations.at(-1);for(const g of project.generations)if(g.kind==='lipVideo'&&g.dialogueId===row.id)g.enabled=g.id===v.id;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));}
        job=before;row.status='succeeded';
      }else row.status='failed';lipBatchUpdate();
    };
    host.__latentReady=JSON.parse(localStorage.getItem('nativeMockLatentReady')||'{}');
    host.__completeInpaintInstall=()=>{host.__latentReady[host.__pendingInpaintInstall]=true;localStorage.setItem('nativeMockLatentReady',JSON.stringify(host.__latentReady));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__seedLipVariants=()=>{project.formatVersion=Math.max(13,project.formatVersion);for(const line of project.dialogues){const take=project.generations.find((g:any)=>g.id===line.selectedGenerationIds.fr);if(!take)continue;const id=`lip-${project.generations.filter((g:any)=>g.kind==='lipVideo').length+1}`;project.generations.push({kind:'lipVideo',id,dialogueId:line.id,generationId:take.id,sourcePath:project.media.path,language:'fr',path:`generations/lips-${id}.mp4`,startMs:line.startMs,durationMs:2000,slotMs:Math.min(line.endMs-line.startMs,project.dialogues.find((l:any)=>l.startMs>line.startMs)?.startMs-line.startMs||999999),exactDuration:false,fingerprint:'a'.repeat(64),enabled:true,options:{modelId:'latentsync-16',inferenceSteps:20,guidanceScale:1.5,lineId:line.id,generationId:take.id,device:'cuda:0',face:{x:.1,y:.1,width:.5,height:.8},endX:.1,endY:.1,mask:{x:.2,y:.6,width:.6,height:.3},feather:.12,blend:1,style:'live',seed:0},createdAt:new Date().toISOString(),modelRevision:'mock'});}project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));};
    host.__longInpaint=()=>{const line=project.dialogues[0];project.media.durationMs=60000;project.dialogues=[line];line.endMs=line.startMs+20000;for(const c of [...project.sourceCues,...project.targetCues])if([...line.sourceCueIds,...line.targetCueIds].includes(c.id))c.endMs=line.endMs;project.generations.find((g:any)=>g.id===line.selectedGenerationIds.fr).durationMs=20000;project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));};
    host.__completeInpaint=()=>{if(job.status==='cancelled')return;const o=host.__pendingInpaint,line=project.dialogues.find((l:any)=>l.id===o.lineId),take=project.generations.find((g:any)=>g.id===o.generationId),offset=project.dubbingTiming?.offsetsMs?.[line.id]?.fr??0,startMs=line.startMs+offset,slotMs=project.dubbingTiming?.durationsMs?.[line.id]?.fr??line.endMs-line.startMs,exactDuration=project.dubbingTiming?.durationsMs?.[line.id]?.fr!=null;undoStack.push(structuredClone(project));project.formatVersion=Math.max(project.formatVersion,o.modelId?.startsWith('latentsync-')?13:8);project.generations.push({kind:'lipVideo',id:`lip-${project.generations.filter((g:any)=>g.kind==='lipVideo').length+1}`,dialogueId:line.id,generationId:take.id,sourcePath:project.media.path,language:'fr',path:`generations/lips-lip-${project.generations.filter((g:any)=>g.kind==='lipVideo').length+1}.mp4`,startMs,durationMs:Math.floor(Math.min(slotMs,exactDuration?slotMs:take.durationMs)/40)*40,slotMs,exactDuration,fingerprint:'a'.repeat(64),enabled:false,options:o,createdAt:new Date().toISOString(),modelRevision:'mock'});project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__completeTransfer=()=>{if(job.status==='cancelled')return;const o=host.__pendingTransfer,operationId=crypto.randomUUID();undoStack.push(structuredClone(project));project.formatVersion=Math.max(8,project.formatVersion);const add=(trackId:string,sourceTrackId:string,mode:string)=>{const id=crypto.randomUUID();project.generations.push({kind:'audioPatch',id,operationId,operation:o.operation,sourcePath:project.media.path,trackId,sourceTrackId,startMs:o.startMs,endMs:o.endMs,mode,path:mode==='silence'?null:`stems/patch-${id}.wav`,gain:1});};add(o.targetTrackId,o.sourceTrackId,o.operation==='swap'?'replace':'add');if(o.operation!=='copy')add(o.sourceTrackId,o.targetTrackId,o.operation==='swap'?'replace':'silence');project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__longFilm=()=>{project.media.durationMs=7200000;for(const item of [...project.sourceCues,...project.targetCues,...project.dialogues]){item.startMs+=3600000;item.endMs+=3600000;}project.revision++;emit('project-changed',structuredClone(project));localStorage.setItem('nativeMockProject',JSON.stringify(project));};
    host.__completeLips=(reliable=true)=>{if(job.status==='cancelled')return;lips.result={projectId:project.id,revision:lips.revision,sourcePath:project.media.path,language:project.languages.target,options:lips.options,startMs:1000,durationMs:2500,score:.9,currentScore:.52,reliable,warnings:reliable?[]:['lipsAmbiguous'],stepMs:40,mouth:Array.from({length:100},(_,i)=>i>20&&i<80?.4+(i%6)/10:0),voice:Array.from({length:50},(_,i)=>i%6<4?1:0)};job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__changeDuringLips=()=>{project.dialogues[0].ttsText='Correction manuelle';project.revision++;emit('project-changed',structuredClone(project));localStorage.setItem('nativeMockProject',JSON.stringify(project));};
    const undoStack:any[]=[],redoStack:any[]=[];
    host.__moveFirstDubbing=(offset:number)=>{project.formatVersion=Math.max(7,project.formatVersion);project.dubbingTiming={sourcePath:project.media.path,offsetsMs:{[project.dialogues[0].id]:{fr:offset}}};project.revision++;emit('project-changed',structuredClone(project));localStorage.setItem('nativeMockProject',JSON.stringify(project));};
    host.__ttsReady=true;host.__pendingTts=null;
    host.__clearTranslation=(index:number)=>{const line=project.dialogues[index];for(const cue of project.targetCues)if(line.targetCueIds.includes(cue.id))cue.text='';line.ttsText='Pronunciation alone';project.revision++;emit('project-changed',structuredClone(project));localStorage.setItem('nativeMockProject',JSON.stringify(project));};
    const batchPlan=(selection:any)=>{
      const result:any={requested:0,untranslated:0,unapproved:0,approved:0,existing:0,ready:[],blocked:[]};
      if(selection.approvedOnly&&selection.unapprovedOnly)throw Error('INVALID_TTS_BATCH');
      for(const line of project.dialogues){if(selection.scope==='selected'&&!selection.lineIds.includes(line.id))continue;result.requested++;
        const translation=project.targetCues.filter((c:any)=>line.targetCueIds.includes(c.id)).map((c:any)=>c.text).join('\n').replace(/<[^>]*>/g,'').trim();if(!translation){result.untranslated++;continue;}
        const a=project.translationApprovals?.[line.id],source=project.sourceCues.filter((c:any)=>line.sourceCueIds.includes(c.id)).map((c:any)=>c.text).join('\n'),target=project.targetCues.filter((c:any)=>line.targetCueIds.includes(c.id)).map((c:any)=>c.text).join('\n');
        const approved=!!a&&a.sourceLanguage===project.languages.source&&a.targetLanguage===project.languages.target&&a.sourceText===source&&a.targetText===target;
        if(selection.approvedOnly&&!approved){result.unapproved++;continue;}
        if(selection.unapprovedOnly&&approved){result.approved++;continue;}
        const generation=project.generations.find((g:any)=>g.id===line.selectedGenerationIds.fr&&g.text===(line.ttsText??translation));if(generation&&!selection.force){result.existing++;continue;}
        const o=selection.options,reference=o.referenceMode==='file'?project.voiceReferences?.find((r:any)=>r.id===o.referenceId):project.characters.find((c:any)=>c.id===line.characterId)?.references[0];
        if(o.referenceMode!=='current'&&!reference){result.blocked.push({lineId:line.id,error:'TTS_REFERENCE_REQUIRED'});continue;}
        if(o.mode==='zeroShot'&&o.referenceMode!=='current'&&!reference?.transcript.trim()){result.blocked.push({lineId:line.id,error:'TTS_TRANSCRIPT_REQUIRED'});continue;}
        result.ready.push(line.id);
      }return result;
    };
    const batchJobUpdate=()=>{const rows=host.__batchRows,done=rows.filter((r:any)=>r.status!=='pending').length,succeeded=rows.filter((r:any)=>r.status==='succeeded').length,failed=rows.filter((r:any)=>r.status==='failed').length;job={...job,kind:'ttsBatch',status:done===rows.length?(failed?'failed':'succeeded'):'running',stage:done===rows.length?'done':'ttsGenerate',error:done===rows.length&&failed?'TTS_BATCH_PARTIAL':null,progress:null,batch:{total:rows.length,completed:done,succeeded,failed,skipped:host.__batchSkipped,currentLineId:rows.find((r:any)=>r.status==='pending')?.id??null}};emit('job-changed',job);};
    host.__advanceBatch=(error:string|null=null)=>{if(job.status==='cancelled')return;const row=host.__batchRows.find((r:any)=>r.status==='pending');if(!row)return;
      if(!error){const before=structuredClone(job);host.__pendingTts={lineId:row.id,options:host.__pendingBatch.options};host.__completeTts();job=before;row.status='succeeded';}else row.status='failed';batchJobUpdate();};
    host.__completeTts=(durationMs=2000)=>{
      const {lineId,options}=host.__pendingTts,line=project.dialogues.find((d:any)=>d.id===lineId),id=`take-${project.generations.filter((g:any)=>g.kind==='tts').length+1}`;
      const text=line.ttsText??project.targetCues.filter((c:any)=>line.targetCueIds.includes(c.id)).map((c:any)=>c.text).join('\n');
      const generation={id,kind:'tts',dialogueId:lineId,providerId:options.variantId==='drama3-comfy-fp8'?'fish-drama3':options.variantId?.startsWith('fish')?'fish-s2':options.variantId?.startsWith('qwen')?'qwen3-tts':'cosyvoice3',modelId:options.variantId??'cosy3-official',path:`generations/${id}.wav`,createdAt:new Date().toISOString(),sourcePath:project.media.path,startMs:line.startMs,endMs:line.endMs,text,language:project.languages.target,characterId:line.characterId,durationMs,sampleRate:24000,options,referenceTranscript:'Hello',device:options.device,deviceName:'NVIDIA RTX 5060 Ti (simulation)',peakVramMb:0,inputHash:'mock'};
      if(options.outputGain!==undefined&&options.outputGain!==1){project.formatVersion=Math.max(22,project.formatVersion);(project.voiceEdits??={})[id]={outputGain:options.outputGain,pieces:[{sourceStartMs:0,sourceEndMs:durationMs,durationMs,gain:1}]};}
      project.generations.push(generation);project.formatVersion=Math.max(project.formatVersion,['voxcpm2-bf16','chatterbox-multilingual-v3'].includes(options.variantId)?16:5,options.mood&&options.mood!=='default'?(['angry','happy','sad','calm','surprised','whisper'].includes(options.mood)?7:15):5);line.selectedGenerationIds[project.languages.target]=id;line.status=durationMs>line.endMs-line.startMs?'review':'generated';project.revision++;emit('project-changed',structuredClone(project));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);localStorage.setItem('nativeMockProject',JSON.stringify(project));
    };
    host.__completePipeline=()=>{const o=host.__pendingPipeline,stages=[];host.__pendingTts={lineId:o.lineId,options:o.tts};host.__completeTts();stages.push(project.generations.at(-1).id);if(o.guideStrength>0){host.__completeTts();stages.push(project.generations.at(-1).id);}host.__completeTts();stages.push(project.generations.at(-1).id);project.formatVersion=Math.max(23,project.formatVersion);project.generations.at(-1).dubbingPipeline={engine:'chatterbox-vc',settings:o,stageIds:stages};project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));};
    host.__completeDerived=(order='settle')=>{
      if(['cancelled','failed'].includes(job.status))return;
      const prosody=job.kind==='prosodyTransfer',o=prosody?host.__pendingProsody:host.__pendingConversion;
      const source=project.generations.find((g:any)=>g.id===o.generationId),id=crypto.randomUUID();
      const derived={...structuredClone(source),id,path:`generations/${id}.wav`,createdAt:new Date().toISOString()};
      if(prosody){derived.prosodyTransfer={algorithm:'praat-psola-v1',sourceGenerationId:source.id,sourceDurationMs:source.durationMs,guideDurationMs:source.durationMs,options:structuredClone(o)};delete derived.dubbingPipeline;}
      else {derived.takeOrigin={type:'conversion',sourceGenerationId:source.id,referenceId:o.referenceId,characterId:o.characterId};delete derived.dubbingPipeline;}
      project.generations.push(derived);project.formatVersion=Math.max(project.formatVersion,prosody?14:17);project.dialogues.find((l:any)=>l.id===source.dialogueId).selectedGenerationIds[project.languages.target]=id;project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));host.__lastDerivedId=id;
      host.__flushDerivedProject=()=>emit('project-changed',structuredClone(project));
      host.__finishDerivedJob=()=>{job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
      if(order==='jobFirst')host.__finishDerivedJob();
      else if(order==='projectFirst')host.__flushDerivedProject();
      else {host.__flushDerivedProject();host.__finishDerivedJob();}
    };
    host.__failPanelJob=(error='PROSODY_RENDER_FAILED')=>{job={...job,status:'failed',error,logs:[error]};emit('job-changed',job);};
    host.__completeToolbox=()=>{job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__seedReference=(transcript='',custom=false)=>{
      const references=[{id:'reference-ja',label:'Japanese voice',path:'characters/reference-ja.wav',durationMs:7000,transcript,sourceDialogueId:null}];
      if(custom)references.push({...references[0],id:'reference-custom',label:'Alternate voice',path:'characters/reference-custom.wav'});
      project.characters=[{id:'speaker-ja',name:'Taro',color:'#b49ce6',references,defaultReferenceId:'reference-ja'}];project.dialogues[0].characterId='speaker-ja';
      project.modelPreferences={ttsProviderId:'fish-s2',voiceVariantId:'fish-s2-fp8'};
      project.dialogues[0].voiceSettings={variantId:'fish-s2-fp8',device:'cuda:0',referenceMode:custom?'custom':'character',referenceId:custom?'reference-custom':null,mode:'crossLingual',speed:1,seed:0};
      project.formatVersion=Math.max(5,project.formatVersion);project.revision++;emit('project-changed',structuredClone(project));localStorage.setItem('nativeMockProject',JSON.stringify(project));
    };
    host.__completeTranscription=(text='彼の名前は坂本太郎です。')=>{
      if(job.status==='cancelled')return;
      const {characterId,referenceId}=host.__pendingTranscription;
      (characterId?project.characters.find((c:any)=>c.id===characterId).references:project.voiceReferences).find((r:any)=>r.id===referenceId).transcript=text;
      project.revision++;emit('project-changed',structuredClone(project));localStorage.setItem('nativeMockProject',JSON.stringify(project));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);
    };
    host.__failTranscription=()=>{job={...job,status:'failed',error:'ASR_EMPTY_AUDIO'};emit('job-changed',job);};
    host.__replaceMedia=()=>{project.media.id+='-replacement';project.tracks.find((track:any)=>track.kind==='original').mute=true;project.revision++;emit('project-changed',structuredClone(project));};
    host.__setFirstSlot=(endMs:number)=>{project.dialogues[0].endMs=endMs;project.revision++;emit('project-changed',structuredClone(project));};
    host.__seedDubbing=()=>{job={id:'tts-seed',projectId:project.id,kind:'tts',status:'running',stage:'ttsGenerate',progress:null,logs:[],error:null};for(const line of project.dialogues){host.__pendingTts={lineId:line.id,options:{variantId:'cosy3-official',device:'cpu',referenceMode:'current',referenceId:null,mode:'crossLingual',speed:1,seed:7}};host.__completeTts(2000);}};
    host.__completeModelMove=()=>{host.__modelFolder=host.__pendingModelFolder;job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};

    host.__completeCharacterMatch=(reason='matched')=>{host.__characterProposal={lineId:host.__pendingCharacterMatch.lineId,candidates:reason==='tooShortOrNoSpeech'?[]:project.characters.slice(0,2).map((c:any,i:number)=>({characterId:c.id,score:reason==='matched'?.95-i*.3:.9-i*.01})),reason,reliable:reason==='matched'};job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__completeLibrary=()=>{
      if(job.status==='cancelled')return;undoStack.push(structuredClone(project));const o=host.__pendingLibrary,lib=project.characterProfiles[o.characterId].voiceLibrary;
      for(const phrase of o.phrases){const id=crypto.randomUUID();lib.samples.push({id,sourceId:o.sourceId,reference:{id,label:phrase.label,path:`characters/voice-library/sample-${id}.wav`,durationMs:6000,transcript:phrase.text},text:phrase.text,mood:phrase.mood,status:'pending',options:{...o.options,mood:phrase.mood},sha256:'b'.repeat(64),createdAt:new Date().toISOString(),deviceName:'CPU (simulation)'});}
      project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);
    };
    host.__speakerStatus={installed:true,installing:false,sizeBytes:72500000};
    host.__completeSpeakerAnalysis=()=>{const scope=host.__pendingSpeakerScope,lines=project.dialogues.filter((l:any)=>scope?.startMs===undefined||(l.startMs<scope.endMs&&l.endMs>scope.startMs)),guided=scope?.referenceCharacterId;project.formatVersion=Math.max(20,project.formatVersion);project.speakerAnalysis={id:'speakers',sourcePath:project.media.path,scope:scope??{},audioSnapshot:{tracks:structuredClone(project.tracks),patches:project.generations.filter((g:any)=>['audioPatch','audioEffects'].includes(g.kind)),references:guided?project.characters.filter((c:any)=>c.id===guided).map((c:any)=>({id:c.id,references:structuredClone(c.references)})):[]},originalAssignments:Object.fromEntries(lines.map((l:any)=>[l.id,l.characterId])),lines:lines.map(({id,startMs,endMs}:any)=>({id,startMs,endMs})),assignments:lines.map((line:any,index:number)=>({dialogueId:line.id,speaker:guided?0:index%2,similarity:0.95,reason:'identified'})),clusters:(guided?[0]:[0,1].slice(0,lines.length)).map((speaker)=>({speaker,...(guided?{characterId:guided}:{}),referencePath:`characters/reference-${speaker}.wav`,durationMs:4000,referenceDialogueId:lines[speaker].id,vocalRegister:{medianHz:180+speaker*80,confidence:.86,analyzedMs:2500}}))};project.revision++;emit('project-changed',structuredClone(project));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    const localResults=new Map<string,any>();
    host.__completeLocalSeparation=()=>{if(job.status==='cancelled')return;job={...job,status:'succeeded',stage:'localSeparationPreview',progress:1};emit('job-changed',job);};
    host.__runtimeStatus={installed:true,installing:false,devices:[{id:'cpu',name:'CPU'},{id:'cuda:0',name:'NVIDIA GPU'}],cudaVersion:'12.8',unavailableDevices:[]};
    host.__probeRuntime=()=>{job={...job,stage:'devicesCheck',progress:null,logs:['Model verified. Checking compute devices (maximum 30 seconds).']};emit('job-changed',job);};
    host.__completeRuntime=()=>{host.__runtimeStatus={installed:true,installing:false,devices:host.__probeFailed?[{id:'cpu',name:'CPU'}]:[{id:'cpu',name:'CPU'},{id:'cuda:0',name:'NVIDIA GeForce RTX 5060 Ti'}],deviceProbeWarning:host.__probeFailed?'DEVICE_PROBE_FAILED':null,cudaVersion:'12.8',unavailableDevices:[]};job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__completeSeparation=()=>{project.formatVersion=Math.max(2,project.formatVersion);project.tracks.find((track:any)=>track.kind==='original').mute=true;for(const role of ['speech','music','sfx'])project.tracks.push({id:role,kind:'audio',role,path:`stems/run/${role}.wav`,durationMs:16000,sourcePath:project.media.path,language:'en',gain:1,mute:false,solo:false});project.revision++;emit('project-changed',structuredClone(project));job={id:'separation',projectId:project.id,kind:'separation',logs:[],error:null,...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.isTauri=true;host.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
    host.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},convertFileSrc:(path:string)=>path.endsWith('.png')?`/${path}`:path.endsWith('.wav')?`/audio/${path.split('/').at(-1)}`:'/preview.mp4',transformCallback:(fn:(data:any)=>void)=>{const id=++counter;callbacks.set(id,fn);return id;},unregisterCallback:(id:number)=>callbacks.delete(id),invoke:async(command:string,args:any={},options:any={})=>{
      host.__calls.push({command,args:JSON.parse(JSON.stringify(args))});
      if(command==='translation_status')return {installed:host.__llmReady,modelName:'Qwen3-4B-Instruct-2507 · GGUF Q4_K_M',sizeBytes:2497280448,path:'F:/Models/translation-llm',availableBytes:host.__llmSpace??10*1024**3,requiredBytes:3066459326,enough:(host.__llmSpace??10*1024**3)>=3066459326,devices:[{id:'cpu',name:'CPU'},{id:'Vulkan0',name:'Ryzen iGPU'},{id:'Vulkan1',name:'NVIDIA RTX 5060 Ti (simulation)'}],warning:null};
      if(command==='install_translation_model'){job={id:'translation-install',projectId:'',kind:'translationInstall',status:'running',stage:'translationDownload',progress:.1,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='suggest_translation'){const line=project.dialogues.find((l:any)=>l.id===args.lineId),basis={projectId:project.id,lineId:line.id,sourceLanguage:project.languages.source,targetLanguage:project.languages.target,sourceText:line.sourceCueIds.map((id:string)=>project.sourceCues.find((c:any)=>c.id===id)?.text??'').join('\n'),targetText:line.targetCueIds.map((id:string)=>project.targetCues.find((c:any)=>c.id===id)?.text??'').join('\n'),sourceCueIds:[...line.sourceCueIds],targetCueIds:[...line.targetCueIds]};job={id:'translation-job-'+proposals.length,projectId:project.id,kind:'translationSuggest',status:'running',stage:'translationGenerate',progress:null,logs:[],error:null};proposals.push({id:job.id,basis,direction:args.direction??'',result:null});host.__pendingTranslation=structuredClone(args);emit('job-changed',job);return job.id;}
      if(command==='latest_translation')return proposals.filter((p:any)=>p.basis.lineId===args.lineId).at(-1)?.id??null;
      if(command==='translation_result')return proposals.find((p:any)=>p.id===args.id)?.result??null;
      if(command==='inpaint_status'&&host.__faceBusyInventory&&job?.kind==='faceDetection'&&job.status==='running')return {modelId:args.modelId||'musetalk-15-fp16',installed:true,sizeBytes:3885781230,space:{path:'F:/Models',availableBytes:40000000000,requiredBytes:0,enough:true},devices:[]};
      if(command==='inpaint_status'){const modelId=args.modelId||'musetalk-15-fp16';return {modelId,installed:modelId==='musetalk-15-fp16'?host.__inpaintReady:!!host.__latentReady[modelId],sizeBytes:modelId==='musetalk-15-fp16'?3885781230:5557939134,space:{path:'F:/Models/latentsync-runtime',availableBytes:host.__inpaintFree??40*1024**3,requiredBytes:20*1024**3,enough:(host.__inpaintFree??40*1024**3)>=20*1024**3},devices:[{id:'cuda:0',name:'RTX 5060 Ti (simulation)',memoryMb:16384}]};}
      if(command==='voice_install_space'){if(host.__spaceError)throw Error('disk unavailable');const modelBytes=args.variantId==='voxcpm2-bf16'?4960722408:args.variantId==='chatterbox-multilingual-v3'?3243411693:40144065412;return host.__dramaSpace??{path:'F:/Models/voice-engines',availableBytes:70*1024**3,requiredBytes:modelBytes+18*1024**3,modelBytes,downloadBytes:4*1024**3,runtimeBytes:12*1024**3,marginBytes:2*1024**3,enough:true};}
      if(command==='install_inpaint'){host.__pendingInpaintInstall=args.modelId||'musetalk-15-fp16';job={id:'inpaint-install',projectId:'',kind:'inpaintInstall',status:'running',stage:'inpaintDownload',progress:.1,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='inpaint_path'&&host.__failInpaintPath)throw Error('missing retouched sequence');
      if(command==='inpaint_path')return `generations/${args.id}.mp4`;
      if(command==='inpaint_lips'){host.__pendingInpaint=structuredClone(args.options);job={id:'inpaint-job',projectId:project.id,kind:'inpaint',status:'running',stage:'inpaintGenerate',progress:.2,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='audio_patch_path')return `stems/patch-${args.id}.wav`;
      if(command==='transfer_audio'){host.__pendingTransfer=structuredClone(args.options);job={id:'transfer-job',projectId:project.id,kind:'audioTransfer',status:'running',stage:'audioTransfer',progress:.2,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='restore_project')return structuredClone(project);
      if(command==='latest_lip_analysis')return lips?.options.lineId===args.lineId&&lips?.options.generationId===args.generationId?'lips-job':null;
      if(command==='analyze_lips'){lips={options:structuredClone(args.options),revision:project.revision,result:null};job={id:'lips-job',projectId:project.id,kind:'lipAnalysis',status:'running',stage:'lipsDecode',progress:.3,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='lip_analysis_result')return lips?.result??null;
      if(command==='voice_status')return {variants:Object.entries({'fish-s2-gguf-q8':6317911232,'qwen3-06b-gguf-q8':1991211136,'qwen3-17b-gguf-q8':2695175104,'fish-s2-fp8':8047624252,'drama3-comfy-fp8':40144065412,'voxcpm2-bf16':4960722408,'chatterbox-multilingual-v3':3243411693,'chatterbox-vc':1056484620}).map(([id,sizeBytes])=>({id,installed:id==='drama3-comfy-fp8'?host.__dramaReady!==false:['voxcpm2-bf16','chatterbox-multilingual-v3'].includes(id)?host.__multilingualReady!==false:true,sizeBytes})),devices:[{id:'vulkan:0',name:'Ryzen iGPU (simulation)'},{id:'vulkan:1',name:'RTX 5060 Ti (simulation)',discrete:true},{id:'cpu',name:'CPU'}],cudaDevices:[{id:'cuda:0',name:'RTX 5060 Ti (simulation)'}]};
        if(command==='install_voice_runtime')return 'install-voice';
        if(command==='prosody_status')return {available:true,version:'6.4.67',maxDurationMs:30000,experimental:true,device:'cpu'};
      if(command==='transfer_voice_prosody'){host.__pendingProsody=structuredClone(args.options);job={id:crypto.randomUUID(),projectId:project.id,kind:'prosodyTransfer',status:'running',stage:'prosodyAnalyze',progress:.2,logs:[],error:null};emit('job-changed',job);if(host.__instantDerived)host.__completeDerived();return job.id;}
      if(command==='speaker_separation_status')return {availableBytes:host.__speakerFree??40*1024**3,models:['mossformer2-16k','sepformer-2mix','sepformer-3mix'].map((id,i)=>({id,name:i===0?'MossFormer2 · 2 voix · 16 kHz':i===1?'SepFormer · 2 voix · 8 kHz':'SepFormer · 3 voix · 8 kHz',family:i===0?'mossformer2':'sepformer',installed:host.__speakerInstalled!==false,modelBytes:670000000,requiredBytes:12*1024**3,outputs:Array.from({length:i===2?3:2},(_,i)=>'voice-'+(i+1)),license:'Apache-2.0',source:'https://huggingface.co/'})),devices:[{id:'cpu',name:'CPU'},{id:'cuda:0',name:'RTX 5060 Ti (simulation)'}]};
      if(command==='install_speaker_separation_model'){host.__speakerInstalled=true;job={id:'speaker-install',projectId:'',kind:'speakerSeparationInstall',status:'succeeded',stage:'done',progress:1,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='separate_dialogue_speakers'){host.__speakerOptions=structuredClone(args.options);job={id:'separation-'+crypto.randomUUID(),projectId:project.id,kind:'speakerSeparation',status:'running',stage:'speakerSeparationRun',progress:.4,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='speaker_separation_result')return {id:args.id,options:host.__speakerOptions,outputs:host.__speakerOptions.modelId==='sepformer-3mix'?['voice-1','voice-2','voice-3']:['voice-1','voice-2'],stale:false,applied:false,commonGain:1,deviceName:'CPU (simulation)'};
      if(command==='speaker_separation_path')return 'C:/Studio/'+args.outputId+'.wav';
      if(command==='create_speaker_dubbings'){
        undoStack.push(structuredClone(project));const o=host.__speakerOptions,voices=args.assignments.map((a:any)=>{const lineId=crypto.randomUUID();project.dialogues.push({id:lineId,startMs:o.startMs,endMs:o.endMs,sourceCueIds:[],targetCueIds:[],ttsText:null,characterId:a.characterId,status:'ungenerated',warnings:[],selectedGenerationIds:{}});return {lineId,outputId:a.outputId,label:a.label,audioPath:'stems/isolated-'+crypto.randomUUID()+'.wav',sourceText:a.sourceText,translations:{[project.languages.target]:a.targetText}};});
        project.speakerDubbings??=[];for(const g of project.speakerDubbings)if(g.parentId===o.lineId)g.active=false;project.speakerDubbings.push({id:crypto.randomUUID(),parentId:o.lineId,separationId:args.id,modelId:o.modelId,sourcePath:project.media.path,sourceTrackId:o.sourceTrackId,startMs:o.startMs,endMs:o.endMs,createdAt:new Date().toISOString(),active:true,voices});project.formatVersion=25;project.revision++;emit('project-changed',structuredClone(project));return structuredClone(project);
      }
      if(command==='apply_speaker_separation_result'){host.__speakerDestinations=structuredClone(args);return structuredClone(project);}
      if(command==='audio_toolbox_status')return {availableBytes:host.__toolboxFree??30*1024**3,devices:[{id:'cpu',name:'CPU'},{id:'cuda:0',name:'RTX 5060 Ti (simulation)'}],models:['bs-roformer-viperx-1297','mel-band-roformer-kim','htdemucs','htdemucs-ft','audiosep'].map(id=>({id,name:({'bs-roformer-viperx-1297':'BS-RoFormer · Viperx 1297','mel-band-roformer-kim':'Mel-Band RoFormer · Kim',htdemucs:'Demucs v4 · htdemucs','htdemucs-ft':'Demucs v4 · htdemucs_ft',audiosep:'AudioSep'})[id],family:id==='audiosep'?'audiosep':id.startsWith('htdemucs')?'demucs':'roformer',installed:host.__toolboxInstalled!==false,modelBytes:900000000,requiredBytes:1200000000,outputs:id==='audiosep'?['isolated','residual']:id.startsWith('htdemucs')?['vocals','drums','bass','other']:['vocals','instrumental'],license:'Upstream model license',source:'https://github.com/Audio-AGI/AudioSep'}))};
      if(command==='generate_dubbing_pipeline'){host.__pendingPipeline=structuredClone(args.options);host.__pendingTts={lineId:args.options.lineId,options:args.options.tts};job={id:'pipeline-job',projectId:project.id,kind:'ttsPipeline',status:'running',stage:'ttsGenerate',progress:.1,logs:['Pipeline 1: raw TTS'],error:null};emit('job-changed',job);return job.id;}
      if(command==='separate_audio_selection'){host.__pendingToolbox=structuredClone(args.options);job={id:crypto.randomUUID(),projectId:project.id,kind:'audioToolbox',status:'running',stage:'toolboxSeparate',progress:.3,logs:[],error:null,timing:{elapsedMs:1250,observedAtMs:Date.now()}};host.__toolboxId=job.id;emit('job-changed',job);return job.id;}
      if(command==='audio_toolbox_result')return {id:args.id,options:host.__pendingToolbox,outputs:host.__pendingToolbox.modelId==='audiosep'?['isolated','residual']:['vocals','instrumental'],commonGain:1,deviceName:'CPU',stale:host.__toolboxStale??false,applied:project.generations.some((g:any)=>g.operationId===args.id)};
      if(command==='audio_toolbox_path')return `C:/Studio/cache/audio-toolbox/${args.id}/${args.outputId}.wav`;
      if(command==='apply_audio_toolbox_result'){
       host.__toolboxApply=structuredClone(args);undoStack.push(structuredClone(project));project.formatVersion=Math.max(23,project.formatVersion);
       for(const d of args.destinations){let track=project.tracks.find((t:any)=>d.trackId?t.id===d.trackId:t.role===d.role);if(!track){track={id:d.role,kind:'audio',role:d.role,language:project.languages.source,mute:false,solo:false,gain:1,path:`stems/patch-${d.role}-base.wav`,sourcePath:project.media.path,durationMs:project.media.durationMs};project.tracks.push(track);}const id=crypto.randomUUID(),o=host.__pendingToolbox;project.generations.push({kind:'audioPatch',id,operationId:args.id,operation:'separation',sourcePath:project.media.path,sourceTrackId:o.sourceTrackId,trackId:track.id,startMs:o.startMs,endMs:o.endMs,mode:'replace',path:`stems/patch-${id}.wav`,gain:1});}
       project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));return structuredClone(project);
      }
      if(command==='tts_status')return {installed:host.__ttsReady,installing:false,sizeBytes:5427042285,inventory:{devices:[{id:'cpu',name:'CPU'},{id:'cuda:0',name:'NVIDIA RTX 5060 Ti (simulation)'}],cudaVersion:'12.8'}};
      if(command==='install_tts_runtime'){job={id:'tts-install',projectId:'',kind:'ttsInstall',status:'running',stage:'dependencies',progress:null,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='generate_line'){host.__pendingTts=structuredClone(args);job={id:'tts-job',projectId:project.id,kind:'tts',status:'running',stage:'ttsGenerate',progress:null,logs:[],error:null,timing:{elapsedMs:1250,observedAtMs:Date.now()}};emit('job-changed',job);return job.id;}
      if(command==='mcp_store_microphone_take'){
        const meta=JSON.parse(options.headers['x-studio-capture']),view=new DataView(args);host.__microphoneBytes=args.byteLength;
        if(meta.projectId!==project.id||meta.expectedRevision!==project.revision)throw Error('STALE_REVISION');
        const line=project.dialogues.find((l:any)=>l.id===meta.lineId),id=crypto.randomUUID();
        project.generations.push({id,kind:'tts',dialogueId:line.id,providerId:'microphone',modelId:'microphone-pcm24',path:`generations/${id}.wav`,createdAt:new Date().toISOString(),sourcePath:project.media?.path??null,startMs:line.startMs,endMs:line.endMs,text:line.ttsText??project.targetCues.filter((c:any)=>line.targetCueIds.includes(c.id)).map((c:any)=>c.text).join(' '),language:project.languages.target,characterId:line.characterId,durationMs:Math.floor(view.getUint32(40,true)/48),sampleRate:24000,options:{device:'cpu',referenceMode:'current',referenceId:null,mode:'crossLingual',speed:1,seed:0},referenceTranscript:'',device:'cpu',deviceName:'Microphone',peakVramMb:0,inputHash:'microphone',takeOrigin:{type:'microphone'}});
        line.selectedGenerationIds[project.languages.target]=id;line.status='review';project.formatVersion=Math.max(17,project.formatVersion);project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));return structuredClone(project);
      }
      if(command==='convert_voice_timbre'){if(host.__rejectConversion)throw Error('TTS_MODEL_REQUIRED');host.__pendingConversion=structuredClone(args.options);job={id:crypto.randomUUID(),projectId:project.id,kind:'voiceConversion',status:'running',stage:'vcConvert',progress:.4,logs:[],error:null};emit('job-changed',job);if(host.__instantDerived)host.__completeDerived();return job.id;}
      if(command==='generation_path')return `C:/Studio/generations/${args.id}.wav`;
      if(command==='apply_audio_effects'){host.__pendingEffects=structuredClone(args.options);job={id:crypto.randomUUID(),projectId:project.id,kind:'audioEffects',status:'running',stage:'fxRender',progress:.1,logs:[],error:null,timing:{elapsedMs:0,observedAtMs:Date.now()}};emit('job-changed',job);return job.id;}
      if(command==='dubbing_path'){
        if(args.edit&&host.__deferEdit)await new Promise((resolve,reject)=>{host.__releaseEdit=(error=false)=>error?reject(Error('VOICE_EDIT_FAILED Invalid data found when processing input')):resolve(null);});
        if(args.edit&&host.__editRenderFail)throw Error('VOICE_EDIT_FAILED Invalid data found when processing input');
        return `C:/Studio/generations/${args.id}.wav`;
      }
      if(command==='export_generation')return null;
      if(command==='mcp_ready'){host.__mcpReady=args.ready;return null;}
      if(command==='mcp_prepare_update'){if(host.__updateBusy)throw Error('BUSY');mcpEnabled=false;return null;}
      if(command==='mcp_update_failed'){mcpEnabled=localStorage.getItem('mockMcpEnabled')==='true';return null;}
      if(command==='mcp_status')return {enabled:mcpEnabled,ready:host.__mcpReady,port:mcpEnabled?50291:null,pending:mcpRequests.size,audit:structuredClone(mcpAudit),configuration:{mcpServers:{'ai-dubbing-studio':{command:'C:/Studio/ai-dubbing-studio.exe',args:['--mcp','--endpoint','C:/Studio/mcp-endpoint.json']}}},configurationToml:'[mcp_servers.ai_dubbing_studio]\ncommand = "C:/Studio/ai-dubbing-studio.exe"\nargs = ["--mcp", "--endpoint", "C:/Studio/mcp-endpoint.json"]\nstartup_timeout_sec = 20\ntool_timeout_sec = 180\n'};
      if(command==='mcp_set_enabled'){mcpEnabled=args.enabled;localStorage.setItem('mockMcpEnabled',String(mcpEnabled));if(!mcpEnabled)for(const id of mcpRequests.keys())host.__mcpCancel(id);return host.__TAURI_INTERNALS__.invoke('mcp_status');}
      if(command==='mcp_claim'){const row=mcpRequests.get(args.id);if(!mcpEnabled||!row||row.claimed)return null;row.claimed=true;mcpAudit.find(r=>r.id===args.id).status='running';return {id:row.id,tool:row.tool,arguments:row.arguments};}
      if(command==='mcp_live')return mcpEnabled&&mcpRequests.has(args.id);
      if(command==='mcp_complete'){const row=mcpRequests.get(args.id);if(row){mcpRequests.delete(args.id);mcpAudit.find(r=>r.id===args.id).status=args.error?'failed':'succeeded';row.resolve(args.error?{error:args.error}:args.result);}return null;}
      if(command==='list_jobs')return job?[job]:[];
      if(command==='media_path')return 'preview.mp4';
      if(command==='get_waveform')return {durationMs:16000,stepMs:20,audioStreamIndex:args.trackId?0:1,peaks:Array.from({length:800},(_,i)=>0.1+(i%9)/12)};
      if(command==='audio_paths')return Object.fromEntries(project.tracks.filter((track:any)=>track.kind==='audio').map((track:any)=>[track.id,track.path]));
      if(command==='model_storage_info')return {path:host.__modelFolder||'C:/Studio/models',defaultPath:'C:/Studio/models',moving:job?.kind==='modelMove'&&job.status==='running'};
      if(command==='model_storage_size'){if(host.__sizeError)throw Error('disk unavailable');return {path:host.__modelFolder||'C:/Studio/models',bytes:host.__modelBytes??4831838208,files:974,skipped:0,partial:false};}
      if(command==='plugin:dialog|save')return args.options?.defaultPath?.endsWith('.mkv')?'C:/Exports/dubbed.mkv':'C:/Exports/speech-montage.wav';
      if(command==='export_mkv'){job={id:'mkv-export',projectId:project.id,kind:'mkvExport',status:'running',stage:'mixEncode',progress:0.2,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='export_audio_track'){job={id:'export',projectId:project.id,kind:'audioExport',status:'running',stage:'audioRender',progress:0.5,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='plugin:dialog|open')return host.__dialogPath===undefined?'D:/AI Models':host.__dialogPath;
      if(command==='change_model_storage'){host.__pendingModelFolder=args.path;job={id:'modelMove',projectId:'',kind:'modelMove',status:'running',stage:'modelMove',progress:0.4,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='environment')return {platform:'windows',ffmpeg:true,ffprobe:true};
      if(command==='graphics_info')return {preference:'auto',executable:'C:/Studio/ai-dubbing-studio.exe',adapters:[{Name:'Intel iGPU'},{Name:'NVIDIA GPU'}]};
      if(command==='set_graphics_preference'||command==='open_graphics_settings')return null;
      if(command==='separation_status')return structuredClone(host.__runtimeStatus);

      if(command==='voice_library_audio_path')return `characters/voice-library/${args.referenceId}.wav`;
      if(command==='prepare_voice_library_source'){
        undoStack.push(structuredClone(project));const o=args.options,id=crypto.randomUUID();project.formatVersion=Math.max(21,project.formatVersion);project.characterProfiles??={};project.characterProfiles[o.characterId]??={};
        const lib=project.characterProfiles[o.characterId].voiceLibrary??={sources:[],samples:[],defaultSampleId:null};
        lib.sources.push({id,reference:{id,label:o.label,path:`characters/voice-library/source-${id}.wav`,durationMs:o.segments.reduce((n:number,s:any)=>n+s.endMs-s.startMs,0),transcript:''},segments:o.segments,sha256:'a'.repeat(64),createdAt:new Date().toISOString()});
        project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));return structuredClone(project);
      }
      if(command==='generate_voice_library'){host.__pendingLibrary=structuredClone(args.options);job={id:'library-job',projectId:project.id,kind:'voiceLibrary',status:'running',stage:'voiceLibraryGenerate',progress:null,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='suggest_dialogue_character'){host.__pendingCharacterMatch=structuredClone(args.options);host.__characterBasis=project.revision;job={id:'match-'+crypto.randomUUID(),projectId:project.id,kind:'characterMatch',status:'running',stage:'characterMatch',progress:null,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='character_suggestion_result')return {...structuredClone(host.__characterProposal),id:args.id,stale:host.__characterBasis!==project.revision};
      if(command==='accept_character_suggestion'){
        if(host.__characterBasis!==project.revision)throw Error('STALE_REVISION');undoStack.push(structuredClone(project));project.dialogues.find((l:any)=>l.id===host.__pendingCharacterMatch.lineId).characterId=args.characterId;project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));return structuredClone(project);
      }
      if(command==='speaker_status')return structuredClone(host.__speakerStatus);
      if(command==='character_asset_path')return args.path;
      if(command==='preview_character_sample')return `characters/preview-${args.lineId}.wav`;
      if(command==='prepare_character_reference'){const selected=args.segments.map((s:any)=>({s,r:project.characters.find((c:any)=>c.id===s.characterId).references.find((r:any)=>r.id===s.referenceId)}));return {id:'combined-'+crypto.randomUUID(),label:args.label,path:'characters/combined.wav',durationMs:selected.reduce((n:number,v:any)=>n+v.s.endMs-v.s.startMs,0),transcript:selected.every((v:any)=>v.s.startMs===0&&v.s.endMs===v.r.durationMs)?selected.map((v:any)=>v.r.transcript).join(' '):''};}
      if(command==='capture_character_portrait'){undoStack.push(structuredClone(project));project.formatVersion=Math.max(20,project.formatVersion);project.characterProfiles??={};const o=args.options;project.characterProfiles[o.characterId]={...project.characterProfiles[o.characterId],portrait:{path:`characters/portrait-${o.characterId}.png`,sourcePath:project.media.path,lineId:o.lineId,atMs:o.atMs??project.dialogues.find((l:any)=>l.id===o.lineId).startMs,crop:o.crop??{x:0,y:0,width:1,height:1},differenceHash:'0000ffff0000ffff',colors:Array(48).fill(1/16),confirmed:!!o.crop}};project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));return structuredClone(project);}
      if(command==='separate_audio_region'){const id='local-'+crypto.randomUUID();localResults.set(id,{options:structuredClone(args.options),snapshot:JSON.stringify({tracks:project.tracks,patches:project.generations.filter((g:any)=>['audioPatch','audioEffects'].includes(g.kind))})});job={id,projectId:project.id,kind:'separation',status:'running',stage:'localSeparation',progress:.3,logs:[],error:null};emit('job-changed',job);return id;}
      if(command==='local_separation_result'){const r=localResults.get(args.id);if(!r)throw Error('INVALID_JOB');return {id:args.id,options:r.options,roles:['speech','music','sfx'],applied:project.generations.some((g:any)=>g.operationId===args.id),stale:r.snapshot!==JSON.stringify({tracks:project.tracks,patches:project.generations.filter((g:any)=>['audioPatch','audioEffects'].includes(g.kind))})};}
      if(command==='local_separation_path')return `stems/local-${args.id}/${args.role}.wav`;
      if(command==='apply_local_separation'){const r=localResults.get(args.id);if(!r)throw Error('INVALID_JOB');undoStack.push(structuredClone(project));project.formatVersion=Math.max(20,project.formatVersion);for(const role of ['speech','music','sfx']){const track=project.tracks.find((tr:any)=>tr.role===role),id=crypto.randomUUID();project.generations.push({kind:'audioPatch',id,operationId:args.id,operation:'separation',sourcePath:project.media.path,trackId:track.id,sourceTrackId:r.options.sourceTrackId,startMs:r.options.startMs,endMs:r.options.endMs,mode:r.options.sourceTrackId==='original'||track.id===r.options.sourceTrackId?'replace':'add',path:`stems/patch-${id}.wav`,gain:1});}project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));return structuredClone(project);}

      if(command==='identify_speakers'){host.__pendingSpeakerScope=structuredClone(args.scope);job={id:'speakers',projectId:project.id,kind:'speakers',status:'running',stage:'speakerEmbeddings',progress:0.3,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='voice_reference_path')return `C:/Studio/characters/${args.referenceId}.wav`;
      if(command==='reference_audio_info')return {path:'C:/Audio/reference-source.wav',durationMs:60000};
      if(command==='preview_dubbing_batch')return batchPlan(args.selection);
      if(command==='preview_inpaint_batch')return lipBatchPlan(args.selection);
      if(command==='detect_inpaint_faces'){host.__pendingFaceDetection=structuredClone(args);host.__faceBasis=project.revision;host.__faceResult=null;job={id:'face-job',projectId:project.id,kind:'faceDetection',status:'running',stage:'faceDetection',progress:0,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='face_detection_result'){const result=structuredClone(host.__faceResult);if(result&&host.__faceBasis!==project.revision)for(const row of result.items){row.crop=null;row.reason='INPAINT_STALE';}return result;}
      if(command==='start_inpaint_batch'){const s=args.selection,p=lipBatchPlan(s);host.__pendingLipBatch=structuredClone(s);host.__lipRows=p.ready.map((id:string)=>({id,status:'pending'}));host.__lipSkipped=p.requested-p.ready.length;job={id:'lip-batch-job',projectId:project.id,kind:'inpaintBatch',logs:[],error:null};lipBatchUpdate();return job.id;}
      if(command==='retry_job'&&job.kind==='inpaintBatch'){for(const row of host.__lipRows)if(row.status!=='succeeded')row.status='pending';lipBatchUpdate();return job.id;}
      if(command==='generate_dubbing_batch') {const plan=batchPlan(args.selection);host.__pendingBatch=structuredClone(args.selection);host.__batchRows=plan.ready.map((id:string)=>({id,status:'pending'}));host.__batchSkipped=plan.existing+plan.untranslated+plan.unapproved+plan.approved+plan.blocked.length;job={id:'batch-job',projectId:project.id,kind:'ttsBatch',logs:[],error:null};batchJobUpdate();return job.id;}
      if(command==='retry_job'&&job.kind==='ttsBatch'){for(const row of host.__batchRows)if(row.status!=='succeeded')row.status='pending';batchJobUpdate();return job.id;}
      if(command==='retry_job'&&['voiceConversion','prosodyTransfer','referenceTranscription','tts'].includes(job.kind)){job={...job,id:crypto.randomUUID(),status:'running',stage:'ttsGenerate',error:null,logs:[],progress:null};emit('job-changed',job);return job.id;}
      if(command==='import_voice_reference') {if(host.__referenceImportError)throw Error('REFERENCE_FAILED');const character=project.characters.find((c:any)=>c.id===args.characterId);character.references.push({id:crypto.randomUUID(),label:args.label||'Excerpt',path:'characters/excerpt.wav',durationMs:args.range.endMs-args.range.startMs,transcript:'',sourceDialogueId:null});project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));return structuredClone(project);}
      if(command==='import_dubbing_reference'){
        if(host.__referenceImportError)throw Error('REFERENCE_FAILED');
        undoStack.push(structuredClone(project));redoStack.length=0;
        const id=crypto.randomUUID();project.voiceReferences??=[];
        project.voiceReferences.push({id,label:'Voix française',path:`characters/reference-${id}.wav`,durationMs:args.range?args.range.endMs-args.range.startMs:7000,transcript:'',sourceDialogueId:null});
        if(args.lineId)project.dialogues.find((l:any)=>l.id===args.lineId).voiceSettings={...args.options,referenceMode:'file',referenceId:id};
        project.formatVersion=Math.max(9,project.formatVersion);project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));return structuredClone(project);
      }
      if(command==='transcribe_dialogue_source'){
        const id=crypto.randomUUID(),basis=sourceBasis(args.options.lineId);sourceAsrRows.push({id,basis,segments:[],trackId:args.options.trackId,language:args.options.language,model:'Whisper small multilingual Q5_1',stale:false});localStorage.setItem('mockSourceAsr',JSON.stringify(sourceAsrRows));host.__pendingSourceAsr=structuredClone(args.options);job={id,projectId:project.id,kind:'sourceTranscription',status:'running',stage:'asrTranscribe',progress:null,logs:[],error:null};emit('job-changed',job);return id;
      }
      if(command==='latest_source_transcription')return sourceAsrRows.filter((r:any)=>r.basis.lineId===args.lineId).at(-1)?.id??null;
      if(command==='source_transcription_result'){const row=sourceAsrRows.find((r:any)=>r.id===args.id);return row?.segments.length?{...structuredClone(row),stale:JSON.stringify(row.basis)!==JSON.stringify(sourceBasis(row.basis.lineId))}:null;}
      if(command==='apply_source_transcription'){
        const row=sourceAsrRows.find((r:any)=>r.id===args.id);if(JSON.stringify(row.basis)!==JSON.stringify(sourceBasis(row.basis.lineId)))throw Error('STALE_REVISION');
        undoStack.push(structuredClone(project));redoStack.length=0;
        row.basis.slots.forEach((slot:any,i:number)=>{if(slot.cueId)project.sourceCues.find((c:any)=>c.id===slot.cueId).text=args.texts[i];else{const id=crypto.randomUUID();project.sourceCues.push({id,startMs:slot.startMs,endMs:slot.endMs,text:args.texts[i]});project.dialogues.find((l:any)=>l.id===row.basis.lineId).sourceCueIds.push(id);}});
        delete project.translationApprovals?.[row.basis.lineId];project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));return structuredClone(project);
      }
      if(command==='set_voice_output_gain'){
        if(!Number.isFinite(args.gain)||args.gain<0||args.gain>4)throw Error('INVALID_OUTPUT_GAIN');
        const g=project.generations.find((g:any)=>g.kind==='tts'&&g.id===args.id);if(!g)throw Error('INVALID_GENERATION');undoStack.push(structuredClone(project));redoStack.length=0;
        const edit=(project.voiceEdits??={})[g.id]??={pieces:[{sourceStartMs:0,sourceEndMs:g.durationMs,durationMs:g.durationMs,gain:1}]};
        if(args.gain===1)delete edit.outputGain;else edit.outputGain=args.gain;project.formatVersion=Math.max(22,project.formatVersion);project.revision++;localStorage.setItem('nativeMockProject',JSON.stringify(project));emit('project-changed',structuredClone(project));return structuredClone(project);
      }
      if(command==='transcribe_voice_reference'){host.__pendingTranscription=structuredClone(args);job={id:'asr-job',projectId:project.id,kind:'referenceTranscription',status:'running',stage:'asrTranscribe',progress:null,logs:['Local Whisper small Q5_1, CPU. No audio upload.'],error:null};emit('job-changed',job);return job.id;}
      if(command==='install_separation_runtime'){job={id:'runtime',projectId:null,kind:'runtime',status:'running',stage:'dependencies',progress:null,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='separate_audio'){job={id:'separation',projectId:project.id,kind:'separation',status:'running',stage:'separate',progress:0.3,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='pause_job'){job={...job,status:args.paused?'paused':'running'};emit('job-changed',job);return null;}
      if(command==='cancel_job'){job={...job,status:'cancelled'};emit('job-changed',job);return null;}
      if(command==='replace_project'){if(args.expectedRevision!==project.revision)throw Error('STALE_REVISION');undoStack.push(structuredClone(project));redoStack.length=0;project={...structuredClone(args.project),revision:project.revision+1};localStorage.setItem('nativeMockProject',JSON.stringify(project));return structuredClone(project);}
      if(command==='history'){const from=args.direction==='undo'?undoStack:redoStack,to=args.direction==='undo'?redoStack:undoStack;if(from.length){to.push(structuredClone(project));project={...from.pop(),revision:project.revision+1};localStorage.setItem('nativeMockProject',JSON.stringify(project));}return structuredClone(project);}
      if(command==='plugin:event|listen'){listeners.set(args.event,args.handler);return args.handler;}
      if(command==='plugin:event|unlisten'||command==='plugin:resources|close')return null;
      if(command==='plugin:updater|check')return {rid:45,currentVersion:'0.5.0',version:'0.5.1',body:'Performance et audio',rawJson:{}};
      if(command==='plugin:updater|download'){
        if(host.__downloadError)throw Error('Invalid signature');
        const channel=args.onEvent.id;callbacks.get(channel)?.({index:0,message:{event:'Started',data:{contentLength:100}}});callbacks.get(channel)?.({index:1,message:{event:'Progress',data:{chunkLength:100}}});callbacks.get(channel)?.({index:2,message:{event:'Finished'}});return 46;
      }
      if(command==='plugin:updater|install'){if(host.__installError)throw Error('Installer failed');host.__installed=true;return null;}
      throw Error(`Unexpected mock command ${command}`);
    }};
  },{initial:(() => { if(seededProject)return seededProject;const initial=demoProject();if(large){initial.sourceCues=Array.from({length:6000},(_,i)=>({id:`s${i}`,startMs:i*3000,endMs:i*3000+2000,text:`Source ${i}`}));initial.targetCues=initial.sourceCues.map((cue,i)=>({...cue,id:`t${i}`,text:`Texte ${i}`}));initial.dialogues=initial.sourceCues.map((cue,i)=>({id:`d${i}`,startMs:cue.startMs,endMs:cue.endMs,sourceCueIds:[cue.id],targetCueIds:[`t${i}`],ttsText:null,characterId:null,status:'ungenerated',warnings:[],selectedGenerationIds:{}}));}return initial;})()});
}

