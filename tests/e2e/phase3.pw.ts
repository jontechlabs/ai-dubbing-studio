import { test, expect, type Page } from '@playwright/test';
import { demoProject } from '../../src/domain/project';
import fs from 'node:fs/promises';

function wav() {
  const samples=48000*16,bytes=Buffer.alloc(44+samples*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*4,40);
  for(let i=0;i<samples;i++){const value=Math.round(Math.sin(i/48000*440*2*Math.PI)*1000);bytes.writeInt16LE(value,44+i*4);bytes.writeInt16LE(value,46+i*4);}return bytes;
}
async function nativeMock(page: Page, large = false) {
  await page.route('**/preview.mp4',async route=>route.fulfill({status:200,contentType:'video/mp4',body:await fs.readFile('public/demo.mp4')}));
  await page.route('**/*.wav',route=>route.fulfill({status:200,contentType:'audio/wav',body:wav()}));
  await page.addInitScript(({initial})=>{
    const host=window as unknown as Record<string,any>,callbacks=new Map<number,(data:any)=>void>(),listeners=new Map<string,number>();let counter=0,project=structuredClone(initial),job:any;
    const emit=(name:string,payload:any)=>{const id=listeners.get(name);if(id)callbacks.get(id)?.({event:name,id,payload});};
    host.__calls=[];host.__downloadError=false;host.__installed=false;
    host.__runtimeStatus={installed:true,installing:false,devices:[{id:'cpu',name:'CPU'},{id:'cuda:0',name:'NVIDIA GPU'}],cudaVersion:'12.8',unavailableDevices:[]};
    host.__probeRuntime=()=>{job={...job,stage:'devicesCheck',progress:null,logs:['Model verified. Checking compute devices (maximum 30 seconds).']};emit('job-changed',job);};
    host.__completeRuntime=()=>{host.__runtimeStatus={installed:true,installing:false,devices:host.__probeFailed?[{id:'cpu',name:'CPU'}]:[{id:'cpu',name:'CPU'},{id:'cuda:0',name:'NVIDIA GeForce RTX 5060 Ti'}],deviceProbeWarning:host.__probeFailed?'DEVICE_PROBE_FAILED':null,cudaVersion:'12.8',unavailableDevices:[]};job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__completeSeparation=()=>{project.formatVersion=2;project.tracks.find((track:any)=>track.kind==='original').mute=true;for(const role of ['speech','music','sfx'])project.tracks.push({id:role,kind:'audio',role,path:`stems/run/${role}.wav`,durationMs:16000,sourcePath:project.media.path,language:'en',gain:1,mute:false,solo:false});project.revision++;emit('project-changed',structuredClone(project));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.isTauri=true;host.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
    host.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},convertFileSrc:(path:string)=>path.endsWith('.wav')?`/audio/${path.split('/').at(-1)}`:'/preview.mp4',transformCallback:(fn:(data:any)=>void)=>{const id=++counter;callbacks.set(id,fn);return id;},unregisterCallback:(id:number)=>callbacks.delete(id),invoke:async(command:string,args:any={})=>{
      host.__calls.push({command,args:JSON.parse(JSON.stringify(args))});
      if(command==='restore_project')return structuredClone(project);
      if(command==='list_jobs')return job?[job]:[];
      if(command==='media_path')return 'preview.mp4';
      if(command==='get_waveform')return {durationMs:16000,stepMs:20,audioStreamIndex:args.trackId?0:1,peaks:Array.from({length:800},(_,i)=>0.1+(i%9)/12)};
      if(command==='audio_paths')return Object.fromEntries(project.tracks.filter((track:any)=>track.kind==='audio').map((track:any)=>[track.id,track.path]));
      if(command==='environment')return {platform:'windows',ffmpeg:true,ffprobe:true};
      if(command==='graphics_info')return {preference:'auto',executable:'C:/Studio/ai-dubbing-studio.exe',adapters:[{Name:'Intel iGPU'},{Name:'NVIDIA GPU'}]};
      if(command==='set_graphics_preference'||command==='open_graphics_settings')return null;
      if(command==='separation_status')return structuredClone(host.__runtimeStatus);
      if(command==='install_separation_runtime'){job={id:'runtime',projectId:null,kind:'runtime',status:'running',stage:'dependencies',progress:null,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='separate_audio'){job={id:'separation',projectId:project.id,kind:'separation',status:'running',stage:'separate',progress:0.3,logs:[],error:null};emit('job-changed',job);return job.id;}
      if(command==='pause_job'){job={...job,status:args.paused?'paused':'running'};emit('job-changed',job);return null;}
      if(command==='cancel_job'){job={...job,status:'cancelled'};emit('job-changed',job);return null;}
      if(command==='replace_project'){if(args.expectedRevision!==project.revision)throw Error('STALE_REVISION');project={...structuredClone(args.project),revision:project.revision+1};return structuredClone(project);}
      if(command==='plugin:event|listen'){listeners.set(args.event,args.handler);return args.handler;}
      if(command==='plugin:event|unlisten'||command==='plugin:resources|close')return null;
      if(command==='plugin:updater|check')return {rid:45,currentVersion:'0.3.3',version:'0.3.4',body:'Performance et audio',rawJson:{}};
      if(command==='plugin:updater|download'){
        if(host.__downloadError)throw Error('Invalid signature');
        const channel=args.onEvent.id;callbacks.get(channel)?.({index:0,message:{event:'Started',data:{contentLength:100}}});callbacks.get(channel)?.({index:1,message:{event:'Progress',data:{chunkLength:100}}});callbacks.get(channel)?.({index:2,message:{event:'Finished'}});return 46;
      }
      if(command==='plugin:updater|install'){host.__installed=true;return null;}
      throw Error(`Unexpected mock command ${command}`);
    }};
  },{initial:(() => { const initial=demoProject();if(large){initial.sourceCues=Array.from({length:6000},(_,i)=>({id:`s${i}`,startMs:i*3000,endMs:i*3000+2000,text:`Source ${i}`}));initial.targetCues=initial.sourceCues.map((cue,i)=>({...cue,id:`t${i}`,text:`Texte ${i}`}));initial.dialogues=initial.sourceCues.map((cue,i)=>({id:`d${i}`,startMs:cue.startMs,endMs:cue.endMs,sourceCueIds:[cue.id],targetCueIds:[`t${i}`],ttsText:null,characterId:null,status:'ungenerated',warnings:[],selectedGenerationIds:{}}));}return initial;})()});
}

test('large projects do not rebuild subtitle blocks while video plays',async({page})=>{
  await nativeMock(page,true);await page.goto('/');await expect(page.locator('.count-badge')).toHaveText('6000');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
  await page.evaluate(()=>{const host=window as any;host.__blockMutations=0;const observer=new MutationObserver((changes)=>{host.__blockMutations+=changes.filter((change)=>(change.target as HTMLElement).classList?.contains('subtitle-block')).length;});observer.observe(document.querySelector('.timeline-content')!,{subtree:true,attributes:true,childList:true});});
  await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect.poll(()=>page.locator('video').evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeGreaterThan(2);
  expect(await page.evaluate(()=>(window as any).__blockMutations)).toBe(0);await page.getByRole('button',{name:'Pause',exact:true}).click();
});

test('separation preserves unsaved editing; tracks, mixer and pause are persistent',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await nativeMock(page);await page.goto('/');
  await page.getByRole('button',{name:'Audio',exact:true}).click();await page.getByRole('combobox',{name:'Processeur de séparation audio'}).selectOption('cpu');
  await page.getByRole('button',{name:'Séparer voix / musique / effets'}).click();await expect(page.getByRole('dialog',{name:'Traitements'})).toBeVisible();
  await page.getByRole('button',{name:'Mettre en pause',exact:true}).click();await expect(page.getByRole('button',{name:'Reprendre',exact:true})).toBeVisible();await page.getByRole('button',{name:'Reprendre',exact:true}).click();
  await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.getByRole('button',{name:/Réplique 1 ·/}).click();
  const field=page.getByRole('textbox',{name:'Sous-titre affiché',exact:true});await field.fill('Texte modifié pendant le calcul');await page.evaluate(()=>(window as any).__completeSeparation());
  await expect(field).toHaveValue('Texte modifié pendant le calcul');await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await expect(page.locator('.track-label')).toHaveCount(7);await page.getByRole('button',{name:'Audio',exact:true}).click();
  await page.getByRole('button',{name:'Solo Voix',exact:true}).click();await page.getByRole('slider',{name:'Volume de piste Voix'}).fill('0.4');await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.screenshot({path:'test-results/screenshots/studio-audio.png'});await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect.poll(()=>page.locator('video').evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeGreaterThan(1);
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const saved=await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.command==='replace_project').at(-1).args.project);
  expect(saved.formatVersion).toBe(2);expect(saved.tracks.find((track:any)=>track.id==='speech')).toMatchObject({solo:true,gain:0.4});expect(saved.targetCues[0].text).toBe('Texte modifié pendant le calcul');expect(errors).toEqual([]);
});

