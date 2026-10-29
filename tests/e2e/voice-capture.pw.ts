import {test,expect} from '@playwright/test';
import {nativeMock,wav} from './nativeMock';
import fs from 'node:fs';
import path from 'node:path';
const micFile=path.resolve('.cache/microphone-input.wav');fs.mkdirSync(path.dirname(micFile),{recursive:true});fs.writeFileSync(micFile,wav(16));
test.use({launchOptions:{args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${micFile}`]},permissions:['microphone']});

test('real Web Audio microphone capture is auditioned, saved as another take, and survives reload',async({page})=>{
  await nativeMock(page);await page.goto('/');
  await page.evaluate(policy=>{const meta=document.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content=policy;document.head.appendChild(meta);},JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8')).app.security.csp);
  await page.locator('.dialogue-card').first().getByRole('button',{name:'Doubler',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Doublage'});
  await panel.locator('.microphone-panel summary').click();
  await panel.getByRole('button',{name:'Commencer l’enregistrement',exact:true}).click();
  await expect(page.locator('.microphone-indicator')).toContainText('Enregistrement en cours');
  await expect.poll(()=>panel.getByRole('meter').getAttribute('value')).not.toBe('0');
  await panel.getByRole('button',{name:'Arrêter l’enregistrement',exact:true}).click();
  const recording=panel.locator('audio[aria-label="Écouter l’enregistrement"]');
  await expect(recording).toBeVisible();
  await expect.poll(()=>recording.evaluate((a:HTMLAudioElement)=>a.readyState)).toBeGreaterThanOrEqual(1);
  expect(await recording.evaluate((a:HTMLAudioElement)=>a.duration)).toBeGreaterThan(.15);
  await recording.evaluate((a:HTMLAudioElement)=>a.play());
  await expect.poll(()=>recording.evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(0);
  await recording.evaluate((a:HTMLAudioElement)=>a.pause());
  await page.screenshot({path:'docs/screenshots/microphone-recording-fr.png'});
  await panel.getByRole('button',{name:'Conserver comme nouvel essai',exact:true}).click();
  await expect(page.locator('.microphone-indicator')).toHaveCount(0);
  await expect(panel.locator('.generation-card.selected')).toBeFocused();
  await expect(panel.getByText('Prise enregistrée au microphone',{exact:true})).toBeVisible();
  const saved=await page.evaluate(()=>(window as any).__getMockProject());
  expect(saved.formatVersion).toBe(17);expect(saved.generations.at(-1).takeOrigin.type).toBe('microphone');
  expect(await page.evaluate(()=>(window as any).__microphoneBytes)).toBeGreaterThan(44+7200);
  await page.reload();await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();
  await expect(panel.getByText('Prise enregistrée au microphone',{exact:true})).toBeVisible();
  const p=await page.evaluate(()=>(window as any).__getMockProject());expect(p.generations).toEqual(saved.generations);
  await panel.locator('.conversion-panel summary').click();
  await expect(panel.getByRole('button',{name:'Créer un essai avec ce timbre'})).toBeDisabled();
  const refs=await panel.getByRole('combobox',{name:'Référence pour le timbre'}).locator('option').allTextContents();
  expect(refs.length).toBeGreaterThan(0);
  await page.evaluate(()=>{const p=(window as any).__getMockProject();p.voiceReferences=[{id:'french',label:'Référence française',path:'references/french.wav',durationMs:3000,transcript:''}];localStorage.setItem('nativeMockProject',JSON.stringify(p));});
  await page.reload();await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();
  await panel.locator('.conversion-panel summary').click();
  await panel.getByRole('combobox',{name:'Référence pour le timbre'}).selectOption('file:french');
  await panel.getByRole('combobox',{name:'Périphérique de conversion du timbre'}).selectOption('cuda:0');
  await page.screenshot({path:'docs/screenshots/voice-conversion-fr.png'});
  await panel.getByRole('button',{name:'Créer un essai avec ce timbre'}).click();
  const options=await page.evaluate(()=>(window as any).__pendingConversion);
  expect(options).toEqual({generationId:saved.generations.at(-1).id,referenceId:'french',characterId:null,device:'cuda:0'});
  expect((await page.evaluate(()=>(window as any).__getMockProject())).generations).toEqual(saved.generations);
});

test('discard closes microphone tracks and never adds a take',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.locator('.dialogue-card').first().getByRole('button',{name:'Doubler',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Doublage'});await panel.locator('.microphone-panel summary').click();
  await panel.getByRole('button',{name:'Commencer l’enregistrement',exact:true}).click();
  await expect(page.locator('.microphone-indicator')).toContainText('Enregistrement en cours');
  await page.locator('.microphone-indicator').getByRole('button',{name:'Abandonner la prise'}).click();
  await expect(page.locator('.microphone-indicator')).toHaveCount(0);
  expect((await page.evaluate(()=>(window as any).__getMockProject())).generations).toHaveLength(0);
  // An unanswered permission request must remain cancellable and must not
  // start recording later when Windows/browser finally grants access.
  await page.evaluate(()=>{
    const host=window as any, original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{host.__grantMicrophone=async()=>{const stream=await original({audio:true});host.__lateStream=stream;resolve(stream);};});
  });
  await panel.getByRole('button',{name:'Commencer l’enregistrement',exact:true}).click();
  await expect(page.locator('.microphone-indicator')).toContainText('Autorisation du microphone');
  await page.locator('.microphone-indicator').getByRole('button',{name:'Abandonner la prise'}).click();
  await expect(panel.getByRole('button',{name:'Commencer l’enregistrement',exact:true})).toBeEnabled();
  await page.evaluate(()=>(window as any).__grantMicrophone());
  await expect.poll(()=>page.evaluate(()=>(window as any).__lateStream.getTracks().every((t:MediaStreamTrack)=>t.readyState==='ended'))).toBe(true);
  await expect(page.locator('.microphone-indicator')).toHaveCount(0);
  expect((await page.evaluate(()=>(window as any).__getMockProject())).generations).toHaveLength(0);
});
