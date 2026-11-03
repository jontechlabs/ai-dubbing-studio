"""The update edits character UI/domain only; native inference and assets stay pinned."""
from pathlib import Path
import json,subprocess
ROOT=Path(__file__).resolve().parents[1]
BASE='f8883e63904e7d723b685ce65a810e8ab4f3bb0b'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True).strip()
identities={}
for p in ['workers','public','pnpm-lock.yaml','src-tauri/src','src/domain/types.ts','src/domain/speakerDubbing.ts','src/domain/tts.ts','src/domain/voiceLibrary.ts','src/domain/project.ts','src/services','src/hooks/useDubbingTask.ts']:
 identities[p]=git('rev-parse','HEAD:'+p)
 assert identities[p]==git('rev-parse',BASE+':'+p),p
for p in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']:
 before=subprocess.check_output(['git','show',BASE+':'+p],cwd=ROOT)
 after=(ROOT/p).read_bytes().replace(b'\r\n',b'\n')
 assert after.replace(b'name = "ai-dubbing-studio"\nversion = "0.36.0"',b'name = "ai-dubbing-studio"\nversion = "0.35.0"')==before
for p in ['package.json','src-tauri/tauri.conf.json']:
 before=json.loads(subprocess.check_output(['git','show',BASE+':'+p],cwd=ROOT));after=json.loads((ROOT/p).read_text())
 assert after['version']=='0.36.0';after['version']=before['version'];assert after==before
before=json.loads(subprocess.check_output(['git','show',BASE+':src/mcp/catalog.json'],cwd=ROOT));after=json.loads((ROOT/'src/mcp/catalog.json').read_text())
assert before['commands']==after['commands'] and before['schemas']==after['schemas']
assert len(after['commands'])+len(after['builtins'])==142
old={t['name']:t for t in before['builtins']};new={t['name']:t for t in after['builtins']}
assert set(new)-set(old)=={'studio_reset_speakers'}
assert all(new[n]==v for n,v in old.items())
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
(out/'character-reset-identity.json').write_text(json.dumps(dict(head=git('rev-parse','HEAD'),baseHead=BASE,immutableIdentities=identities,nativeAndInferenceUnchanged=True,existingMcpToolsAndSchemasUnchanged=True,toolCount=142,projectFormat=26),indent=2)+'\n',encoding='utf8')
print('Character changes bounded; native, inference, existing MCP inputs and assets verified.')