test('GPU preference and signed update flow reject failure and save before install',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.getByRole('button',{name:'Paramètres',exact:true}).click();
  await page.getByRole('combobox',{name:'Préférence GPU du lecteur'}).selectOption('performance');await expect(page.getByText('Redémarre l’application pour appliquer cette préférence.')).toBeVisible();
  await page.getByRole('button',{name:'Rechercher une mise à jour'}).click();await expect(page.getByText('La version 0.3.4 est disponible.')).toBeVisible();
  await page.evaluate(()=>(window as any).__downloadError=true);await page.getByRole('button',{name:'Télécharger la mise à jour'}).click();await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button',{name:'Installer et redémarrer'})).toHaveCount(0);await page.evaluate(()=>(window as any).__downloadError=false);
  await page.getByRole('button',{name:'Télécharger la mise à jour'}).click();await expect(page.getByText(/Téléchargement terminé, signature vérifiée/)).toBeVisible();
  await page.screenshot({path:'test-results/screenshots/studio-updates.png'});await page.getByRole('button',{name:'Installer et redémarrer'}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__installed)).toBe(true);
  expect(await page.evaluate(()=>(window as any).__calls.some((call:any)=>call.command==='set_graphics_preference'&&call.args.choice==='performance'))).toBe(true);
});

