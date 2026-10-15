import { type Page } from '@playwright/test';
import { demoProject } from '../../src/domain/project';
import fs from 'node:fs/promises';
export function wav(seconds=16) {
  const samples=48000*seconds,bytes=Buffer.alloc(44+samples*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*4,40);
  for(let i=0;i<samples;i++){const value=Math.round(Math.sin(i/48000*440*2*Math.PI)*1000);bytes.writeInt16LE(value,44+i*4);bytes.writeInt16LE(value,46+i*4);}return bytes;
}
export async function nativeMock(page: Page, large = false) {
  await page.route('**/preview.mp4',async route=>route.fulfill({status:200,contentType:'video/mp4',body:await fs.readFile('public/demo.mp4')}));
  await page.route('**/*.wav',route=>route.fulfill({status:200,contentType:'audio/wav',body:wav(/\/(speech|music|sfx)\.wav$/.test(new URL(route.request().url()).pathname)?16:4)}));
  await page.addInitScript(({initial})=>{
    const host=window as unknown as Record<string,any>,callbacks=new Map<number,(data:any)=>void>(),listeners=new Map<string,number>();let counter=0,project=JSON.parse(localStorage.getItem('nativeMockProject')||'null')||structuredClone(initial),job:any;
    const emit=(name:string,payload:any)=>{const id=listeners.get(name);if(id)callbacks.get(id)?.({event:name,id,payload});};
    host.__calls=[];host.__downloadError=false;host.__installed=false;
    host.__ttsReady=true;host.__pendingTts=null;
    host.__completeTts=(durationMs=2000)=>{
      const {lineId,options}=host.__pendingTts,line=project.dialogues.find((d:any)=>d.id===lineId),id=`take-${project.generations.filter((g:any)=>g.kind==='tts').length+1}`;
      const text=line.ttsText??project.targetCues.filter((c:any)=>line.targetCueIds.includes(c.id)).map((c:any)=>c.text).join('\n');
      const generation={id,kind:'tts',dialogueId:lineId,providerId:options.variantId?.startsWith('fish')?'fish-s2':options.variantId?.startsWith('qwen')?'qwen3-tts':'cosyvoice3',modelId:options.variantId??'cosy3-official',path:`generations/${id}.wav`,createdAt:new Date().toISOString(),sourcePath:project.media.path,startMs:line.startMs,endMs:line.endMs,text,language:project.languages.target,characterId:line.characterId,durationMs,sampleRate:24000,options,referenceTranscript:'Hello',device:options.device,deviceName:'NVIDIA RTX 5060 Ti (simulation)',peakVramMb:0,inputHash:'mock'};
      project.generations.push(generation);project.formatVersion=5;line.selectedGenerationIds[project.languages.target]=id;line.status=durationMs>line.endMs-line.startMs?'review':'generated';project.revision++;emit('project-changed',structuredClone(project));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);localStorage.setItem('nativeMockProject',JSON.stringify(project));
    };
    host.__replaceMedia=()=>{project.media.id+='-replacement';project.tracks.find((track:any)=>track.kind==='original').mute=true;project.revision++;emit('project-changed',structuredClone(project));};
    host.__completeModelMove=()=>{host.__modelFolder=host.__pendingModelFolder;job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__speakerStatus={installed:true,installing:false,sizeBytes:72500000};
    host.__completeSpeakerAnalysis=()=>{project.formatVersion=Math.max(3,project.formatVersion);project.speakerAnalysis={id:'speakers',sourcePath:project.media.path,lines:project.dialogues.map(({id,startMs,endMs}:any)=>({id,startMs,endMs})),assignments:project.dialogues.map((line:any,index:number)=>({dialogueId:line.id,speaker:index%2,similarity:0.95,reason:'identified'})),clusters:[0,1].map((speaker)=>({speaker,referencePath:`characters/reference-${speaker}.wav`,durationMs:4000,referenceDialogueId:project.dialogues[speaker].id}))};project.revision++;emit('project-changed',structuredClone(project));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__runtimeStatus={installed:true,installing:false,devices:[{id:'cpu',name:'CPU'},{id:'cuda:0',name:'NVIDIA GPU'}],cudaVersion:'12.8',unavailableDevices:[]};
    host.__probeRuntime=()=>{job={...job,stage:'devicesCheck',progress:null,logs:['Model verified. Checking compute devices (maximum 30 seconds).']};emit('job-changed',job);};
    host.__completeRuntime=()=>{host.__runtimeStatus={installed:true,installing:false,devices:host.__probeFailed?[{id:'cpu',name:'CPU'}]:[{id:'cpu',name:'CPU'},{id:'cuda:0',name:'NVIDIA GeForce RTX 5060 Ti'}],deviceProbeWarning:host.__probeFailed?'DEVICE_PROBE_FAILED':null,cudaVersion:'12.8',unavailableDevices:[]};job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__completeSeparation=()=>{project.formatVersion=Math.max(2,project.formatVersion);project.tracks.find((track:any)=>track.kind==='original').mute=true;for(const role of ['speech','music','sfx'])project.tracks.push({id:role,kind:'audio',role,path:`stems/run/${role}.wav`,durationMs:16000,sourcePath:project.media.path,language:'en',gain:1,mute:false,solo:false});project.revision++;emit('project-changed',structuredClone(project));job={id:'separation',projectId:project.id,kind:'separation',logs:[],error:null,...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.isTauri=true;host.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
    host.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},convertFileSrc:(path:string)=>path.endsWith('.wav')?`/audio/${path.split('/').at(-1)}`:'/preview.mp4',transformCallback:(fn:(data:any)=>void)=>{const id=++counter;callbacks.set(id,fn);return id;},unregisterCallback:(id:number)=>callbacks.delete(id),invoke:async(command:string,args:any={})=>{
      host.__calls.push({command,args:JSON.parse(JSON.stringify(args))});
      if(command==='restore_project')return structuredClone(project);
      if(command==='voice_status')return {variants:Object.entries({'fish-s2-gguf-q8':6317911232,'qwen3-06b-gguf-q8':1991211136,'qwen3-17b-gguf-q8':2695175104,'fish-s2-fp8':8047624252}).map(([id,sizeBytes])=>({id,installed:true,sizeBytes})),devices:[{id:'vulkan:0',name:'Ryzen iGPU (simulation)'},{id:'vulkan:1',name:'RTX 5060 Ti (simulation)',discrete:true},{id:'cpu',name:'CPU'}],cudaDevices:[{id:'cuda:0',name:'RTX 5060 Ti (simulation)'}]};
        if(command==='install_voice_runtime')return 'install-voice';
        if(command==='tts_status')return {installed:host.__ttsReady,installing:false,sizeBytes:5427042285,inventory:{devices:[{id:'cpu',name:'CPU'},{id:'cuda:0',name:'NVIDIA RTX 5060 Ti (simulation)'}],cudaVersion:'12.8'}};
      if(command==='install_tts_runtime'){job={id:'tts-install',projectId:'',kind:'ttsInstall',status:'running',stage:'dependencies',progress:null,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='generate_line'){host.__pendingTts=structuredClone(args);job={id:'tts-job',projectId:project.id,kind:'tts',status:'running',stage:'ttsGenerate',progress:null,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='generation_path')return `C:/Studio/generations/${args.id}.wav`;
      if(command==='export_generation')return null;
      if(command==='list_jobs')return job?[job]:[];
      if(command==='media_path')return 'preview.mp4';
      if(command==='get_waveform')return {durationMs:16000,stepMs:20,audioStreamIndex:args.trackId?0:1,peaks:Array.from({length:800},(_,i)=>0.1+(i%9)/12)};
      if(command==='audio_paths')return Object.fromEntries(project.tracks.filter((track:any)=>track.kind==='audio').map((track:any)=>[track.id,track.path]));
      if(command==='model_storage_info')return {path:host.__modelFolder||'C:/Studio/models',defaultPath:'C:/Studio/models',moving:job?.kind==='modelMove'&&job.status==='running'};
      if(command==='model_storage_size'){if(host.__sizeError)throw Error('disk unavailable');return {path:host.__modelFolder||'C:/Studio/models',bytes:host.__modelBytes??4831838208,files:974,skipped:0,partial:false};}
      if(command==='plugin:dialog|save')return 'C:/Exports/speech-montage.wav';
      if(command==='export_audio_track'){job={id:'export',projectId:project.id,kind:'audioExport',status:'running',stage:'audioRender',progress:0.5,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='plugin:dialog|open')return 'D:/AI Models';
      if(command==='change_model_storage'){host.__pendingModelFolder=args.path;job={id:'modelMove',projectId:'',kind:'modelMove',status:'running',stage:'modelMove',progress:0.4,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='environment')return {platform:'windows',ffmpeg:true,ffprobe:true};
      if(command==='graphics_info')return {preference:'auto',executable:'C:/Studio/ai-dubbing-studio.exe',adapters:[{Name:'Intel iGPU'},{Name:'NVIDIA GPU'}]};
      if(command==='set_graphics_preference'||command==='open_graphics_settings')return null;
      if(command==='separation_status')return structuredClone(host.__runtimeStatus);
      if(command==='speaker_status')return structuredClone(host.__speakerStatus);
      if(command==='identify_speakers'){job={id:'speakers',projectId:project.id,kind:'speakers',status:'running',stage:'speakerEmbeddings',progress:0.3,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='voice_reference_path')return `C:/Studio/characters/${args.referenceId}.wav`;
      if(command==='install_separation_runtime'){job={id:'runtime',projectId:null,kind:'runtime',status:'running',stage:'dependencies',progress:null,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='separate_audio'){job={id:'separation',projectId:project.id,kind:'separation',status:'running',stage:'separate',progress:0.3,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='pause_job'){job={...job,status:args.paused?'paused':'running'};emit('job-changed',job);return null;}
      if(command==='cancel_job'){job={...job,status:'cancelled'};emit('job-changed',job);return null;}
      if(command==='replace_project'){if(args.expectedRevision!==project.revision)throw Error('STALE_REVISION');project={...structuredClone(args.project),revision:project.revision+1};localStorage.setItem('nativeMockProject',JSON.stringify(project));return structuredClone(project);}
      if(command==='plugin:event|listen'){listeners.set(args.event,args.handler);return args.handler;}
      if(command==='plugin:event|unlisten'||command==='plugin:resources|close')return null;
      if(command==='plugin:updater|check')return {rid:45,currentVersion:'0.5.0',version:'0.5.1',body:'Performance et audio',rawJson:{}};
      if(command==='plugin:updater|download'){
        if(host.__downloadError)throw Error('Invalid signature');
        const channel=args.onEvent.id;callbacks.get(channel)?.({index:0,message:{event:'Started',data:{contentLength:100}}});callbacks.get(channel)?.({index:1,message:{event:'Progress',data:{chunkLength:100}}});callbacks.get(channel)?.({index:2,message:{event:'Finished'}});return 46;
      }
      if(command==='plugin:updater|install'){host.__installed=true;return null;}
      throw Error(`Unexpected mock command ${command}`);
    }};
  },{initial:(() => { const initial=demoProject();if(large){initial.sourceCues=Array.from({length:6000},(_,i)=>({id:`s${i}`,startMs:i*3000,endMs:i*3000+2000,text:`Source ${i}`}));initial.targetCues=initial.sourceCues.map((cue,i)=>({...cue,id:`t${i}`,text:`Texte ${i}`}));initial.dialogues=initial.sourceCues.map((cue,i)=>({id:`d${i}`,startMs:cue.startMs,endMs:cue.endMs,sourceCueIds:[cue.id],targetCueIds:[`t${i}`],ttsText:null,characterId:null,status:'ungenerated',warnings:[],selectedGenerationIds:{}}));}return initial;})()});
}

