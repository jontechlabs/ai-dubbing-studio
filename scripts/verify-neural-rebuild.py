"""Authenticate passed base checks and Vox proofs before rebuilding identical app code.

The base job reached its global deadline after all packaged checks and the Vox
probes passed. Its runner retained no package artifact, so this workflow rebuilds
the same application and reruns packaged MCP, ASR, Chatterbox and conversion.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
REPO=os.environ['GITHUB_REPOSITORY']
BASE=int(os.environ['BASE_RUN_ID'])
EXPECTED='884f24423d0929749f554d3baf235322e708f2f8'
ALLOWED={'.github/workflows/windows.yml','.github/workflows/rebuild-neural.yml','scripts/verify-neural-rebuild.py','scripts/test-multilingual.py'}
NEURAL='Actual VoxCPM2 and Chatterbox V3 French generation from Japanese reference'
def api(path):
    request=urllib.request.Request('https://api.github.com/repos/'+REPO+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-identical-source-validation'})
    with urllib.request.urlopen(request,timeout=60) as response:return json.load(response)
run=api(f'/actions/runs/{BASE}')
assert REPO=='jontechlabs/ai-dubbing-studio' and run['head_sha']==EXPECTED and run['status']=='completed'
assert run['path']=='.github/workflows/windows.yml' and run['conclusion'] in ('cancelled','failure','timed_out')
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True,cwd=ROOT).strip()
subprocess.run(['git','merge-base','--is-ancestor',EXPECTED,head],cwd=ROOT,check=True)
changed=set(subprocess.check_output(['git','diff','--name-only',EXPECTED,head],cwd=ROOT,text=True).splitlines())
assert changed and changed<=ALLOWED,sorted(changed-ALLOWED)
jobs=api(f'/actions/runs/{BASE}/jobs')['jobs'];assert len(jobs)==2
job=next(j for j in jobs if j['name']=='windows')
assert next(j for j in jobs if j['name']=='windows-neural-completion')['conclusion']=='skipped'
boundary=next(i for i,s in enumerate(job['steps']) if s['name']==NEURAL)
assert job['steps'][boundary]['conclusion']=='cancelled'
for step in job['steps'][:boundary]:
    assert step['conclusion'] in ('success','skipped'),step['name']
for name in ['Frontend checks','Rust checks','Worker device and process checks','Real review-only character matching and embedding cache','Real local Japanese to French translation','Actual human and anime face detection on CPU','Drama 3 actual FP8 offload and tiny autoregressive diagnostic','CosyVoice causal vocoder finalization diagnostic','LatentSync actual neural core and official checkpoint architecture','Build unsigned Windows installer','Verify real Japanese reference transcription','Package portable build and checksums','Packaged desktop controlled through the official MCP SDK']:
    assert next(s for s in job['steps'] if s['name']==name)['conclusion']=='success',name
for name in ['Verify MCP-only changes and identical inference workers','Verify UI-only changes and identical native and audio engines']:
    assert next(s for s in job['steps'] if s['name']==name)['conclusion']=='skipped'
log=subprocess.check_output(['gh','run','view',str(BASE),'--log'],cwd=ROOT,encoding='utf8')
log=re.sub(r'(?:\x1b|\^\[)\[[0-?]*[ -/]*[@-~]','',log)
for expression in [r'Tests\s+174 passed',r'test result: ok\. 165 passed; 0 failed',r'174 passed \(',r'Ran 96 tests in']:
    assert re.search(expression,log),expression
def marker(name):
    lines=[line.split(name,1)[1].strip() for line in log.splitlines() if name in line]
    assert len(lines)==1,(name,len(lines))
    return json.loads(lines[0])
guide=marker('VOICE_LIBRARY_GUIDE_PROOF ')
vox=marker('ACTUAL_MULTILINGUAL_PROOF ')
assert vox['id']=='voxcpm2-bf16' and vox['standardTextWordOverlap']>=4 and vox['customLanguage']=='fr'
assert vox['modelLoads']==1 and vox['reuses']==1 and vox['standaloneRequests']==1
assert guide['modelLoads']==1 and guide['reuses']==2 and guide['inputAudioUnchanged'] and guide['twoIndependentFiles']
assert {p['mode'] for p in guide['probes']}=={'french-fidelity','acoustic-guide','hybrid-guide'}
assert all(p['language']=='fr' and p['textWordOverlap']>=4 and p['durationMs']>0 for p in guide['probes'])
variant=next(v for v in json.loads((ROOT/'workers/voice-engines.json').read_text())['variants'] if v['id']==vox['id'])
assert vox['revision']==variant['revision']
output=ROOT/'artifacts';output.mkdir(exist_ok=True)
def step_text(name):
    rows=[]
    for line in log.splitlines():
        fields=line.split('\t',2)
        if len(fields)==3 and fields[1]==name:
            rows.append(re.sub(r'^\d{4}-\d\d-\d\dT\S+\s?','',fields[2]))
    assert rows,name
    return '\n'.join(rows)+'\n'
for name,step,count in [
    ('translation-model-validation.txt','Real local Japanese to French translation',None),
    ('face-detection-validation.txt','Actual human and anime face detection on CPU',6),
    ('drama-core-validation.txt','Drama 3 actual FP8 offload and tiny autoregressive diagnostic',5),
    ('cosyvoice-tail-validation.txt','CosyVoice causal vocoder finalization diagnostic',None),
    ('latentsync-core-validation.txt','LatentSync actual neural core and official checkpoint architecture',7)]:
    text=step_text(step)
    if count is not None:assert text.count('PASS:')==count,(name,text.count('PASS:'))
    (output/name).write_text(text,encoding='utf8')
matching=marker('CHARACTER_MATCH_PROOF ')
assert matching['contentAndModelCacheReused'] and matching['referenceFilesUnchanged'] and not matching['assignmentsWritten']
(output/'character-match-validation.json').write_text(json.dumps(matching,indent=2)+'\n')
cached=ROOT/'.cache/validated-vox.json';cached.parent.mkdir(exist_ok=True)
validated=dict(device='CPU',hardwareQualified=False,isolatedEnvironment=True,embeddedPython=True,packagedWorkers=True,engines=[vox],voiceLibraryGuides=guide,authenticatedBaseRun=BASE,baseHead=EXPECTED)
cached.write_text(json.dumps(validated,indent=2)+'\n')
report=dict(baseRun=BASE,baseHead=EXPECTED,rebuildHead=head,baseJob=job['id'],sameApplicationSource=True,allowedChanges=sorted(changed),baseLogSha256=hashlib.sha256(log.encode()).hexdigest(),baseSuites=dict(typescript=174,rust=165,chrome=174,python=96),voxProofAuthenticated=True,threeFrenchGuidesPassed=True,rebuildRequiredBecause='Base job timed out after successful Vox probes; no package artifact survived. Rebuild from identical app sources and recheck actual packaged desktop.')
(output/'source-rebuild-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('IDENTICAL_APP_SOURCE_AND_BASE_CHECKS',json.dumps(report),flush=True)
