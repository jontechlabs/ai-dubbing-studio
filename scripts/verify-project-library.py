"""Bound project lifecycle changes; preserve inference, DSP, dependencies and old MCP contracts."""
from pathlib import Path
import json,re,subprocess
ROOT=Path(__file__).resolve().parents[1]
BASE='8bc17ca4a3ab4c2ec75cce247f532fbaf56d8191'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
def source(ref,path):return subprocess.check_output(['git','show',ref+':'+path],cwd=ROOT).decode('utf8')
identities={}
for path in ['workers','public','pnpm-lock.yaml','src-tauri/binaries']:
 identities[path]=git('rev-parse','HEAD:'+path);assert identities[path]==git('rev-parse',BASE+':'+path),path
assert set(git('diff','--name-only',BASE,'HEAD','--','src-tauri/src').splitlines())=={'src-tauri/src/project_library.rs','src-tauri/src/lib.rs'}
for path in git('ls-tree','-r','--name-only','HEAD','--','src-tauri/src','src/domain').splitlines():
 if path in ['src-tauri/src/project_library.rs','src-tauri/src/lib.rs','src/domain/projectLibrary.ts','src/domain/projectLibrary.test.ts']:continue
 identities[path]=git('rev-parse','HEAD:'+path);assert identities[path]==git('rev-parse',BASE+':'+path),path
lib=source('HEAD','src-tauri/src/lib.rs').replace('mod project_library;\n','')
lib=lib.replace('    project_library::remember(core, &root, &p, true)?;\n','')
lib=lib.replace('        let _permit = project_library::idle(&core)?;','        ensure_idle(&core)?;')
lib=re.sub(r'#\[tauri::command\]\nfn current_project\([\s\S]+?(?=#\[tauri::command\]\nasync fn restore_project)', '',lib)
commands=['current_project','list_projects','create_library_project','open_registered_project','rename_registered_project','trash_registered_project','restore_registered_project','forget_registered_project','close_project','project_cover']
for command in commands:lib=lib.replace('            '+command+',\n','')
assert lib==source(BASE,'src-tauri/src/lib.rs'),'Existing native handlers changed outside project lifecycle'
for path in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']:
 assert source('HEAD',path).replace('name = "ai-dubbing-studio"\nversion = "0.40.0"','name = "ai-dubbing-studio"\nversion = "0.39.1"')==source(BASE,path)
for path in ['package.json','src-tauri/tauri.conf.json']:
 before=json.loads(source(BASE,path));after=json.loads(source('HEAD',path));assert after['version']=='0.40.0';after['version']=before['version'];assert after==before
before=json.loads(source(BASE,'src/mcp/catalog.json'));after=json.loads(source('HEAD','src/mcp/catalog.json'))
added=[c for c in after['commands'] if c['command'] in commands];assert len(added)==10
after['commands']=[c for c in after['commands'] if c not in added];assert after==before,'Old MCP contracts changed'
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
(out/'project-library-identity.json').write_text(json.dumps(dict(head=git('rev-parse','HEAD'),baseHead=BASE,immutableIdentities=identities,inferenceWorkersAndDspUnchanged=True,projectLifecycleOnly=True,existingMcpToolsAndProjectFormatRetained=True,toolCount=155,projectFormat=26),indent=2)+'\n',encoding='utf8')
print('Project lifecycle changes verified; previous inference, DSP, dependencies, 145 MCP tools and project format retained.')
