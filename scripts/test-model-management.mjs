// Actual packaged native model inventory/removal, using only test-owned partial weights.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export async function verifyModelManagement({call,context,args,projectRoot}) {
 const storage=await call('studio_model_storage_info');
 assert.equal(path.resolve(storage.path),path.resolve(args['models-root']));
 const id='voice:voxcpm2-bf16', folder=path.join(storage.path,'voice-engines','voxcpm2-bf16');
 await assert.rejects(fs.stat(folder),e=>e.code==='ENOENT');
 const before=await call('studio_get_project');
 const files=[...new Set(before.generations.filter(g=>g.kind==='tts').map(g=>g.path))];
 const hashes=new Map();
 for(const file of files) hashes.set(file,createHash('sha256').update(await fs.readFile(path.join(projectRoot,file))).digest('hex'));
 await fs.mkdir(path.join(folder,'cache'),{recursive:true});
 await fs.writeFile(path.join(folder,'cache','model.download'),Buffer.alloc(1024,7));
 let inventory=await call('studio_managed_models');
 const item=inventory.find(x=>x.id===id);assert(item?.present);assert.equal(item.bytes,1024);assert.equal(item.files,1);
 await assert.rejects(call('studio_remove_installed_model',{id,confirmed:false}),/MODEL_REMOVE_CONFIRMATION/);
 await assert.rejects(call('studio_remove_installed_model',{id:'../escape',confirmed:true}),/INVALID_MODEL/);
 assert.equal((await fs.stat(path.join(folder,'cache','model.download'))).size,1024);
 const result=await call('studio_remove_installed_model',{id,confirmed:true});
 assert.equal(result.id,id);assert.equal(result.bytes,1024);assert.equal(result.files,1);
 await assert.rejects(fs.stat(folder),e=>e.code==='ENOENT');
 inventory=await call('studio_managed_models');assert.equal(inventory.find(x=>x.id===id).present,false);
 assert.equal((await call('studio_remove_installed_model',{id,confirmed:true})).files,0);
 assert((await fs.stat(path.join(storage.path,'whisper-reference','ggml-small-q5_1.bin'))).isFile());
 assert((await fs.stat(path.join(storage.path,'voice-engines','speaker-separation-runtime','ready.json'))).isFile());
 assert.deepEqual(await call('studio_get_project'),before);
 for(const file of files) assert.equal(createHash('sha256').update(await fs.readFile(path.join(projectRoot,file))).digest('hex'),hashes.get(file));
 assert((await context()).projectId===before.id);
 return {actualNativeInventory:true,actualNativeRemoval:true,exactByteCount:true,partialDownloadRemoved:true,confirmationRequired:true,unknownPathRejected:true,idempotent:true,sharedRuntimeAndOtherModelsPreserved:true,projectAndTakeFilesPreserved:true};
}
