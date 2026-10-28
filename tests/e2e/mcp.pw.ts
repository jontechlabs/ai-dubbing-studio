import {test,expect,type Page} from '@playwright/test';
import {nativeMock} from './nativeMock';
const call=(page:Page,tool:string,args:unknown={})=>page.evaluate(({tool,args})=>(window as any).__mcp(tool,args),{tool,args});
const data=(page:Page)=>page.evaluate(()=>(window as any).__getMockProject());
async function setup(page:Page,seed=false){
 await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
 await expect.poll(()=>page.evaluate(()=>(window as any).__mcpReady)).toBe(true);
 if(seed)await page.evaluate(()=>(window as any).__seedDubbing());
 await page.getByRole('button',{name:'Paramètres',exact:true}).click();
 const section=page.getByRole('region',{name:'Contrôle IA / MCP',exact:true});
 await section.getByRole('checkbox',{name:'Activer le pilotage MCP local',exact:true}).check();
 await expect(section.getByRole('status')).toContainText('MCP activé');
 await page.getByRole('button',{name:'Fermer',exact:true}).click();
 return (await call(page,'studio_get_state')).context;
}

test('MCP is opt-in and exposes a portable stdio configuration and recent command audit',async({page})=>{
 await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
 await expect.poll(()=>page.evaluate(()=>(window as any).__mcpReady)).toBe(true);
 expect((await call(page,'studio_get_state')).error).toBe('MCP_DISABLED');
 await page.getByRole('button',{name:'Paramètres',exact:true}).click();const section=page.getByRole('region',{name:'Contrôle IA / MCP',exact:true});
 await expect(section.getByRole('checkbox')).not.toBeChecked();await section.getByRole('checkbox').check();
 const configuration=JSON.parse(await section.getByRole('textbox',{name:'Configuration du client MCP (JSON)',exact:true}).inputValue());
 expect(configuration.mcpServers['ai-dubbing-studio'].args).toEqual(['--mcp','--endpoint','C:/Studio/mcp-endpoint.json']);
 expect(JSON.stringify(configuration)).not.toContain('token');
 await call(page,'studio_get_state');await expect(section.locator('.mcp-audit')).toContainText('studio_get_state');
 await section.getByRole('combobox',{name:'Format de configuration MCP',exact:true}).selectOption('codex');
 await expect(section.getByRole('textbox',{name:'Configuration Codex (TOML)',exact:true})).toContainText('mcp_servers.ai_dubbing_studio');
 await section.getByRole('combobox',{name:'Format de configuration MCP',exact:true}).selectOption('json');
 await section.scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/mcp-settings-fr.png'});
 await section.getByRole('checkbox').uncheck();expect((await call(page,'studio_get_state')).error).toBe('MCP_DISABLED');
});

test('AI edits are visible and undoable, and stale context never replaces pending manual edits',async({page})=>{
 const context=await setup(page),before=await data(page),lineId=before.dialogues[0].id;
 const result=await call(page,'studio_edit_dialogue',{context,lineId,role:'target',text:'Une traduction proposée par IA.',approved:true});
 expect(result.applied).toBe(true);let p=await data(page);expect(p.translationApprovals[lineId].targetText).toBe('Une traduction proposée par IA.');
 await expect(page.locator('.dialogue-card').first()).toContainText('Une traduction proposée par IA.');
 const stale=await call(page,'studio_edit_dialogue',{context,lineId,role:'target',text:'Ne pas appliquer'});expect(stale.error).toContain('STALE_REVISION');
 expect((await data(page)).targetCues).toEqual(p.targetCues);
 const current=(await call(page,'studio_get_state')).context;
 await call(page,'studio_history',{context:current,direction:'undo'});p=await data(page);expect(p.targetCues).toEqual(before.targetCues);
 await expect(page.locator('.dialogue-card').first()).toContainText(before.targetCues[0].text);
});

test('MCP bulk review is atomic, preserves voice takes and rejects stale or unknown selections',async({page})=>{
 const context=await setup(page,true),before=await data(page),ids=before.dialogues.slice(0,3).map((l:any)=>l.id);
 await page.evaluate(()=>(window as any).__clearTranslation(0));
 const reviewBefore=await data(page);
 const current=(await call(page,'studio_get_state')).context;
 const approved=await call(page,'studio_approve_translations',{context:current,ids:[...ids,ids[1]],approved:true});
 expect(approved.applied).toBe(true);
 let p=await data(page);expect(Object.keys(p.translationApprovals).sort()).toEqual(ids.slice(1).sort());
 expect(p.generations).toEqual(before.generations);expect(p.dialogues.map((l:any)=>({...l,status:undefined}))).toEqual(reviewBefore.dialogues.map((l:any)=>({...l,status:undefined})));expect(p.dialogues[2].status).toBe('validated');
 expect((await call(page,'studio_approve_translations',{context,ids,approved:false})).error).toContain('STALE_REVISION');
 expect((await call(page,'studio_approve_translations',{context:approved.context,ids:[ids[1],'missing'],approved:false})).error).toContain('MCP_UNKNOWN_DIALOGUE');
 expect((await data(page)).translationApprovals).toEqual(p.translationApprovals);
 await call(page,'studio_history',{context:approved.context,direction:'undo'});
 expect((await data(page)).translationApprovals??{}).toEqual({});
 const again=await call(page,'studio_approve_translations',{context:(await call(page,'studio_get_state')).context,ids,approved:true});
 const withdrawn=await call(page,'studio_approve_translations',{context:again.context,ids,approved:false});expect(withdrawn.applied).toBe(true);
 p=await data(page);expect(p.translationApprovals).toEqual({});expect(p.generations).toEqual(before.generations);
});

