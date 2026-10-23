// Live MCP transport for the Windows studio, using one restricted SSH channel
// per request. No project data, schemas or tool results are synthesized here.
// All remote arguments are passed directly to ssh.exe, without a shell.
import fs from 'node:fs';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const settings=JSON.parse(fs.readFileSync(process.argv[2]??new URL('./ssh-connection.json',import.meta.url),'utf8'));
const MAX=32*1024*1024;
const active=new Map();
const children=new Set();
let initialized=null,ready=false,closing=false;
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const reply=value=>{if(!closing)process.stdout.write(JSON.stringify(value)+'\n');};
const failure=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});

function finishChild(child){
  // A returned job ID belongs to the studio job queue. Closing an already
  // completed MCP request only cancels pending RPCs, not those returned jobs.
  child.stdin.end();
  const timer=setTimeout(()=>child.kill(),1500);
  timer.unref();
  child.once('close',()=>clearTimeout(timer));
}

function forward(request){
  return new Promise(resolve=>{
    const child=spawn(settings.command,settings.args,{
      env:{...process.env,...settings.env},windowsHide:true,stdio:['pipe','pipe','pipe'],
    });
    children.add(child);
    const entry={child,cancelled:false};
    active.set(request.id,entry);
    let buffer=Buffer.alloc(0),diagnostics='',finished=false;
    const timer=setTimeout(()=>finish(failure(request.id,-32000,'Studio SSH request timed out')),195000);
    const finish=response=>{
      if(finished)return;
      finished=true;clearTimeout(timer);
      if(active.get(request.id)===entry)active.delete(request.id);
      finishChild(child);
      resolve(entry.cancelled?null:response);
    };
    child.on('close',code=>{
      children.delete(child);
      if(!finished){
        if(diagnostics)process.stderr.write(diagnostics+'\n');
        finish(failure(request.id,-32000,`Studio SSH disconnected (exit ${code??'unknown'})`));
      }
    });
    child.on('error',error=>finish(failure(request.id,-32000,'Cannot start studio SSH: '+error.message)));
    child.stdin.on('error',error=>{
      if(!finished)finish(failure(request.id,-32000,'Cannot write studio SSH: '+error.message));
    });
    child.stderr.on('data',data=>{diagnostics=(diagnostics+data.toString('utf8')).slice(-2000);});
    child.stdout.on('data',data=>{
      if(finished)return;
      buffer=Buffer.concat([buffer,data]);
      if(buffer.length>MAX){finish(failure(request.id,-32000,'Studio response exceeds 32 MiB'));return;}
      let newline;
      while((newline=buffer.indexOf(10))!==-1){
        const line=buffer.subarray(0,newline);buffer=buffer.subarray(newline+1);
        if(!line.length)continue;
        let response;
        try{response=JSON.parse(line.toString('utf8'));}
        catch{finish(failure(request.id,-32000,'Invalid JSON from studio SSH'));return;}
        if(response.id===request.id){finish(response);return;}
        if(response.error){finish(failure(request.id,response.error.code,response.error.message));return;}
      }
    });
    const bootstrap={jsonrpc:'2.0',id:'relay-init-'+randomUUID(),method:'initialize',params:initialized??{
      protocolVersion:'2025-11-25',clientInfo:{name:'codex-studio-relay',version:'1.0.0'},capabilities:{},
    }};
    const frames=request.method==='initialize'?[request]:[
      bootstrap,{jsonrpc:'2.0',method:'notifications/initialized'},request,
    ];
    // Sent in the FIRST write, before initialize. The remote CLI exits after
    // flushing this exact response, even if Windows SSH never forwards EOF.
    // Older studio versions ignore the notification and retain the EOF fallback.
    frames.unshift({jsonrpc:'2.0',method:'notifications/studio/one-shot',params:{requestId:request.id}});
    // Group before the first write: affected Windows SSH shells otherwise
    // buffer subsequent short writes to a long-lived child process.
    child.stdin.write(frames.map(value=>JSON.stringify(value)).join('\n')+'\n');
  });
}

input.on('line',async line=>{
  if(closing||!line.trim())return;
  if(Buffer.byteLength(line)>MAX){reply(failure(null,-32600,'Message exceeds 32 MiB'));return;}
  let request;
  try{request=JSON.parse(line);}
  catch{reply(failure(null,-32700,'Invalid JSON'));return;}
  if(!request||request.jsonrpc!=='2.0'||typeof request.method!=='string'){
    reply(failure(request?.id??null,-32600,'Invalid JSON-RPC request'));return;
  }
  if(request.id===undefined){
    if(request.method==='notifications/initialized'&&initialized)ready=true;
    if(request.method==='notifications/cancelled'){
      const entry=active.get(request.params?.requestId);
      if(entry){
        entry.cancelled=true;
        // MCP cancellation is best effort. Close this request's channel only;
        // explicit studio_cancel_job controls jobs which already returned IDs.
        entry.child.stdin.end(JSON.stringify(request)+'\n');
        const timer=setTimeout(()=>entry.child.kill(),1500);timer.unref();
        entry.child.once('close',()=>clearTimeout(timer));
      }
    }
    return;
  }
  if(typeof request.id!=='string'&&!(typeof request.id==='number'&&Number.isSafeInteger(request.id))){
    reply(failure(null,-32600,'Invalid request ID'));return;
  }
  if(active.has(request.id)){reply(failure(request.id,-32600,'Duplicate request ID'));return;}
  if(active.size>=12){reply(failure(request.id,-32000,'Studio MCP busy'));return;}
  if(request.method==='initialize'&&initialized){reply(failure(request.id,-32602,'Already initialized'));return;}
  if(!['initialize','ping'].includes(request.method)&&!ready){
    reply(failure(request.id,-32002,'Initialize the MCP session first'));return;
  }
  const response=await forward(request);
  if(request.method==='initialize'&&response?.result)initialized=request.params;
  if(response)reply(response);
});

function shutdown(){
  if(closing)return;
  closing=true;input.close();
  for(const child of children)finishChild(child);
  process.stdin.destroy();
}
input.on('close',shutdown);
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
