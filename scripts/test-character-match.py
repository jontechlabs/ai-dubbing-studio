"""Real pinned CPU embeddings, content-keyed cache, and review-only proposals.

Synthetic fixtures are smoke tests, not speaker-identification accuracy metrics.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile
import urllib.request
import wave

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'workers'))
from character_match_worker import analyze
manifest=json.loads((ROOT/'workers/speaker-model.json').read_text())
runtime=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'.cache/character-match-runtime'
runtime.mkdir(parents=True,exist_ok=True)
for item in manifest['files']:
    if item['kind']!='model':continue
    path=runtime/item['name']
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:
        with urllib.request.urlopen(item['url'],timeout=120) as r:path.write_bytes(r.read())
    assert path.stat().st_size==item['size'] and hashlib.sha256(path.read_bytes()).hexdigest()==item['sha256']
fixtures=ROOT/'tests/fixtures/speakers'
metadata=json.loads((fixtures/'manifest.json').read_text())
for item in metadata:
    assert hashlib.sha256((fixtures/item['path']).read_bytes()).hexdigest()==item['sha256']
with tempfile.TemporaryDirectory(prefix='Proposition 日本-') as folder:
    work=Path(folder);refs=[dict(characterId=str(i),references=[dict(path=str(fixtures/item['path']),sha256=item['sha256'])]) for i,item in enumerate(metadata)]
    request=dict(runtime=str(runtime),cache=str(work/'cache'),input=str(fixtures/metadata[0]['path']),characters=refs,output=str(work/'result.json'))
    original={item['path']:(fixtures/item['path']).read_bytes() for item in metadata}
    results=[]
    for i in range(2):
        analyze(request);result=json.loads((work/'result.json').read_text());assert result['reliable'] and result['candidates'][0]['characterId']=='0',result;results.append(result)
        cache=list((work/'cache').glob('*.npy'));assert len(cache)==2
        snapshot={p.name:(p.stat().st_mtime_ns,p.read_bytes()) for p in cache}
        if i==0: first=snapshot
        else: assert snapshot==first,'Second request must reuse valid content/model-keyed embeddings'
    for name,data in original.items():assert (fixtures/name).read_bytes()==data
    with wave.open(str(work/'silent.wav'),'wb') as out:out.setparams((1,2,16000,0,'NONE',''));out.writeframes(b'\0'*64000)
    analyze(dict(request,input=str(work/'silent.wav')));silent=json.loads((work/'result.json').read_text());assert silent==dict(candidates=[],reason='tooShortOrNoSpeech',reliable=False)
    proof=dict(engine='CAMPPlus + Silero / sherpa-onnx 1.13.8',device='CPU',syntheticFixtures=True,referenceFilesUnchanged=True,contentAndModelCacheReused=True,matching=results[0],silence=silent,assignmentsWritten=False)
    (ROOT/'artifacts').mkdir(exist_ok=True);(ROOT/'artifacts/character-match-validation.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print('CHARACTER_MATCH_PROOF',json.dumps(proof),flush=True)
