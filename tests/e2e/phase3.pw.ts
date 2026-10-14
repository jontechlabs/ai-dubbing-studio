import { test, expect, type Page } from '@playwright/test';
import { demoProject } from '../../src/domain/project';
import fs from 'node:fs/promises';

function wav(seconds=16) {
  const samples=48000*seconds,bytes=Buffer.alloc(44+samples*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*4,40);
  for(let i=0;i<samples;i++){const value=Math.round(Math.sin(i/48000*440*2*Math.PI)*1000);bytes.writeInt16LE(value,44+i*4);bytes.writeInt16LE(value,46+i*4);}return bytes;
}
async function nativeMock(page: Page, large = false) {
  await page.route('**/preview.mp4',async route=>route.fulfill({status:200,contentType:'video/mp4',body:await fs.readFile('public/demo.mp4')}));
  await page.route('**/*.wav',route=>route.fulfill({status:200,contentType:'audio/wav',body:wav(/\/(speech|music|sfx)\.wav$/.test(new URL(route.request().url()).pathname)?16:4)}));
  await page.addInitScript(({initial})=>{
    const host=window as unknown as Record<string,any>,callbacks=new Map<number,(data:any)=>void>(),listeners=new Map<string,number>();let counter=0,project=JSON.parse(localStorage.getItem('nativeMockProject')||'null')||structuredClone(initial),job:any;
    const emit=(name:string,payload:any)=>{const id=listeners.get(name);if(id)callbacks.get(id)?.({event:name,id,payload});};
    host.__calls=[];host.__downloadError=false;host.__installed=false;
    host.__replaceMedia=()=>{project.media.id+='-replacement';project.tracks.find((track:any)=>track.kind==='original').mute=true;project.revision++;emit('project-changed',structuredClone(project));};
    host.__completeModelMove=()=>{host.__modelFolder=host.__pendingModelFolder;job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
    host.__speakerStatus={installed:true,installing:false,sizeBytes:72500000};
    host.__completeSpeakerAnalysis=()=>{project.formatVersion=3;project.speakerAnalysis={id:'speakers',sourcePath:project.media.path,lines:project.dialogues.map(({id,startMs,endMs}:any)=>({id,startMs,endMs})),assignments:project.dialogues.map((line:any,index:number)=>({dialogueId:line.id,speaker:index%2,similarity:0.95,reason:'identified'})),clusters:[0,1].map((speaker)=>({speaker,referencePath:`characters/reference-${speaker}.wav`,durationMs:4000,referenceDialogueId:project.dialogues[speaker].id}))};project.revision++;emit('project-changed',structuredClone(project));job={...job,status:'succeeded',stage:'done',progress:1};emit('job-changed',job);};
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
      if(command==='model_storage_info')return {path:host.__modelFolder||'C:/Studio/models',defaultPath:'C:/Studio/models',moving:job?.kind==='modelMove'&&job.status==='running'};
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
      if(command==='plugin:updater|check')return {rid:45,currentVersion:'0.4.1',version:'0.4.2',body:'Performance et audio',rawJson:{}};
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
  await page.getByRole('button',{name:'Rechercher une mise à jour'}).click();await expect(page.getByText('La version 0.4.2 est disponible.')).toBeVisible();
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

test('AI speaker proposals preserve manual corrections and expose editable voice references',async({page})=> {
  await nativeMock(page);await page.goto('/');await page.getByRole('button',{name:/Réplique 1 ·/}).click();
  await page.getByRole('button',{name:'Personnages',exact:true}).click();
  await page.getByRole('textbox',{name:'Nom du personnage',exact:true}).fill('Narrateur');await page.getByRole('button',{name:'Ajouter',exact:true}).click();
  await page.getByRole('button',{name:'Assigner la réplique sélectionnée'}).click();await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.getByRole('button',{name:'Identifier les locuteurs par IA',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Traitements'})).toBeVisible();await page.evaluate(()=>(window as any).__completeSpeakerAnalysis());
  await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.getByRole('button',{name:'Personnages',exact:true}).click();
  await expect(page.getByText('2 groupes de voix proposés')).toBeVisible();await page.getByRole('button',{name:'Créer les personnages et assigner les répliques'}).click();
  await expect(page.getByRole('combobox',{name:'Personnage',exact:true}).locator('option')).toHaveCount(3);
  await page.getByRole('combobox',{name:'Personnage',exact:true}).selectOption({label:'Speaker 1'});
  await page.getByRole('textbox',{name:'Renommer le personnage'}).fill('Shin');
  await expect(page.getByText('Référence par défaut',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/screenshots/studio-characters.png'});
  await page.locator('.panel-body').evaluate((element)=>{element.scrollTop=element.scrollHeight;});await page.screenshot({path:'test-results/screenshots/studio-references.png'});
  await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Personnage 1',exact:true})).toHaveValue(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.command==='replace_project').at(-1).args.project.characters.find((character:any)=>character.name==='Narrateur').id));
  await page.getByRole('button',{name:'Modèles',exact:true}).click();await expect(page.getByText(/aucun audio de doublage/)).toBeVisible();
  await page.getByRole('combobox',{name:'Moteur de voix prévu pour ce projet'}).selectOption('cosyvoice3');
  await page.screenshot({path:'test-results/screenshots/studio-models.png'});await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const saved=await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.command==='replace_project').at(-1).args.project);
  expect(saved.modelPreferences.ttsProviderId).toBe('cosyvoice3');expect(saved.dialogues[0].characterId).toBe(saved.characters.find((character:any)=>character.name==='Narrateur').id);expect(saved.characters.find((character:any)=>character.name==='Shin').references).toHaveLength(1);
});

test('manual characters, inline translation and timeline preview controls persist after reload',async({page})=> {
  await page.goto('/');await page.getByRole('button',{name:'Explorer l’exemple'}).click();await page.getByRole('button',{name:/Réplique 1 ·/}).click();
  await page.getByRole('button',{name:'Personnages',exact:true}).click();await page.getByRole('textbox',{name:'Nom du personnage',exact:true}).fill('Shin');await page.getByRole('button',{name:'Ajouter',exact:true}).click();await page.getByRole('button',{name:'Assigner la réplique sélectionnée'}).click();await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.getByRole('textbox',{name:'Sous-titre affiché',exact:true}).fill('');
  await page.locator('.dialogue-card').first().getByRole('button',{name:'Ajouter une traduction',exact:true}).click();
  const translation=page.getByRole('textbox',{name:'Sous-titre affiché',exact:true});await expect(translation).toBeFocused();await translation.pressSequentially('Bonjour Shin');await expect(translation).toHaveValue('Bonjour Shin');
  await page.getByRole('button',{name:'Afficher Sous-titres source',exact:true}).click();await page.locator('video').evaluate((video:HTMLVideoElement)=>{video.currentTime=2;});await expect(page.locator('.subtitle-overlay')).toContainText('Every story');await expect(page.locator('.subtitle-overlay')).toContainText('Bonjour Shin');
  await page.getByRole('button',{name:'Masquer Sous-titres source',exact:true}).click();await expect(page.locator('.subtitle-overlay')).not.toContainText('Every story');await page.getByRole('button',{name:'Masquer Sous-titres cible',exact:true}).click();await expect(page.locator('.subtitle-overlay')).toHaveText('');
  await page.getByRole('button',{name:'Couper Audio original',exact:true}).click();await expect(page.getByRole('button',{name:'Activer Audio original',exact:true})).toHaveAttribute('aria-pressed','false');await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.screenshot({path:'test-results/screenshots/studio-track-controls.png'});await page.reload();await expect(page.getByRole('combobox',{name:'Personnage 1',exact:true}).locator('option:checked')).toHaveText('Shin');await expect(page.getByRole('combobox',{name:'Sous-titres du lecteur'})).toHaveValue('off');await expect(page.getByRole('button',{name:'Activer Audio original',exact:true})).toHaveAttribute('aria-pressed','false');
});

test('translated SRT can be synchronized automatically during file import',async({page})=> {
  await page.goto('/');await page.getByRole('button',{name:'Explorer l’exemple'}).click();
  const starts=[1000,5800,13300,21000,29100,41800,55400,73000],lengths=[1700,2200,3600,1900,2900,1800,4100,2100];
  const stamp=(ms:number)=>`${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;
  for(const [role,shift,label] of [['SRT original',0,'Original'],['SRT traduit',2300,'Traduction']] as const) {
    await page.getByRole('button',{name:role,exact:true}).click();if(shift===0)await page.getByRole('checkbox',{name:/Caler automatiquement le SRT importé/}).uncheck();
    const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Choisir un fichier SRT'}).click();const text=starts.map((start,index)=>`${index+1}\n${stamp(start+shift)} --> ${stamp(start+lengths[index]+shift)}\n${label} ${index}`).join('\n\n');await(await chooser).setFiles({name:'timing.srt',mimeType:'text/plain',buffer:Buffer.from(text)});await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await expect(page.locator('.count-badge')).toHaveText('8');await page.getByRole('button',{name:/Réplique 1 ·/}).click();await expect(page.getByRole('textbox',{name:'Début',exact:true})).toHaveValue('00:00:01.000');await expect(page.getByRole('textbox',{name:'Sous-titre affiché',exact:true})).toHaveValue('Traduction 0');
});

test('ambiguous synchronization keeps the translated SRT imported without changing original timings',async({page})=> {
  await page.goto('/');await page.getByRole('button',{name:'Explorer l’exemple'}).click();await page.getByRole('button',{name:'SRT traduit',exact:true}).click();
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Choisir un fichier SRT'}).click();await(await chooser).setFiles({name:'different.srt',mimeType:'text/plain',buffer:Buffer.from('1\n00:00:10,000 --> 00:00:11,000\nAutre 1\n\n2\n00:00:30,000 --> 00:00:31,000\nAutre 2\n\n3\n00:01:10,000 --> 00:01:11,000\nAutre 3')});
  await expect(page.getByRole('alert')).toContainText('SRT importé. Calage automatique non appliqué');await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.getByRole('button',{name:'Exporter',exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'Exporter project.json',exact:true}).click();const stream=await(await download).createReadStream();let text='';for await(const bytes of stream!)text+=bytes.toString();const project=JSON.parse(text);
  expect(project.targetCues).toHaveLength(3);expect(project.targetCues[0].startMs).toBe(10000);expect(project.sourceCues[0].startMs).toBe(750);
});
test('model storage selection shows progress and switches the active folder only on completion',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.getByRole('button',{name:'Paramètres',exact:true}).click();
  const path=page.getByRole('textbox',{name:'Dossier des modèles',exact:true});await expect(path).toHaveValue('C:/Studio/models');
  await page.getByRole('button',{name:'Choisir un dossier',exact:true}).click();await expect(path).toHaveValue('D:/AI Models');
  await page.getByRole('button',{name:'Appliquer et déplacer',exact:true}).click();
  await expect(page.getByRole('progressbar',{name:'Progression du déplacement des modèles'})).toHaveAttribute('value','0.4');
  await expect(page.getByRole('button',{name:'Appliquer et déplacer',exact:true})).toBeDisabled();await expect(page.locator('.model-storage-current')).toContainText('C:/Studio/models');
  await page.screenshot({path:'test-results/screenshots/studio-model-storage.png'});
  await page.evaluate(()=>(window as any).__completeModelMove());await expect(path).toHaveValue('D:/AI Models');
  await expect(page.getByText('Modèles déplacés. Le nouveau dossier est actif.')).toBeVisible();
  await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.getByRole('button',{name:'Paramètres',exact:true}).click();await expect(path).toHaveValue('D:/AI Models');
  await page.getByRole('button',{name:'Utiliser le dossier par défaut'}).click();await expect(path).toHaveValue('C:/Studio/models');
});

async function measureAudio(page:Page) {
  await page.addInitScript(()=>{
    const host=window as any, taps:{node:AudioNode;analyser:AnalyserNode;connected:boolean}[]=[];
    const connect=AudioNode.prototype.connect,disconnect=AudioNode.prototype.disconnect;
    AudioNode.prototype.connect=function(...args:any[]) {
      const result=(connect as any).apply(this,args);
      if(this instanceof GainNode && args[0]===this.context.destination) {
        const analyser=this.context.createAnalyser();analyser.fftSize=1024;(connect as any).call(this,analyser);taps.push({node:this,analyser,connected:true});
      }
      return result;
    };
    AudioNode.prototype.disconnect=function(...args:any[]){for(const tap of taps)if(tap.node===this)tap.connected=false;return(disconnect as any).apply(this,args);};
    host.__rms=()=>Math.max(0,...taps.filter(tap=>tap.connected&&tap.node.context.state==='running').map(tap=>{const data=new Float32Array(tap.analyser.fftSize);tap.analyser.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length);}));
  });
}

test('real audio output becomes silent when all tracks are disabled and resumes only the selected stem',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await nativeMock(page);await measureAudio(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeGreaterThan(0.001);
  await page.getByRole('button',{name:'Couper Audio original',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeLessThan(0.000001);await expect(page.locator('video')).toHaveJSProperty('muted',true);
  await page.getByRole('button',{name:'Activer Audio original',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeGreaterThan(0.001);
  await page.evaluate(()=>(window as any).__completeSeparation());await expect(page.locator('.track-label')).toHaveCount(7);
  for(const name of ['Voix','Musique','Effets'])await page.getByRole('button',{name:'Couper '+name,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeLessThan(0.000001);await expect(page.locator('video')).toHaveJSProperty('muted',true);
  await page.getByRole('button',{name:'Activer Voix',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeGreaterThan(0.005);
  await page.getByRole('button',{name:'Couper Voix',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeLessThan(0.000001);await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.screenshot({path:'test-results/screenshots/studio-track-controls.png'});
  await page.reload();await expect(page.locator('video')).toHaveJSProperty('muted',true);await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeLessThan(0.000001);await expect.poll(()=>page.locator('video').evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test('a failed audio graph never leaves the embedded soundtrack enabled',async({page})=>{
  await nativeMock(page);await page.addInitScript(()=>{AudioContext.prototype.createMediaElementSource=()=>{throw new Error('audio device unavailable');};});
  await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Lecture',exact:true}).click();
  await expect(page.locator('video')).toHaveJSProperty('muted',true);await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button',{name:'Couper Audio original',exact:true}).click();await page.getByRole('button',{name:'Activer Audio original',exact:true}).click();await expect(page.locator('video')).toHaveJSProperty('muted',true);
});
test('GGUF and FP8 profiles expose engine requirements and persist the intended variant',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.getByRole('button',{name:'Modèles',exact:true}).click();
  const provider=page.getByRole('combobox',{name:'Moteur de voix prévu pour ce projet'});await provider.selectOption('fish-s2');
  const variant=page.getByRole('combobox',{name:'Variante du modèle prévue'});await variant.selectOption('fish-s2-fp8');
  await expect(page.getByText('VRAM annoncée par la source : environ 12 Go.')).toBeVisible();await expect(page.getByText('Moteur et variante pas encore intégrés dans le studio.')).toBeVisible();
  await page.locator('.panel-body').evaluate(element=>{element.scrollTop=element.scrollHeight;});await page.screenshot({path:'test-results/screenshots/studio-model-variants.png'});
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');await page.reload();await page.getByRole('button',{name:'Modèles',exact:true}).click();await expect(variant).toHaveValue('fish-s2-fp8');
  await variant.selectOption('fish-s2-bf16');await expect(page.getByText(/Dépasse la capacité/)).toBeVisible();
  await provider.selectOption('cosyvoice3');await expect(variant).toHaveValue('');await variant.selectOption('cosy3-gguf-q4');await expect(page.getByText(/talker Q4_K/)).toBeVisible();
  await provider.selectOption('qwen3-tts');await variant.selectOption('qwen3-17b-gguf-q5');await expect(page.getByText(/Projet HaujetZhao/)).toBeVisible();
});

test('replacing a playing media element closes its graph and preserves a muted new soundtrack',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await nativeMock(page);await measureAudio(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeGreaterThan(0.001);
  await page.evaluate(()=>{(window as any).__oldVideo=document.querySelector('video');(window as any).__replaceMedia();});
  await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();expect(await page.evaluate(()=>(window as any).__oldVideo.paused&&(window as any).__oldVideo.muted)).toBe(true);
  await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect(page.locator('video')).toHaveJSProperty('muted',true);await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeLessThan(0.000001);
  await page.getByRole('button',{name:'Activer Audio original',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeGreaterThan(0.001);expect(errors).toEqual([]);
});
