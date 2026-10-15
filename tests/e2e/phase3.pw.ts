import { test, expect, type Page } from '@playwright/test';
import { demoProject } from '../../src/domain/project';
import fs from 'node:fs/promises';

import { nativeMock } from './nativeMock';

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
  await page.getByRole('button',{name:'Rechercher une mise à jour'}).click();await expect(page.getByText('La version 0.5.1 est disponible.')).toBeVisible();
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
  await page.getByRole('button',{name:'Modèles',exact:true}).click();await expect(page.getByText(/Aucun essai audio sélectionné/)).toBeVisible();
  await page.getByRole('combobox',{name:'Moteur préféré pour le projet'}).selectOption('cosyvoice3');
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
  const provider=page.getByRole('combobox',{name:'Moteur préféré pour le projet'});await provider.selectOption('fish-s2');
  const variant=page.getByRole('combobox',{name:'Variante préférée'});await variant.selectOption('fish-s2-fp8');
  await expect(page.getByText('VRAM annoncée par la source : environ 12 Go.')).toBeVisible();await expect(page.getByText('Variante intégrée : installation dans Modèles, sélection dans Doublage.')).toBeVisible();
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
test('audio regions schedule real silence and independent gain through playback, seeking and reload',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await nativeMock(page);await measureAudio(page);await page.goto('/');await page.evaluate(()=>(window as any).__completeSeparation());
  await expect(page.locator('.track-label')).toHaveCount(7);await page.getByRole('button',{name:'Audio',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Audio',exact:true});
  await panel.getByRole('button',{name:'Tout rendre silencieux',exact:true}).click();
  await page.getByRole('combobox',{name:'Piste à modifier'}).selectOption('speech');
  await panel.getByRole('button',{name:'Activer Voix',exact:true}).click();
  const start=page.getByRole('textbox',{name:'Début de la zone'}),end=page.getByRole('textbox',{name:'Fin de la zone'});
  await start.fill('00:00:01.000');await end.fill('00:00:03.000');await page.getByRole('button',{name:'Rendre la zone silencieuse',exact:true}).click();
  await start.fill('00:00:03.000');await end.fill('00:00:05.000');await page.getByRole('slider',{name:'Volume de la zone',exact:true}).fill('0.25');await page.getByRole('button',{name:'Rendre la zone audible',exact:true}).click();
  await page.getByRole('slider',{name:'Volume de piste Voix',exact:true}).fill('0.5');
  await page.locator('.audio-regions-editor').evaluate(element=>element.scrollIntoView({block:'start'}));
  await page.screenshot({path:'test-results/screenshots/studio-audio-regions.png'});
  await page.getByRole('button',{name:'Fermer',exact:true}).click();await expect(page.locator('.audio-region')).toHaveCount(2);
  await page.evaluate(()=>{const play=HTMLMediaElement.prototype.play;let interrupted=false;HTMLMediaElement.prototype.play=function(){if(this instanceof HTMLAudioElement&&!interrupted){interrupted=true;return Promise.reject(new DOMException('Interrupted by a seek','AbortError'));}return play.call(this);};});
  await page.locator('video').evaluate((video:HTMLVideoElement)=>{video.currentTime=0.1;});await page.getByRole('button',{name:'Lecture',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeGreaterThan(0.007);
  await expect.poll(()=>page.locator('video').evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeGreaterThan(1.25);
  await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeLessThan(0.000001);
  await page.locator('video').evaluate((video:HTMLVideoElement)=>{video.currentTime=3.5;});
  await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeLessThan(0.003);await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeGreaterThan(0.0015);
  await page.locator('video').evaluate((video:HTMLVideoElement)=>{video.currentTime=5.5;});await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeGreaterThan(0.007);
  await page.locator('video').evaluate((video:HTMLVideoElement)=>{video.currentTime=2.8;video.playbackRate=2;});
  await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeGreaterThan(0.0015);
  await page.getByRole('button',{name:'Pause',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__rms())).toBeLessThan(0.000001);
  await page.getByRole('button',{name:'Tout rendre audible',exact:true}).click();
  await page.getByRole('button',{name:'Audio',exact:true}).click();await page.getByRole('combobox',{name:'Piste à modifier'}).selectOption('speech');await expect(page.getByRole('checkbox',{name:'Appliquer les zones de cette piste'})).not.toBeChecked();
  await panel.getByRole('button',{name:'Réappliquer les zones',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Appliquer les zones de cette piste'})).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button',{name:'Exporter cette piste avec les zones',exact:true}).click();await expect(page.getByRole('dialog',{name:'Traitements'})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__calls.some((call:any)=>call.command==='export_audio_track'&&call.args.edited===true))).toBe(true);
  await page.getByRole('button',{name:'Annuler',exact:true}).click();await page.getByRole('button',{name:'Fermer',exact:true}).click();await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.reload();await expect(page.locator('.audio-region')).toHaveCount(2);
  const restored=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));
  expect(restored.formatVersion).toBe(4);expect(restored.tracks.find((track:any)=>track.id==='speech')).toMatchObject({gain:0.5,regionsEnabled:true});
  expect(errors).toEqual([]);
});

test('timeline range selection paints inside regions, validates bounds, and supports undo',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Explorer l’exemple'}).click();await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
  const row=page.locator('.timeline-track.audio').first();const box=await row.boundingBox();expect(box).not.toBeNull();
  await page.keyboard.down('Shift');await page.mouse.move(box!.x+box!.width*0.15,box!.y+16);await page.mouse.down();await page.mouse.move(box!.x+box!.width*0.4,box!.y+16,{steps:8});await page.mouse.up();await page.keyboard.up('Shift');
  await expect(page.getByRole('dialog',{name:'Audio',exact:true})).toBeVisible();await page.getByRole('button',{name:'N’écouter que cette zone',exact:true}).click();
  await expect(page.locator('.audio-region')).toHaveCount(3);await page.getByRole('textbox',{name:'Fin de la zone'}).fill('99:00:00.000');await page.getByRole('button',{name:'Enregistrer la zone',exact:true}).click();await expect(page.getByRole('alert')).toContainText('timecodes');
  await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.keyboard.press('Control+z');await expect(page.locator('.audio-region')).toHaveCount(0);
  await page.keyboard.press('Control+y');await expect(page.locator('.audio-region')).toHaveCount(3);
  await page.locator('.audio-region.audible').first().click();await expect(page.getByRole('dialog',{name:'Audio',exact:true})).toBeVisible();await page.getByRole('slider',{name:'Volume de la zone'}).fill('0.4');await page.getByRole('button',{name:'Enregistrer la zone',exact:true}).click();await expect(page.locator('.audio-region.audible')).toContainText('40%');
  await page.getByRole('button',{name:'Fermer',exact:true}).click();await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');await page.reload();await expect(page.locator('.audio-region')).toHaveCount(3);
});

test('model folder size is shown, can be refreshed and recovers from an unavailable drive',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.getByRole('button',{name:'Paramètres',exact:true}).click();await expect(page.locator('.model-storage-size')).toContainText('4,5 GiB');
  await page.evaluate(()=>(window as any).__modelBytes=1073741824);await page.getByRole('button',{name:'Actualiser la taille du dossier'}).click();await expect(page.locator('.model-storage-size')).toContainText('1 GiB');
  await page.evaluate(()=>(window as any).__sizeError=true);await page.getByRole('button',{name:'Actualiser la taille du dossier'}).click();await expect(page.locator('.model-storage-size')).toContainText('Indisponible');
  await page.evaluate(()=>(window as any).__sizeError=false);await page.getByRole('button',{name:'Actualiser la taille du dossier'}).click();await expect(page.locator('.model-storage-size')).toContainText('1 GiB');
  await page.screenshot({path:'test-results/screenshots/studio-storage-size.png'});
});
