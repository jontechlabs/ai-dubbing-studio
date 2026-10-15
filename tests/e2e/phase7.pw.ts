import {test,expect,type Page} from '@playwright/test';
import {nativeMock,wav} from './nativeMock';
async function measure(page:Page){await page.addInitScript(()=>{
  const host=window as any,taps:{node:AudioNode;analyser:AnalyserNode;connected:boolean}[]=[];
  const connect=AudioNode.prototype.connect,disconnect=AudioNode.prototype.disconnect;
  AudioNode.prototype.connect=function(...args:any[]){const result=(connect as any).apply(this,args);if(this instanceof GainNode&&args[0]===this.context.destination){const analyser=this.context.createAnalyser();analyser.fftSize=1024;(connect as any).call(this,analyser);taps.push({node:this,analyser,connected:true});}return result;};
  AudioNode.prototype.disconnect=function(...args:any[]){for(const tap of taps)if(tap.node===this)tap.connected=false;return(disconnect as any).apply(this,args);};
  host.__rms=()=>Math.max(0,...taps.filter(t=>t.connected&&t.node.context.state==='running').map(t=>{const data=new Float32Array(t.analyser.fftSize);t.analyser.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((s,x)=>s+x*x,0)/data.length);}));
});}
async function setup(page:Page){await nativeMock(page);await measure(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();await page.evaluate(()=>(window as any).__seedDubbing());await page.locator('.player-mode').getByRole('button',{name:'Préparer le mix de doublage'}).click();}
const rms=(page:Page)=>page.evaluate(()=>(window as any).__rms());
async function position(page:Page,time:number){await page.locator('video').evaluate((video:HTMLVideoElement,t)=>{video.playbackRate=0.25;video.currentTime=t;},time);}

test('selected dubbing follows video seeks, pauses, gain, solo and mute with no original audio leak',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);
  await expect(page.getByRole('button',{name:'Activer Audio original',exact:true})).toBeVisible();
  await expect(page.locator('.dubbing-block')).toHaveCount(4);
  await position(page,0.1);await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect.poll(()=>rms(page)).toBeLessThan(0.000001);
  await position(page,1.1);await expect.poll(()=>rms(page)).toBeGreaterThan(0.01);await expect(page.locator('video')).toHaveJSProperty('muted',true);
  await page.getByRole('button',{name:'Pause',exact:true}).click();await expect.poll(()=>rms(page)).toBeLessThan(0.000001);
  await page.getByRole('button',{name:'Audio',exact:true}).click();const panel=page.getByRole('dialog',{name:'Audio'});
  await panel.getByRole('slider',{name:'Volume de piste Doublage'}).fill('0.25');
  await page.getByRole('button',{name:'Fermer',exact:true}).click();await position(page,1.1);await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect.poll(()=>rms(page)).toBeGreaterThan(0.002);await expect.poll(()=>rms(page)).toBeLessThan(0.006);
  await page.getByRole('button',{name:'Couper Doublage',exact:true}).click();await expect.poll(()=>rms(page)).toBeLessThan(0.000001);
  await page.getByRole('button',{name:'Activer Doublage',exact:true}).click();await expect.poll(()=>rms(page)).toBeGreaterThan(0.002);
  await position(page,3.5);await expect.poll(()=>rms(page)).toBeLessThan(0.000001);
  await page.getByRole('button',{name:'Pause',exact:true}).click();await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');await page.reload();await expect(page.getByRole('button',{name:'Activer Audio original',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
test('exports the flushed mixer settings with selectable original track, codec and subtitles',async({page})=>{
  await setup(page);await page.getByRole('button',{name:'Exporter',exact:true}).click();const panel=page.getByRole('dialog',{name:'Exporter'});
  await expect(panel.getByText('4 prises sélectionnées',{exact:true})).toBeVisible();
  await panel.getByRole('combobox',{name:'Codec du mix'}).selectOption('flac');await panel.getByRole('checkbox',{name:'Inclure le SRT original du projet'}).uncheck();
  await page.screenshot({path:'docs/screenshots/phase7-export.png'});
  await panel.getByRole('button',{name:'Exporter le MKV',exact:true}).click();await expect(page.getByRole('dialog',{name:'Traitements'}).getByText('Mixage et export MKV',{exact:true})).toBeVisible();
  const call=await page.evaluate(()=>(window as any).__calls.find((c:any)=>c.command==='export_mkv'));
  expect(call.args).toEqual({path:'C:/Exports/dubbed.mkv',options:{codec:'flac',includeOriginal:true,sourceSubtitles:false,targetSubtitles:true,allowIncomplete:false}});
});
test('dubbing regions mute real output and original audition restores the saved mix on normal playback',async({page})=>{
  await setup(page);await page.getByRole('button',{name:'Audio',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Audio'}),regions=panel.locator('.audio-regions-editor');
  await regions.getByRole('combobox',{name:'Piste à modifier'}).selectOption('dubbing');
  await regions.getByRole('textbox',{name:'Début de la zone'}).fill('00:00:01.000');await regions.getByRole('textbox',{name:'Fin de la zone'}).fill('00:00:01.800');
  await regions.getByRole('button',{name:'Rendre la zone silencieuse',exact:true}).click();await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await position(page,1.2);await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect.poll(()=>rms(page)).toBeLessThan(0.000001);
  await position(page,2.1);await expect.poll(()=>rms(page)).toBeGreaterThan(0.01);
  await page.keyboard.press('o');await expect(page.locator('video')).toHaveJSProperty('muted',false);
  await page.getByRole('button',{name:'Tout rendre silencieux',exact:true}).click();await expect(page.locator('video')).toHaveJSProperty('muted',true);await expect.poll(()=>rms(page)).toBeLessThan(0.000001);
  await page.keyboard.press('o');await expect(page.locator('video')).toHaveJSProperty('muted',false);
  await page.getByRole('button',{name:'Tout rendre silencieux',exact:true}).click();await expect(page.locator('video')).toHaveJSProperty('muted',true);await expect.poll(()=>rms(page)).toBeLessThan(0.000001);
  await page.locator('.player-mode').getByRole('button',{name:'Préparer le mix de doublage'}).click();await position(page,2.1);await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect.poll(()=>rms(page)).toBeGreaterThan(0.01);
  await page.keyboard.press('k');await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect(page.locator('video')).toHaveJSProperty('muted',true);
  await page.getByRole('button',{name:'Pause',exact:true}).click();await expect(page.locator('video')).toHaveJSProperty('paused',true);await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.screenshot({path:'docs/screenshots/phase7-mix.png'});
});
test('pause cancels a play request while a take is still decoding',async({page})=>{
  await setup(page);let release:()=>void=()=>{};
  await page.route('**/take-1.wav',async route=>{await new Promise<void>(resolve=>{release=resolve;});await route.fulfill({status:200,contentType:'audio/wav',body:wav(4)});});
  await position(page,1.1);const request=page.waitForRequest('**/take-1.wav');await page.getByRole('button',{name:'Lecture',exact:true}).click();await request;
  await page.keyboard.press('k');const response=page.waitForResponse('**/take-1.wav');release();await response;
  await expect(page.locator('video')).toHaveJSProperty('paused',true);
  await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect(page.locator('video')).toHaveJSProperty('paused',false);await expect.poll(()=>rms(page)).toBeGreaterThan(0.01);
});
test('requires explicit acknowledgment of missing takes and reports failed audio loading without playing video',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.getByRole('button',{name:'Exporter',exact:true}).click();const panel=page.getByRole('dialog',{name:'Exporter'});
  await expect(panel.getByRole('button',{name:'Exporter le MKV',exact:true})).toBeDisabled();await panel.getByRole('checkbox',{name:'Exporter ce montage malgré les répliques manquantes ou à vérifier'}).check();await expect(panel.getByRole('button',{name:'Exporter le MKV',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.evaluate(()=>(window as any).__seedDubbing());await page.locator('.player-mode').getByRole('button',{name:'Préparer le mix de doublage'}).click();
  await page.route('**/take-1.wav',route=>route.fulfill({status:404,body:'missing'}));await position(page,1);await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('video')).toHaveJSProperty('paused',true);
});