test('an existing CUDA installation can be repaired for an incompatible RTX GPU', async ({page}) => {
  await nativeMock(page); await page.goto('/');
  await page.evaluate(() => { (window as any).__runtimeStatus = {installed:true,installing:false,cudaVersion:'12.6',devices:[{id:'cpu',name:'CPU'}],unavailableDevices:[{id:'cuda:0',name:'NVIDIA GeForce RTX 5060 Ti',reason:'no kernel image'}]}; });
  await page.getByRole('button',{name:'Audio',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('RTX 5060 Ti');
  const processor = page.getByRole('combobox',{name:'Processeur de séparation audio'});
  await expect(processor.locator('option')).toHaveCount(2);
  await page.getByRole('button',{name:'Modifier ou réparer l’installation Bandit'}).click();
  await expect(page.getByRole('checkbox',{name:/NVIDIA CUDA 12.8/})).toBeChecked();
  await page.getByRole('button',{name:'Réinstaller Bandit',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Traitements'})).toBeVisible();
  expect(await page.evaluate(() => (window as any).__calls.some((call:any) => call.command==='install_separation_runtime' && call.args.cuda===true))).toBe(true);
  await page.evaluate(() => (window as any).__completeRuntime());
  await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.getByRole('button',{name:'Audio',exact:true}).click();
  await expect(processor.locator('option')).toHaveCount(3);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await processor.selectOption('cuda:0');
});

test('device check has its own indeterminate stage and a recoverable CPU fallback', async ({page}) => {
  await nativeMock(page); await page.goto('/');
  await page.evaluate(() => { (window as any).__runtimeStatus = {installed:false,installing:false,devices:[]}; });
  await page.getByRole('button',{name:'Audio',exact:true}).click();
  await page.getByRole('button',{name:'Installer Bandit',exact:true}).click();
  await page.evaluate(() => (window as any).__probeRuntime());
  await expect(page.getByRole('dialog',{name:'Traitements'}).getByText('Vérification des processeurs de calcul (30 s maximum)',{exact:true})).toBeVisible();
  await expect(page.locator('.job-card progress')).not.toHaveAttribute('value');
  await page.screenshot({path:'test-results/screenshots/studio-bandit-check.png'});
  await page.evaluate(() => { (window as any).__probeFailed = true; (window as any).__completeRuntime(); });
  await expect(page.getByText('Terminé',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.getByRole('button',{name:'Audio',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Bandit reste utilisable sur CPU');
  await expect(page.getByRole('button',{name:'Séparer voix / musique / effets'})).toBeEnabled();
  await expect(page.getByRole('combobox',{name:'Processeur de séparation audio'}).locator('option')).toHaveCount(2);
  await page.getByRole('button',{name:'Séparer voix / musique / effets'}).click();
  expect(await page.evaluate(() => (window as any).__calls.filter((call:any) => call.command==='separate_audio').at(-1).args.device)).toBe('cpu');
  await page.getByRole('button',{name:'Annuler',exact:true}).click();
  await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.getByRole('button',{name:'Audio',exact:true}).click();
  await page.evaluate(() => { (window as any).__probeFailed = false; (window as any).__completeRuntime(); });
  await page.getByRole('button',{name:'Actualiser les processeurs',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'Processeur de séparation audio'}).locator('option')).toHaveCount(3);
});
