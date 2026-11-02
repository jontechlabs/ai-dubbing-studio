// Reproduce the low-quality seed independently through the old single-take path.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const args=Object.fromEntries(process.argv.slice(2).reduce((r,v,i,a)=>i%2===0?[...r,[v.slice(2),a[i+1]]]:r,[]));
const client=new Client({name:'trials-cold-seed-diagnostic',version:'1.0.0'},{capabilities:{}});
const transport=new StdioClientTransport({command:args.exe,args:['--mcp','--endpoint',args.endpoint],stderr:'pipe'});
const call=async(name,a={})=>{const r=await client.callTool({name,arguments:a});assert(!r.isError,JSON.stringify(r));return r.structuredContent.value;};
const context=async()=>(await call('studio_get_state')).context;
const job=async(id)=>{const until=Date.now()+900000;while(Date.now()<until){const j=(await call('studio_list_jobs')).find(j=>j.id===id);if(j?.status==='succeeded')return j;assert(!['failed','cancelled','interrupted'].includes(j?.status),JSON.stringify(j));await new Promise(r=>setTimeout(r,250));}throw Error('Cold diagnostic timeout');};
try {
 await client.connect(transport);
 const until=Date.now()+60000;while(true){try{await call('studio_get_state');break;}catch(e){assert(Date.now()<until,String(e));await new Promise(r=>setTimeout(r,200));}}
 const variantId='audio8-realistic-06b-gguf-q8';
 await job(await call('studio_install_voice_runtime',{variantId}));
 const name='Cold seed 14 日本語';
 await call('studio_create_project',{parentPath:args['test-root'],name,source:'ja',target:'fr'});
 await job(await call('studio_import_media',{context:await context(),path:args.movie,audioStreamIndex:1,forceProxy:false}));
 await call('studio_add_dialogue',{context:await context(),options:{startMs:1000,endMs:4000,sourceText:'日本語の参照。',targetText:'Bonjour, je suis heureux de vous revoir.'}});
 const base={variantId,device:'cpu',referenceMode:'file',referenceId:null,mode:'zeroShot',accent:'auto',mood:'default',speed:1,seed:14};
 const imported=await call('studio_import_dubbing_reference',{context:await context(),lineId:null,path:args.reference,range:null,options:base});
 const ref=imported.voiceReferences.at(-1);
 await call('studio_project_patch',{context:await context(),patches:[{op:'replace',path:`/voiceReferences/${imported.voiceReferences.length-1}/transcript`,value:'うちの中学は弁当制で持っていけない場合は50円の学校販売のパンを買う。'}]});
 const p=await call('studio_get_project');
 // Omit count entirely: this is the pre-existing cold single-generation path.
 const j=await job(await call('studio_generate_line',{context:await context(),lineId:p.dialogues[0].id,options:{...base,referenceId:ref.id}}));
 assert.equal(j.kind,'tts');
 const after=await call('studio_get_project');assert.equal(after.generations.length,1);
 const g=after.generations[0];assert.equal(g.options.seed,14);
 const bytes=await fs.readFile(path.join(args['test-root'],name+'.dubproject',g.path));
 const out=path.join(path.dirname(args.proof),'audio8-seed14-cold.wav');await fs.writeFile(out,bytes);
 await fs.writeFile(args.proof,JSON.stringify({version:client.getServerVersion().version,officialSdk:true,oldSingleTakePath:true,seed:14,path:path.basename(out),sha256:createHash('sha256').update(bytes).digest('hex'),text:g.text,device:'CPU',hardwareQualified:false},null,2)+'\n');
 console.log('COLD_SINGLE_SEED14_GENERATED');
} finally {await client.close();}
