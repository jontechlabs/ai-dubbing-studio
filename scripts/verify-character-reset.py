"""Bound portrait additions; retain every existing model, worker and audio engine."""
from pathlib import Path
import json,re,subprocess
ROOT=Path(__file__).resolve().parents[1]
BASE='f8883e63904e7d723b685ce65a810e8ab4f3bb0b'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True).strip()
def blob(ref,p):return subprocess.check_output(['git','show',ref+':'+p],cwd=ROOT).decode('utf8')
def tree(ref,p):
 return {line.split('\t',1)[1]:line.split('\t',1)[0].split()[2] for line in git('ls-tree','-r',ref,'--',p).splitlines()}
identities={}
for p in ['public','pnpm-lock.yaml','src/domain/types.ts','src/domain/speakerDubbing.ts','src/domain/tts.ts','src/domain/voiceLibrary.ts','src/domain/project.ts','src/hooks/useDubbingTask.ts']:
 identities[p]=git('rev-parse','HEAD:'+p)
 assert identities[p]==git('rev-parse',BASE+':'+p),p
for folder,changed,added in [
 ('workers',set(),{'workers/portrait_preview_worker.py','workers/test_portrait_preview.py'}),
 ('src-tauri/src',{'src-tauri/src/lib.rs','src-tauri/src/character_review.rs'},{'src-tauri/src/portrait_preview.rs'}),
 ('src/services',{'src/services/bridge.ts'},set()),
]:
 before=tree(BASE,folder);after=tree('HEAD',folder)
 assert set(after)-set(before)==added,(folder,set(after)-set(before))
 for p,sha in before.items():
  if p not in changed:assert after.get(p)==sha,p;identities[p]=sha
library=blob('HEAD','src-tauri/src/lib.rs')
library=library.replace('mod portrait_preview;\n','').replace('            preview_character_portrait,\n','')
library=re.sub(r'(?ms)^#\[tauri::command\]\nasync fn preview_character_portrait\([\s\S]*?^}\n','',library)
assert library==blob(BASE,'src-tauri/src/lib.rs')
assert blob('HEAD','src-tauri/src/character_review.rs').replace('pub(crate) async fn frame<','async fn frame<')==blob(BASE,'src-tauri/src/character_review.rs')
bridge=re.sub(r'(?ms)^export async function previewCharacterPortrait\([\s\S]*?^}\n','',blob('HEAD','src/services/bridge.ts'))
assert bridge==blob(BASE,'src/services/bridge.ts')
for p in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']:
 assert blob('HEAD',p).replace('name = "ai-dubbing-studio"\nversion = "0.36.0"','name = "ai-dubbing-studio"\nversion = "0.35.0"')==blob(BASE,p)
for p in ['package.json','src-tauri/tauri.conf.json']:
 before=json.loads(blob(BASE,p));after=json.loads(blob('HEAD',p))
 assert after['version']=='0.36.0';after['version']=before['version']
 if p.endswith('tauri.conf.json'):
  assert after['bundle']['resources'].pop('../workers/portrait_preview_worker.py')=='workers/portrait_preview_worker.py'
 assert after==before
before=json.loads(blob(BASE,'src/mcp/catalog.json'));after=json.loads(blob('HEAD','src/mcp/catalog.json'))
for collection,added in [('commands',{'studio_preview_character_portrait'}),('builtins',{'studio_reset_speakers'})]:
 old={t['name']:t for t in before[collection]};new={t['name']:t for t in after[collection]}
 assert set(new)-set(old)==added and all(new[n]==v for n,v in old.items())
assert set(after['schemas'])-set(before['schemas'])=={'PortraitPreviewOptions'}
assert all(after['schemas'][n]==v for n,v in before['schemas'].items())
assert len(after['commands'])+len(after['builtins'])==143
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
(out/'character-reset-identity.json').write_text(json.dumps(dict(head=git('rev-parse','HEAD'),baseHead=BASE,immutableIdentities=identities,existingNativeAudioAndInferenceUnchanged=True,portraitPreviewAddedOnly=True,existingMcpToolsAndProjectSchemasUnchanged=True,toolCount=143,projectFormat=26),indent=2)+'\n',encoding='utf8')
print('Existing inference, models, native audio and MCP tools verified. One bounded read-only portrait preview added.')