test('AI track regions and project patches use normal validation without accepting partial failures',async({page})=>{
 let context=await setup(page);let result=await call(page,'studio_set_track',{context,id:'original',changes:{gain:.6,mute:false}});context=result.context;
 result=await call(page,'studio_audio_region',{context,id:'original',startMs:1000,endMs:1700,gain:0,mute:true});context=result.context;
 const p=await data(page),track=p.tracks.find((t:any)=>t.id==='original');expect(track.gain).toBe(.6);expect(track.regions[0].mute).toBe(true);
 const failed=await call(page,'studio_project_patch',{context,patches:[{op:'replace',path:'/name',value:'Temporary'},{op:'test',path:'/dialogues/0/id',value:'wrong'}]});
 expect(failed.error).toContain('MCP_PATCH_TEST_FAILED');expect((await data(page)).name).toBe(p.name);
 result=await call(page,'studio_project_patch',{context,patches:[{op:'add',path:'/pronunciation/nom~1propre',value:'Sakamoto'}]});expect(result.applied).toBe(true);
 expect((await data(page)).pronunciation['nom/propre']).toBe('Sakamoto');
});

test('cancelled queued voice work cannot commit after a deferred render, and failed render keeps the original',async({page})=>{
 const context=await setup(page,true),before=await data(page);
 await page.evaluate(()=>{(window as any).__deferEdit=true;});
 const first=call(page,'studio_edit_voice',{context,id:'take-1',startMs:300,endMs:700,operation:{kind:'gain',gain:.5}});
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).__releaseEdit)).toBe('function');
 const second=call(page,'studio_edit_dialogue',{context,lineId:before.dialogues[0].id,role:'target',text:'Should never apply'});
 await expect.poll(()=>page.evaluate(()=>(window as any).__mcpIds.length)).toBe(3);
 await page.evaluate(()=>{const h=window as any;h.__mcpCancel(h.__mcpIds.at(-1));h.__releaseEdit(true);});
 expect((await first).error).toContain('VOICE_EDIT_FAILED');expect((await second).error).toContain('MCP_CANCELLED');
 expect((await data(page)).voiceEdits).toEqual(before.voiceEdits);expect((await data(page)).targetCues).toEqual(before.targetCues);
 await page.evaluate(()=>{(window as any).__releaseEdit=undefined;});
 const late=call(page,'studio_edit_voice',{context,id:'take-1',startMs:300,endMs:700,operation:{kind:'gain',gain:.5}});
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).__releaseEdit)).toBe('function');
 await page.evaluate(()=>{const h=window as any;h.__mcpCancel(h.__mcpIds.at(-1));h.__releaseEdit();});
 expect((await late).error).toContain('MCP_CANCELLED');
  await call(page,'studio_get_state');
 await expect.poll(async()=>JSON.stringify((await data(page)).voiceEdits)).toBe(JSON.stringify(before.voiceEdits));
});

test('AI controls selection, playback, zoom and background jobs without desktop file dialogs',async({page})=>{
 const context=await setup(page,true),p=await data(page),lineId=p.dialogues[0].id;
 await call(page,'studio_select_dialogue',{lineId});await call(page,'studio_set_selection',{ids:[lineId]});
 await call(page,'studio_preferences',{zoom:4});await expect(page.locator('.zoom-value')).toHaveText('400%');
 await call(page,'studio_playback',{action:'seek',timeMs:1000});
 await page.evaluate(()=>{const h=window as any;h.__mcpRaf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;});
 await call(page,'studio_playback',{action:'play'});
 await expect.poll(()=>page.locator('video').evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(1.15);
 await page.evaluate(()=>{window.requestAnimationFrame=(window as any).__mcpRaf;});
 await call(page,'studio_playback',{action:'pause'});expect((await call(page,'studio_get_state')).checkedIds).toEqual([lineId]);
 const id=await call(page,'studio_generate_line',{context,lineId,options:{variantId:'cosy3-official',device:'cpu',referenceMode:'current',referenceId:null,mode:'crossLingual',speed:1,seed:0}});
 expect(id).toBe('tts-job');expect((await call(page,'studio_list_jobs'))[0].status).toBe('running');
 await call(page,'studio_cancel_job',{id});expect((await call(page,'studio_list_jobs'))[0].status).toBe('cancelled');
 const calls=await page.evaluate(()=>(window as any).__calls);expect(calls.some((c:any)=>c.command==='generate_line'&&!Object.hasOwn(c.args,'context'))).toBe(true);
});

test('MCP previews and starts an unapproved-only batch using the shared schema',async({page})=>{
 await setup(page);
 await page.locator('.dialogue-card').first().getByRole('button',{name:'Valider la traduction de la réplique 1',exact:true}).click();
 await expect.poll(async()=>Object.keys((await data(page)).translationApprovals??{}).length).toBe(1);
 const p=await data(page),context=(await call(page,'studio_get_state')).context;
 const selection={scope:'all',lineIds:[],approvedOnly:false,unapprovedOnly:true,force:false,options:{variantId:'cosy3-official',device:'cpu',referenceMode:'current',referenceId:null,mode:'crossLingual',speed:1,seed:0}};
 const preview=await call(page,'studio_preview_dubbing_batch',{selection});
 expect(preview).toMatchObject({requested:4,approved:1,unapproved:0,untranslated:0});
 expect(preview.ready).toEqual(p.dialogues.slice(1).map((l:any)=>l.id));
 expect(await call(page,'studio_generate_dubbing_batch',{context,selection})).toBe('batch-job');
 expect((await call(page,'studio_list_jobs'))[0].batch).toMatchObject({total:3,skipped:1});
 expect(await page.evaluate(()=>(window as any).__pendingBatch)).toMatchObject({unapprovedOnly:true,approvedOnly:false});
});
