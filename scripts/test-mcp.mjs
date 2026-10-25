// Actual packaged executable + WebView + native filesystem/FFmpeg, driven by
// the pinned official SDK. No model weights or GPU inference are involved.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {verifyRelayLifecycle} from './test-mcp-lifecycle.mjs';
import {verifyOneShot} from './test-mcp-one-shot.mjs';
import {verifySshTransport} from './test-mcp-ssh-stdio.mjs';
const args=Object.fromEntries(process.argv.slice(2).reduce((rows,value,index,all)=>index%2===0?[...rows,[value.slice(2),all[index+1]]]:rows,[]));
const client=new Client({name:'studio-native-validation',version:'1.0.0'},{capabilities:{}});
const transport=new StdioClientTransport({command:args.exe,args:['--mcp','--endpoint',args.endpoint],stderr:'pipe'});
let stderr='';transport.stderr?.on('data',bytes=>{stderr+=bytes.toString();});
const proofs={};
const call=async(name,arguments_={})=>{
    const response=await client.callTool({name,arguments:arguments_});
    if(response.isError)throw Error(response.content.map(item=>item.text??'').join('\n'));
    return response.structuredContent.value;
};
const effectJob=async options=>{
    const until=Date.now()+10000;
    while(true){try{return await call('studio_apply_audio_effects',{context:await context(),options});}catch(error){if(String(error)!=='Error: BUSY'||Date.now()>=until)throw error;await new Promise(resolve=>setTimeout(resolve,200));}}
};
const state=()=>call('studio_get_state');
const context=async()=> (await state()).context;
const job=async id=>{
    const until=Date.now()+120000;
    while(Date.now()<until){
        const rows=await call('studio_list_jobs');const row=rows.find(row=>row.id===id);
        if(row){
            assert(Number.isSafeInteger(row.timing?.elapsedMs) && row.timing.elapsedMs >= 0);
            assert(Number.isSafeInteger(row.timing.observedAtMs) && row.timing.observedAtMs > 0);
        }
        if(row?.status==='succeeded'){proofs.jobExecutionTiming=true;return row;}
        if(row&&['failed','cancelled','interrupted'].includes(row.status))throw Error(JSON.stringify(row));
        await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw Error('Native MCP job timeout');
};
try {
    proofs.relayLifecycle=await verifyRelayLifecycle(args.exe,args['test-root']);
    proofs.relayOneShot=await verifyOneShot(args.exe,args['test-root']);
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    const catalog=JSON.parse(await fs.readFile(new URL('../src/mcp/catalog.json',import.meta.url),'utf8'));
    assert.equal(tools.length,catalog.commands.length+catalog.builtins.length);
    assert(!tools.some(tool=>tool.name==='studio_replace_project'||tool.name.startsWith('studio_mcp_')));
    proofs.officialSdk=true;proofs.toolCount=tools.length;proofs.version=client.getServerVersion().version;
    const schema=await client.readResource({uri:'studio://schemas/Project'});
    assert(JSON.parse(schema.contents[0].text).$defs);proofs.resources=true;
    const until=Date.now()+90000;
    while(true){try {await state();break;}catch(error){if(!String(error).includes('MCP_UI_NOT_READY')||Date.now()>=until)throw error;await new Promise(resolve=>setTimeout(resolve,250));}}
    proofs.packagedSshTransport=await verifySshTransport(args.exe,args.endpoint,args['test-root']);
    const name='Projet MCP 日本語';
    await call('studio_create_project',{parentPath:args['test-root'],name,source:'ja',target:'fr'});
    const originalHash=createHash('sha256').update(await fs.readFile(args.movie)).digest('hex');
    const imported=await call('studio_import_media',{context:await context(),path:args.movie,audioStreamIndex:1,forceProxy:false});await job(imported);
    for(const [role,text] of [['source','字幕のテスト。'],['target','Une première traduction.']]){
        const file=path.join(args['test-root'],`${role}.srt`);await fs.writeFile(file,`1\n00:00:01,000 --> 00:00:03,000\n${text}\n\n2\n00:00:05,000 --> 00:00:07,000\n${text}\n`,'utf8');
        await call('studio_import_subtitles',{context:await context(),path:file,role});
    }
    const rows=await call('studio_get_dialogues',{limit:10});assert.equal(rows.rows.length,2);
    const lineId=rows.rows[0].id;
    const edited=await call('studio_edit_dialogue',{context:await context(),lineId,role:'target',text:'Une traduction validée par MCP.',approved:true});
    assert.equal((await call('studio_get_dialogues',{status:'approved'})).rows[0].translated,'Une traduction validée par MCP.');
    const batchSelection={scope:'all',lineIds:[],force:true,unapprovedOnly:true,options:{variantId:'cosy3-official',device:'cpu',referenceMode:'current',referenceId:null,mode:'crossLingual',speed:1,seed:0}};
    const pendingBatch=await call('studio_preview_dubbing_batch',{selection:batchSelection});
    assert.equal(pendingBatch.approved,1);assert.equal(pendingBatch.unapproved,0);
    assert.deepEqual(pendingBatch.ready,[rows.rows[1].id]);
    const approvedBatch=await call('studio_preview_dubbing_batch',{selection:{...batchSelection,unapprovedOnly:false,approvedOnly:true}});
    assert.equal(approvedBatch.unapproved,1);assert.deepEqual(approvedBatch.ready,[lineId]);
    const conflictingBatch=await client.callTool({name:'studio_preview_dubbing_batch',arguments:{selection:{...batchSelection,approvedOnly:true}}});
    assert(conflictingBatch.isError);proofs.batchTranslationFilter=true;
    const stale=await client.callTool({name:'studio_edit_dialogue',arguments:{context:rows.context,lineId,role:'target',text:'Must be rejected'}});assert(stale.isError);proofs.staleRevision=true;
    await call('studio_history',{context:edited.context,direction:'undo'});
    assert.equal((await call('studio_get_dialogues')).rows[0].translated,'Une première traduction.');proofs.undo=true;
    await call('studio_set_track',{context:await context(),id:'original',changes:{gain:.6,mute:false}});
    await call('studio_audio_region',{context:await context(),id:'original',startMs:1000,endMs:1500,gain:0,mute:true});
    const characterId=randomUUID();
    await call('studio_project_patch',{context:await context(),patches:[{op:'add',path:'/characters/-',value:{id:characterId,name:'Personnage MCP',color:'#82bda0',references:[],defaultReferenceId:null}},{op:'replace',path:'/formatVersion',value:13}]});
    const project=await call('studio_get_project');assert.equal(project.characters[0].id,characterId);assert.equal(project.tracks.find(track=>track.id==='original').regions[0].mute,true);proofs.atomicEditing=true;
    await call('studio_open_project',{path:path.join(args['test-root'],`${name}.dubproject`)});
    assert.equal((await call('studio_get_project')).formatVersion,13);proofs.reopenFormat13=true;
    await call('studio_select_dialogue',{lineId});await call('studio_set_selection',{ids:[lineId]});
    await call('studio_preferences',{zoom:3,language:'fr',theme:'dark'});
    const ready=Date.now()+30000;
    while(!(await state()).playback.ready){if(Date.now()>ready)throw Error('Native video did not become ready');await new Promise(resolve=>setTimeout(resolve,200));}
    await call('studio_playback',{action:'seek',timeMs:2000});await call('studio_playback',{action:'play'});
    const playingDeadline=Date.now()+15000;
    while((await state()).playback.timeMs<=2150){if(Date.now()>playingDeadline)throw Error('Native MCP playback did not start');await new Promise(resolve=>setTimeout(resolve,200));}
    const levelDeadline=Date.now()+15000;
    let meter;
    while(true){meter=await call('studio_audio_levels',{action:'status'});if(meter.status==='ready'&&meter.tracks.original?.channels.some(c=>c.peakDb>-90))break;if(Date.now()>levelDeadline)throw Error('Packaged AudioWorklet stereo meter did not measure actual video audio');await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(meter.tracks.original.channels.length,2);assert.equal(meter.beforeListeningVolume,true);
    await call('studio_playback',{action:'volume',value:0});
    await new Promise(resolve=>setTimeout(resolve,200));
    meter=await call('studio_audio_levels',{action:'status'});
    assert(meter.tracks.original.channels.some(c=>c.peakDb>-90),'Listening mute must not hide mix levels');
    assert(meter.tracks.$mix.channels.some(c=>c.peakDb>-90));
    await call('studio_playback',{action:'pause'});
    await new Promise(resolve=>setTimeout(resolve,100));
    meter=await call('studio_audio_levels',{action:'reset'});
    assert.equal(meter.playing,false);assert(Object.values(meter.tracks).every(t=>!t.clipped&&t.channels.every(c=>c.peakDb===-96&&c.maxDb===-96)));
    await call('studio_playback',{action:'volume',value:.8});
    proofs.audioLevelMetering={stereo:true,beforeListeningVolume:true,reset:true};
    assert((await state()).playback.timeMs>2150);proofs.playback=true;
    // Actual CPU contour processing in the packaged app, with synthetic voiced
    // inputs; no TTS quality or Japanese-to-French prosody benchmark claim.
    const monoVoice=(rising=false)=>{
        const n=48000,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
        let phase=0;for(let i=0;i<n;i++){phase+=2*Math.PI*(rising?160*2**((i/24000-1)*5/12):180)/24000;b.writeInt16LE(Math.round(7000*(.8*Math.sin(phase)+.2*Math.sin(2*phase))),44+2*i);}return b;
    };
    const baseId=randomUUID(),basePath=`generations/${baseId}.wav`,projectRoot=path.join(args['test-root'],`${name}.dubproject`);
    const baseWave=monoVoice(),guideWave=monoVoice(true),guideFile=path.join(args['test-root'],'Guide 日本語.wav');
    await fs.writeFile(path.join(projectRoot,basePath),baseWave);await fs.writeFile(guideFile,guideWave);
    const beforeProsody=await call('studio_get_project'),line=beforeProsody.dialogues.find(l=>l.id===lineId);
    const voiceOptions={variantId:'cosy3-official',device:'cpu',referenceMode:'current',referenceId:null,mode:'crossLingual',speed:1,seed:0};
    const baseTake={id:baseId,kind:'tts',dialogueId:lineId,providerId:'cosyvoice3',modelId:'cosy3-official',path:basePath,createdAt:new Date().toISOString(),sourcePath:beforeProsody.media.path,startMs:line.startMs,endMs:line.endMs,text:'Une première traduction.',language:'fr',characterId:line.characterId,durationMs:2000,sampleRate:24000,options:voiceOptions,referenceTranscript:'',device:'cpu',deviceName:'CPU synthetic diagnostic',peakVramMb:0,inputHash:'synthetic-native-prosody-test'};
    await call('studio_project_patch',{context:await context(),patches:[{op:'replace',path:'/formatVersion',value:14},{op:'add',path:'/generations/-',value:baseTake}]});
    const withReference=await call('studio_import_dubbing_reference',{context:await context(),lineId:null,path:guideFile,range:null,options:voiceOptions});
    const guideId=withReference.voiceReferences.at(-1).id;
    assert((await call('studio_prosody_status')).available);
    const transfer={generationId:baseId,referenceMode:'reference',referenceId:guideId,strength:.7,pitch:true,rhythm:true,energy:true};
    await job(await call('studio_transfer_voice_prosody',{context:await context(),options:transfer}));
    let processed=await call('studio_get_project');
    const derived=processed.generations.find(g=>g.prosodyTransfer?.sourceGenerationId===baseId);
    assert(derived&&derived.id!==baseId);assert.equal(processed.dialogues.find(l=>l.id===lineId).selectedGenerationIds.fr,derived.id);
    assert.deepEqual(processed.generations.find(g=>g.id===baseId),baseTake);assert.equal(processed.formatVersion,14);
    assert.deepEqual(await fs.readFile(path.join(projectRoot,basePath)),baseWave);assert.deepEqual(await fs.readFile(guideFile),guideWave);
    assert(derived.durationMs>=1600&&derived.durationMs<=2500);proofs.prosodyReferenceTransfer=true;
    await job(await call('studio_transfer_voice_prosody',{context:await context(),options:{...transfer,referenceMode:'dialogue',referenceId:null,referenceTrackId:'original'}}));
    processed=await call('studio_get_project');assert.equal(processed.generations.filter(g=>g.prosodyTransfer).length,2);proofs.prosodyDialogueTransfer=true;
    const cancelled=await call('studio_transfer_voice_prosody',{context:await context(),options:transfer});await call('studio_cancel_job',{id:cancelled});
    const cancellationDeadline=Date.now()+15000;
    while((await call('studio_list_jobs')).find(j=>j.id===cancelled).status!=='cancelled'){if(Date.now()>cancellationDeadline)throw Error('Prosody cancellation did not settle');await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal((await call('studio_get_project')).generations.length,processed.generations.length);
    assert.deepEqual(await fs.readFile(path.join(projectRoot,basePath)),baseWave);proofs.prosodyCancellationPreservesTakes=true;
    const output=path.join(args['test-root'],'Résultat 日本語.mkv');
    const exported=await call('studio_export_mkv',{context:await context(),path:output,options:{includeRetouched:false,includeOriginal:true,sourceSubtitles:true,targetSubtitles:true,codec:'flac',allowIncomplete:true}});await job(exported);
    const probe=path.join(path.dirname(args.exe),'binaries','ffprobe.exe');
    const media=JSON.parse(execFileSync(probe,['-v','error','-show_format','-show_streams','-of','json',output],{encoding:'utf8',windowsHide:true}));
    assert(Math.abs(Number(media.format.duration)-16)<.2);assert(media.streams.some(stream=>stream.codec_type==='audio'));assert.equal(media.streams.filter(stream=>stream.codec_type==='subtitle').length,2);
    assert.equal(createHash('sha256').update(await fs.readFile(args.movie)).digest('hex'),originalHash);proofs.mkvExport=true;proofs.sourcePreserved=true;
    // Verify the shipped catalogue, typed MCP schema and persisted expanded
    // options on the real desktop without claiming neural acting quality.
    const moodSchema=await client.readResource({uri:'studio://schemas/VoiceSettings'});
    const schemaText=moodSchema.contents[0].text;
    for(const id of ['dying','stressed','laughing']) assert(schemaText.includes(`"${id}"`));
    const shippedMoods=JSON.parse(await fs.readFile(path.join(path.dirname(args.exe),'workers','voice-moods.json'),'utf8'));
    assert.equal(Object.keys(shippedMoods.moods).length,43);
    assert((await fs.readFile(path.join(path.dirname(args.exe),'workers','voice_mood.py'),'utf8')).includes('def mood_spec'));
    const lineIndex=processed.dialogues.findIndex(l=>l.id===lineId);
    await call('studio_project_patch',{context:await context(),patches:[{op:'replace',path:'/formatVersion',value:15},{op:'add',path:`/dialogues/${lineIndex}/voiceSettings`,value:{...voiceOptions,mood:'dying'}}]});
    await call('studio_open_project',{path:projectRoot});
    const reopened=await call('studio_get_project');
    assert.equal(reopened.formatVersion,15);assert.equal(reopened.dialogues[lineIndex].voiceSettings.mood,'dying');
    assert.deepEqual(reopened.generations,processed.generations);proofs.expandedMoods=43;proofs.reopenFormat15=true;
    // Save/reopen both new engines through the shipped native validators.
    for (const [variantId, provider] of [['voxcpm2-bf16','voxcpm2'],['chatterbox-multilingual-v3','chatterbox']]) {
      await call('studio_project_patch',{context:await context(),patches:[{op:'replace',path:'/formatVersion',value:16},{op:'replace',path:`/dialogues/${lineIndex}/voiceSettings`,value:{...voiceOptions,variantId,mood:'default',mode:'crossLingual'}},{op:'add',path:'/modelPreferences',value:{ttsProviderId:provider,voiceVariantId:variantId}}]});
      await call('studio_open_project',{path:projectRoot});
      const newProfile=await call('studio_get_project');
      assert.equal(newProfile.formatVersion,16);assert.equal(newProfile.dialogues[lineIndex].voiceSettings.variantId,variantId);
      assert.deepEqual(newProfile.generations,processed.generations);
      const space=await call('studio_voice_install_space',{variantId});
      assert(space.requiredBytes>0 && space.modelBytes>0 && typeof space.enough==='boolean');
    }
    for (const asset of ['multilingual_worker.py','multilingual-runtime.json','vendor/chatterbox/chatterbox/mtl_tts.py']) await fs.access(path.join(path.dirname(args.exe),'workers',asset));
    proofs.reopenFormat16=true;proofs.multilingualProfiles=2;proofs.multilingualSpacePreflight=true;
    assert(tools.some(t=>t.name==='studio_convert_voice_timbre') && tools.some(t=>t.name==='studio_microphone'));
    const beforeRecording=await call('studio_get_project');
    assert.equal((await call('studio_microphone',{action:'status',context:await context()})).phase,'idle');
    await call('studio_microphone',{action:'start',lineId:beforeRecording.dialogues[lineIndex].id,context:await context()});
    const captureUntil=Date.now()+30000;
    while(true){const mic=(await state()).microphone;if(mic.error)throw Error(JSON.stringify(mic));if(mic.phase==='recording'&&mic.durationMs>=750)break;if(Date.now()>captureUntil)throw Error('Synthetic WebView microphone did not start');await new Promise(r=>setTimeout(r,150));}
    await call('studio_microphone',{action:'stop',context:await context()});
    assert.equal((await state()).microphone.phase,'ready');
    await call('studio_microphone',{action:'save',context:await context()});
    const recorded=await call('studio_get_project');assert.equal(recorded.formatVersion,17);assert.equal(recorded.generations.length,beforeRecording.generations.length+1);assert.deepEqual(recorded.generations.slice(0,-1),beforeRecording.generations);
    const recording=recorded.generations.at(-1);assert.equal(recording.takeOrigin.type,'microphone');assert(recording.durationMs>=700);
    const capturedPath=await call('studio_generation_path',{id:recording.id});assert.equal(typeof capturedPath,'string');const bytes=await fs.readFile(capturedPath);assert.equal(bytes.toString('ascii',0,4),'RIFF');assert(bytes.length>44+700*48);let capturedPeak=0;for(let i=44;i+1<bytes.length;i+=2)capturedPeak=Math.max(capturedPeak,Math.abs(bytes.readInt16LE(i)));assert(capturedPeak>100,'WebView must capture the actual synthetic waveform, not just a silent clock');
    await call('studio_open_project',{path:projectRoot});assert.deepEqual((await call('studio_get_project')).generations,recorded.generations);
    const vcSpace=await call('studio_voice_install_space',{variantId:'chatterbox-vc'});assert(vcSpace.modelBytes===1056484620 && vcSpace.requiredBytes>vcSpace.modelBytes);
    await fs.access(path.join(path.dirname(args.exe),'workers/voice_conversion_worker.py'));
    proofs.microphonePcmCapture=true;proofs.microphoneOriginalsPreserved=true;proofs.reopenFormat17=true;proofs.voiceConversionSpacePreflight=true;
    // Real native DSP through the shipped UI/MCP, retaining every source/take.
    const effectsCatalog=await call('studio_audio_effects_catalog');assert.equal(effectsCatalog.effects.length,20);assert.equal(effectsCatalog.presets.length,12);
    await call('studio_select_take',{context:await context(),id:baseId});
    await call('studio_edit_voice',{context:await context(),id:baseId,startMs:0,endMs:2000,operation:{kind:'effects',effects:[{kind:'pitch',enabled:true,parameters:{semitones:4}}]}});
    const fxProject=await call('studio_get_project');assert.equal(fxProject.formatVersion,18);assert.equal(fxProject.voiceEdits[baseId].pieces[0].effects[0].parameters.semitones,4);
    const rendered=await call('studio_dubbing_path',{id:baseId,slotMs:2000,exactDuration:true,edit:fxProject.voiceEdits[baseId]});assert((await fs.stat(rendered)).size>44);
    assert.deepEqual(await fs.readFile(path.join(projectRoot,basePath)),baseWave);
    await call('studio_set_track',{context:await context(),id:'original',changes:{gain:4}});assert.equal((await call('studio_get_project')).tracks.find(t=>t.id==='original').gain,4);
    const fxOptions={trackId:'original',scope:'track',startMs:0,endMs:16000,effects:[{kind:'equalizer',enabled:true,parameters:{bass:6}}],replaceInMix:true,name:'Original FX'};
    await job(await effectJob(fxOptions));
    let fx=await call('studio_get_project'),record=fx.generations.find(g=>g.kind==='audioEffects');assert(record);const copyId=record.trackId,dryPath=record.effectsSourcePath,oldPath=record.path,trackCount=fx.tracks.length;
    assert.equal(fx.tracks.find(t=>t.id===copyId).gain,4);assert.equal(fx.tracks.find(t=>t.id==='original').mute,true);
    await job(await effectJob({...fxOptions,trackId:copyId,effects:[]}));
    fx=await call('studio_get_project');record=fx.generations.find(g=>g.kind==='audioEffects');assert.equal(fx.tracks.length,trackCount);assert.equal(record.effectsSourcePath,dryPath);assert.notEqual(record.path,oldPath);await fs.access(path.join(projectRoot,oldPath));
    await job(await effectJob({...fxOptions,scope:'selection',startMs:3000,endMs:4000,effects:[{kind:'echo',enabled:true,parameters:{}}]}));
    assert((await call('studio_get_project')).generations.some(g=>g.kind==='audioPatch'&&g.operation==='effects'));
    await call('studio_open_project',{path:projectRoot});assert.equal((await call('studio_get_project')).formatVersion,18);
    assert.equal(createHash('sha256').update(await fs.readFile(args.movie)).digest('hex'),originalHash);
    proofs.audioEffectsCatalog=20;proofs.voiceEffectsRendered=true;proofs.trackEffectsAndDryBaseline=true;proofs.selectionEffects=true;proofs.globalGain400=true;proofs.reopenFormat18=true;
    const qualityCatalog=await call('studio_voice_quality_catalog');
    assert.equal(Object.keys(qualityCatalog.variants).length,8);
    assert.deepEqual(qualityCatalog.variants['voxcpm2-bf16'].presets.natural,{inferenceSteps:20,cfgStrength:1.6});
    const beforeQuality=await call('studio_get_project');
    await call('studio_project_patch',{context:await context(),patches:[{op:'replace',path:'/formatVersion',value:19},{op:'replace',path:`/dialogues/${lineIndex}/voiceSettings`,value:{...voiceOptions,variantId:'voxcpm2-bf16',mood:'default',mode:'crossLingual',quality:{inferenceSteps:20,cfgStrength:1.6}}}]});
    await call('studio_open_project',{path:projectRoot});
    const qualityProject=await call('studio_get_project');assert.equal(qualityProject.formatVersion,19);assert.deepEqual(qualityProject.dialogues[lineIndex].voiceSettings.quality,{inferenceSteps:20,cfgStrength:1.6});assert.deepEqual(qualityProject.generations,beforeQuality.generations);
    proofs.qualityCatalog=8;proofs.reopenFormat19=true;proofs.qualityOldTakesPreserved=true;
    // One persisted bulk edit, including all existing generated/recorded takes.
    const reviewIds=qualityProject.dialogues.map(line=>line.id),reviewContext=await context();
    await call('studio_set_selection',{ids:reviewIds});
    assert.deepEqual((await state()).checkedIds,reviewIds);
    const reviewed=await call('studio_approve_translations',{context:reviewContext,ids:[...reviewIds,reviewIds[0]],approved:true});
    assert.equal((await call('studio_get_dialogues',{status:'approved'})).total,reviewIds.length);
    const reviewProject=await call('studio_get_project');
    for(const field of ['dialogues','generations','sourceCues','targetCues','tracks','voiceEdits','media'])assert.deepEqual(reviewProject[field],qualityProject[field]);
    const badReview=await client.callTool({name:'studio_approve_translations',arguments:{context:reviewed.context,ids:[reviewIds[0],'missing'],approved:false}});
    assert(badReview.isError);assert.deepEqual((await call('studio_get_project')).translationApprovals,reviewProject.translationApprovals);
    const staleReview=await client.callTool({name:'studio_approve_translations',arguments:{context:reviewContext,ids:reviewIds,approved:false}});assert(staleReview.isError);
    await call('studio_history',{context:reviewed.context,direction:'undo'});
    assert.equal((await call('studio_get_dialogues',{status:'approved'})).total,0);
    await call('studio_history',{context:await context(),direction:'redo'});
    assert.equal((await call('studio_get_dialogues',{status:'approved'})).total,reviewIds.length);
    await call('studio_approve_translations',{context:await context(),ids:reviewIds,approved:false});
    assert.equal((await call('studio_get_dialogues',{status:'approved'})).total,0);
    await call('studio_history',{context:await context(),direction:'undo'});
    await call('studio_open_project',{path:projectRoot});
    const reopenedReview=await call('studio_get_project');
    assert.deepEqual(reopenedReview.translationApprovals,reviewProject.translationApprovals);
    assert.deepEqual(reopenedReview.generations,qualityProject.generations);
    assert.deepEqual(await fs.readFile(path.join(projectRoot,basePath)),baseWave);
    proofs.bulkTranslationReview={atomic:true,undoRedo:true,reopen:true,staleAndUnknownRejected:true,voiceTakesPreserved:true};
    await fs.writeFile(args.proof,JSON.stringify(proofs,null,2)+'\n','utf8');
    console.log('MCP_NATIVE_PROOF '+JSON.stringify(proofs));
} catch(error){if(stderr)console.error(stderr.slice(-2000));throw error;}
finally {await client.close();}
