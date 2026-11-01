// Real full-weight Audio8 installation, single/batch cloning, WAV validation,
// preservation and reopen in an isolated packaged studio via the official SDK.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const args=Object.fromEntries(process.argv.slice(2).reduce((r,v,i,a)=>i%2===0?[...r,[v.slice(2),a[i+1]]]:r,[]));
const client=new Client({name:'audio8-native-validation',version:'1.0.0'},{capabilities:{}});
const transport=new StdioClientTransport({command:args.exe,args:['--mcp','--endpoint',args.endpoint],stderr:'pipe'});
const catalog=JSON.parse(await fs.readFile(new URL('../src/mcp/catalog.json',import.meta.url),'utf8'));
const provider=new AjvJsonSchemaValidator();
const validators=new Map([...catalog.commands,...catalog.builtins].map(t=>[t.name,provider.getValidator(t.inputSchema)]));
const call=async(name,a={})=>{const checked=validators.get(name)(a);assert(checked.valid,name+': '+checked.errorMessage);const r=await client.callTool({name,arguments:a});assert(!r.isError,JSON.stringify(r));return r.structuredContent.value;};
const context=async()=>(await call('studio_get_state')).context;
const job=async(id)=>{const until=Date.now()+900000;while(Date.now()<until){const j=(await call('studio_list_jobs')).find(j=>j.id===id);if(j?.status==='succeeded')return j;assert(!['failed','cancelled','interrupted'].includes(j?.status),JSON.stringify(j));await new Promise(r=>setTimeout(r,250));}throw Error('Audio8 job timeout');};
const sha=b=>createHash('sha256').update(b).digest('hex');
const proof={hardwareQualified:false,device:'CPU',samples:[]};
try {
 await client.connect(transport);
 const until=Date.now()+60000;while(true){try{await call('studio_get_state');break;}catch(e){assert(Date.now()<until,String(e));await new Promise(r=>setTimeout(r,200));}}
 const variantId='audio8-realistic-06b-gguf-q8';
 const space=await call('studio_voice_install_space',{variantId});assert(space.enough&&space.modelBytes===1429472157&&space.runtimeBytes<1024**3);proof.diskPreflight=space;
 await job(await call('studio_install_voice_runtime',{variantId}));
 const status=await call('studio_voice_status',{includeCuda:false});assert(status.variants.find(v=>v.id===variantId)?.installed);proof.actualInstallation=true;
 const name='Audio8 日本語 vers français',root=path.join(args['test-root'],name+'.dubproject');
 await call('studio_create_project',{parentPath:args['test-root'],name,source:'ja',target:'fr'});
 await job(await call('studio_import_media',{context:await context(),path:args.movie,audioStreamIndex:1,forceProxy:false}));
 for(const [i,text] of ['Bonjour, je suis heureux de vous revoir.','Merci, nous allons bientôt partir.'].entries())await call('studio_add_dialogue',{context:await context(),options:{startMs:1000+i*5000,endMs:4000+i*5000,sourceText:'日本語の参照。',targetText:text}});
 const base={variantId,device:'cpu',referenceMode:'file',referenceId:null,mode:'zeroShot',accent:'auto',mood:'default',speed:1,seed:42};
 const imported=await call('studio_import_dubbing_reference',{context:await context(),lineId:null,path:args.reference,range:null,options:base});
 const ref=imported.voiceReferences.at(-1);assert(ref);
 await call('studio_project_patch',{context:await context(),patches:[{op:'replace',path:`/voiceReferences/${imported.voiceReferences.length-1}/transcript`,value:'うちの中学は弁当制で持っていけない場合は50円の学校販売のパンを買う。'}]});
 const options={...base,referenceId:ref.id};
 const before=await call('studio_get_project'),lineId=before.dialogues[0].id;
 const mediaHash=sha(await fs.readFile(path.join(root,before.media.path)));
 const single=await job(await call('studio_generate_line',{context:await context(),lineId,options}));
 const one=await call('studio_get_project');assert.equal(one.formatVersion,26);assert.equal(one.generations.length,1);const first=one.generations[0];assert.equal(first.providerId,'audio8-tts');assert.equal(first.device,'cpu');
 const firstHash=sha(await fs.readFile(path.join(root,first.path)));
 const selection={scope:'selected',lineIds:one.dialogues.map(l=>l.id),force:true,options:{...options,quality:{temperature:.6,topP:.8,topK:30}}};
 const plan=await call('studio_preview_dubbing_batch',{selection});assert.equal(plan.ready.length,2);
 const batch=await job(await call('studio_generate_dubbing_batch',{context:await context(),selection}));
 assert.equal(batch.batch.succeeded,2);assert(batch.logs.some(l=>l.includes('reusing the private batch server and loaded model')));assert(batch.logs.some(l=>l.includes('releasing its GPU context')));proof.hotBatch=true;
 const after=await call('studio_get_project');assert.equal(after.generations.length,3);assert.deepEqual(after.generations[0],first);assert.equal(sha(await fs.readFile(path.join(root,first.path))),firstHash);
 assert.deepEqual(after.sourceCues,before.sourceCues);assert.deepEqual(after.targetCues,before.targetCues);assert.equal(sha(await fs.readFile(path.join(root,before.media.path))),mediaHash);
 const ffmpeg=path.join(path.dirname(args.exe),'binaries/ffmpeg.exe');
 for(const [i,g] of after.generations.entries()){
  const wav=path.join(root,g.path);const bytes=await fs.readFile(wav);assert(bytes.length>44);assert(g.durationMs>500&&g.durationMs<120000);assert.equal(g.sampleRate,24000);assert.equal(g.referenceTranscript,'うちの中学は弁当制で持っていけない場合は50円の学校販売のパンを買う。');
  const pcm=execFileSync(ffmpeg,['-v','error','-i',wav,'-f','f32le','pipe:1']);let peak=0;for(let n=0;n+4<=pcm.length;n+=4){const v=pcm.readFloatLE(n);assert(Number.isFinite(v));peak=Math.max(peak,Math.abs(v));}assert(peak>.01&&peak<=1);
  const output=path.join(path.dirname(args.proof),`audio8-french-${i+1}.wav`);await fs.copyFile(wav,output);
  proof.samples.push({path:path.basename(output),durationMs:g.durationMs,peak,sha256:sha(bytes),text:g.text,referenceLanguage:'ja'});
 }
 await call('studio_open_project',{path:root});assert.deepEqual((await call('studio_get_project')).generations,after.generations);
 proof.previousTakesPreserved=true;proof.subtitlesAndMovieUnchanged=true;proof.reopenFormat26=true;proof.singleSeconds=single.timing.elapsedMs/1000;proof.batchSeconds=batch.timing.elapsedMs/1000;proof.officialSdk=true;proof.version=client.getServerVersion().version;
 await fs.writeFile(args.proof,JSON.stringify(proof,null,2)+'\n');console.log('AUDIO8_PACKAGED_INFERENCE',JSON.stringify(proof));
} finally { await client.close(); }
