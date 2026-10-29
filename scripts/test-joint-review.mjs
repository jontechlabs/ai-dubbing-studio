import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function verifyJointReview({call,context,client,projectRoot,baseId}) {
 const before=await call('studio_get_project'),g=before.generations.find(g=>g.id===baseId),lineId=g.dialogueId;
 const dry=await fs.readFile(path.join(projectRoot,g.path));
 await call('studio_select_take',{context:await context(),id:baseId});
 await call('studio_review_take',{context:await context(),lineId,validated:true});
 const approved=await call('studio_get_project');assert.equal(approved.formatVersion,24);
 assert.equal(approved.translationApprovals[lineId].joint.generation.id,baseId);
 assert.equal(approved.dialogues.find(l=>l.id===lineId).status,'validated');
 await call('studio_set_voice_output_gain',{context:await context(),id:baseId,gain:1.5});
 const changed=await call('studio_get_project');assert(!changed.translationApprovals?.[lineId]);assert.equal(changed.dialogues.find(l=>l.id===lineId).status,'review');assert.deepEqual(changed.generations,before.generations);
 await call('studio_history',{context:await context(),direction:'undo'});
 assert.deepEqual((await call('studio_get_project')).translationApprovals,approved.translationApprovals);
 await call('studio_add_dialogue',{context:await context(),options:{startMs:8500,endMs:9500,sourceText:'追加の字幕。',targetText:'Une réplique ajoutée.'}});
 const added=await call('studio_get_project'),newLine=added.dialogues.find(l=>!approved.dialogues.some(old=>old.id===l.id));assert(newLine);assert.deepEqual(added.generations,before.generations);
 const oldContext=await context(),ids=[lineId,newLine.id];
 await call('studio_set_dialogue_exclusion',{context:oldContext,ids,excluded:true});
 const excluded=await call('studio_get_project');assert(ids.every(id=>excluded.dialogues.find(l=>l.id===id).excludedFromDubbing));
 for(const key of ['sourceCues','targetCues','generations','voiceEdits','media','dubbingTiming'])assert.deepEqual(excluded[key],added[key],key);
 assert(!excluded.translationApprovals?.[lineId]);
 const rows=await call('studio_get_dialogues',{ids});assert(rows.rows.every(l=>l.excludedFromDubbing));
 const plan=await call('studio_preview_dubbing_batch',{selection:{scope:'all',lineIds:[],force:true,options:{variantId:'cosy3-official',device:'cpu',referenceMode:'current',referenceId:null,mode:'crossLingual',speed:1,seed:0}}});assert(!plan.ready.some(id=>ids.includes(id)));assert.equal(plan.requested,added.dialogues.length-ids.length);
 const stale=await client.callTool({name:'studio_set_dialogue_exclusion',arguments:{context:oldContext,ids,excluded:false}});assert(stale.isError);
 const invalid=await client.callTool({name:'studio_set_dialogue_exclusion',arguments:{context:await context(),ids:[lineId,'missing'],excluded:false}});assert(invalid.isError);assert.deepEqual(await call('studio_get_project'),excluded);
 await call('studio_set_dialogue_exclusion',{context:await context(),ids,excluded:false});
 const restored=await call('studio_get_project');assert(ids.every(id=>!restored.dialogues.find(l=>l.id===id).excludedFromDubbing));assert.deepEqual(restored.generations,before.generations);
 await call('studio_history',{context:await context(),direction:'undo'}); // restore
 await call('studio_history',{context:await context(),direction:'undo'}); // exclusion
 assert.deepEqual((await call('studio_get_project')).translationApprovals,approved.translationApprovals);
 await call('studio_history',{context:await context(),direction:'undo'}); // addition
 const reverted=await call('studio_get_project');assert.deepEqual(reverted.sourceCues,approved.sourceCues);assert.deepEqual(reverted.targetCues,approved.targetCues);assert.deepEqual(reverted.dialogues,approved.dialogues);
 await call('studio_set_dialogue_exclusion',{context:await context(),ids:[lineId],excluded:true});
 await call('studio_open_project',{path:projectRoot});assert((await call('studio_get_project')).dialogues.find(l=>l.id===lineId).excludedFromDubbing);
 await call('studio_set_dialogue_exclusion',{context:await context(),ids:[lineId],excluded:false});
 await call('studio_review_take',{context:await context(),lineId,validated:true});
 assert.deepEqual(await fs.readFile(path.join(projectRoot,g.path)),dry);
 return {format:24,commonSnapshot:true,realGainWithdrawsReview:true,subtitlesAndEveryTakePreserved:true,exclusionSkippedByBatch:true,restoreAndUndo:true,reopen:true,staleAndUnknownRejected:true};
}
