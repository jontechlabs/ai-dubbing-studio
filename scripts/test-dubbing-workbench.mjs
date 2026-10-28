import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
export async function verifyDubbingWorkbench({client,call,context}){
 const tools=(await client.listTools()).tools;
 const required=['generate_dubbing_pipeline','audio_toolbox_status','install_audio_toolbox_model','separate_audio_selection','audio_toolbox_result','audio_toolbox_path','apply_audio_toolbox_result'];
 for(const name of required)assert(tools.some(t=>t.name==='studio_'+name));
 for(const name of ['generate_dubbing_pipeline','separate_audio_selection','audio_toolbox_result','audio_toolbox_path','apply_audio_toolbox_result'])assert(tools.find(t=>t.name==='studio_'+name).inputSchema.required.includes('context'));
 const before=await call('studio_get_project');
 const status=await call('studio_audio_toolbox_status');assert.equal(status.models.length,5);assert(status.availableBytes>0);
 assert.deepEqual(new Set(status.models.find(m=>m.id==='htdemucs').outputs),new Set(['vocals','drums','bass','other']));assert(status.models.every(m=>!m.installed&&m.requiredBytes>m.modelBytes));
 const ctx=await context();
 for(const [name,args,code] of [
  ['studio_generate_dubbing_pipeline',{context:ctx,options:{lineId:before.dialogues[0].id,tts:{device:'cpu',referenceMode:'current',referenceId:null,mode:'crossLingual',speed:1,seed:0},conversion:{generationId:'pipeline',referenceId:'',characterId:null,referenceMode:'current',device:'cpu'},guideStrength:0}},'TTS_MODEL_REQUIRED'],
  ['studio_separate_audio_selection',{context:ctx,options:{modelId:'mel-band-roformer-kim',sourceTrackId:'original',startMs:0,endMs:1000,device:'cpu',prompt:'',windowSeconds:4}},'AUDIO_TOOLBOX_MODEL_REQUIRED'],
  ['studio_audio_toolbox_result',{context:ctx,id:'missing'},'INVALID_JOB'],
  ['studio_audio_toolbox_path',{context:ctx,id:'missing',outputId:'vocals'},'INVALID_JOB'],
  ['studio_apply_audio_toolbox_result',{context:ctx,id:'missing',destinations:[{outputId:'vocals',trackId:null,role:'speech'}],muteSource:false},'INVALID_JOB'],
 ]){const response=await client.callTool({name,arguments:args});assert(response.isError);assert(response.content.some(c=>c.text?.includes(code)),JSON.stringify(response));}
 assert.deepEqual(await call('studio_get_project'),before);
 const guide=await client.readResource({uri:'studio://guide'});assert(guide.contents[0].text.includes('studio_generate_dubbing_pipeline'));assert(guide.contents[0].text.includes('studio_apply_audio_toolbox_result'));
 // The dialogue reference audition goes through the real selected-track native
 // snippet command. It must return a usable local WAV and leave project state.
 const line=before.dialogues.find(l=>l.endMs-l.startMs>=1000);
 if(line){const file=await call('studio_preview_character_sample',{context:await context(),lineId:line.id,trackId:'original'});const wav=await fs.readFile(file);assert.equal(wav.toString('ascii',0,4),'RIFF');assert(wav.length>44);assert.deepEqual(await call('studio_get_project'),before);}
 return {tools:required.length,isolatedModelStatus:true,missingModelsFailBeforeGeneration:true,readAndApplyContextGuards:true,previewReferenceWav:true,projectAndTakesUnchanged:true};
}
