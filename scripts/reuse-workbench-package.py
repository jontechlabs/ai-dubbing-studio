"""Retest an authenticated signed package when only CI tests/scripts changed.

Requires successful build/package steps, exact compiled/resource/package inputs,
Actions ZIP digest, every release-file checksum and the updater signature. No
prior SDK failure is reused: models, ASR and the actual packaged SDK run freshly.
"""
from pathlib import Path
import hashlib,importlib.util,json,subprocess,sys
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('stage_evidence',ROOT/'scripts/stage-workbench-release.py')
e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
run_id=sys.argv[1];assert run_id.isdigit()
run=e.api('actions/runs/'+run_id)
assert run['status']=='completed' and run['path']=='.github/workflows/dubbing-workbench.yml'
head=e.git('rev-parse','HEAD');old=run['head_sha']
subprocess.run(['git','merge-base','--is-ancestor',old,head],cwd=ROOT,check=True)
protected=['src','src-tauri','workers','public','resources','package.json','pnpm-lock.yaml','vite.config.ts','tsconfig.json','eslint.config.js','playwright.config.ts','README.md','README.fr.md','VALIDATION.md','THIRD-PARTY-NOTICES.txt','docs','scripts/generate-mcp.mjs','scripts/prepare-ffmpeg.ps1','scripts/prepare-prosody.ps1','scripts/package-windows.ps1']
assert not e.git('diff','--name-only',old,head,'--',*protected)
jobs=e.api(f'actions/runs/{run_id}/jobs?per_page=100')['jobs']
assert len(jobs)==1 and jobs[0]['status']=='completed'
for name in ['Build Windows installer with updater signature','Package installer and portable build']:
 assert any(s['name']==name and s['conclusion']=='success' for s in jobs[0]['steps']),name
artifacts=e.api(f'actions/runs/{run_id}/artifacts')['artifacts']
name='windows-x64-development-build' if run['conclusion']=='success' else 'failure-diagnostics'
meta=next(a for a in artifacts if a['name']==name);assert meta['size_in_bytes']<600*1024**2
folder=ROOT/'.cache/reused-package';artifact=e.download_artifact(run_id,name,folder)
assert artifact['workflow_run']['head_sha']==old
version=json.loads((ROOT/'package.json').read_text())['version']
names={f'AI-Dubbing-Studio-{version}-Setup.exe',f'AI-Dubbing-Studio-{version}-Setup.exe.sig','AI-Dubbing-Studio-Windows-Portable.zip','SHA256SUMS.txt'}
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
for name in names:
 matches=list(folder.rglob(name));assert len(matches)==1,name
 (out/name).write_bytes(matches[0].read_bytes())
sums={name:digest for digest,name in (line.split('  ',1) for line in (out/'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines())}
assert set(sums)==names-{'SHA256SUMS.txt'}
assert all(e.sha(out/name)==digest for name,digest in sums.items())
setup=out/f'AI-Dubbing-Studio-{version}-Setup.exe'
assert e.version_of(setup)==(0,33,0,0)
subprocess.run(['cargo','run','--quiet','--locked','--manifest-path','scripts/verify-update-signature/Cargo.toml','--','src-tauri/tauri.conf.json',str(setup),str(setup)+'.sig'],cwd=ROOT,check=True)
proof=dict(runId=run_id,verifiedHead=old,head=head,artifactId=artifact['id'],artifactSha256=artifact['digest'],protectedInputs=protected,sourceIdentical=True,buildStepPassed=True,packageStepPassed=True,signatureVerified=True,assets={name:e.sha(out/name) for name in names})
(out/'reused-package-validation.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('Authenticated signed package reused; actual packaged SDK must pass freshly.',run_id,old,flush=True)
