"""Actual Windows embedded runtime and all five pinned separation models on CPU.

No user files. Neural quality and RTX speed are not inferred from this smoke test.
"""
from pathlib import Path
import hashlib,json,os,subprocess,sys,time,urllib.request,zipfile,wave
ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.cache/audio-toolbox-smoke'
WORK.mkdir(parents=True,exist_ok=True)
def digest(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def fetch(spec,path):
 path.parent.mkdir(parents=True,exist_ok=True)
 if not path.is_file() or path.stat().st_size!=spec['size'] or digest(path)!=spec['sha256']:
  for attempt in range(3):
   try:
    request=urllib.request.Request(spec['url'],headers={'User-Agent':'AI-Dubbing-Studio/0.32 validation'})
    with urllib.request.urlopen(request,timeout=180) as r,path.open('wb') as f:
     while b:=r.read(8*1024*1024):f.write(b)
    break
   except Exception:
    if attempt==2:raise
    time.sleep(3)
 assert path.stat().st_size==spec['size'] and digest(path)==spec['sha256'],path
 return path
def extract(path,target):
 target.mkdir(parents=True,exist_ok=True)
 with zipfile.ZipFile(path) as z:
  assert all((target/n).resolve().is_relative_to(target.resolve()) for n in z.namelist())
  z.extractall(target)
runtime=WORK/'runtime';python=runtime/'python/python.exe';site=runtime/'python/Lib/site-packages'
extract(fetch(dict(url='https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip',size=11133606,sha256='4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'),WORK/'python.zip'),python.parent)
(python.parent/'python312._pth').write_text('python312.zip\n.\nLib/site-packages\nimport site\n')
manifest=json.loads((ROOT/'workers/audio-toolbox-runtime.json').read_text())
for spec in manifest['files']:
 wheel=ROOT/'workers'/spec['bundledPath'] if spec.get('bundledPath') else fetch(spec,WORK/'wheels'/spec['name'])
 assert wheel.stat().st_size==spec['size'] and digest(wheel)==spec['sha256'],wheel
 extract(wheel,site)
extract(ROOT/'workers/vendor/audio-toolbox/audiosep-core.zip',runtime/'audiosep')
env={**os.environ,'PYTHONUNBUFFERED':'1','PYTHONDONTWRITEBYTECODE':'1','PYTHONUTF8':'1','OMP_NUM_THREADS':'2','MKL_NUM_THREADS':'2','HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1'}
env['PATH']=str(ROOT/'src-tauri/binaries')+os.pathsep+env['PATH']
worker=ROOT/'workers/audio_toolbox_worker.py'
subprocess.run([str(python),'-B',str(worker),'--runtime-info'],check=True,env=env,timeout=180)
sample=fetch(dict(url='https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/ja.wav',size=230444,sha256='460bd8dccb0d2a5f4e29c628f837be4082d13defc64c3fc21dd1b6bb0e119095'),WORK/'ja.wav')
# The authoritative size is checked above as well as SHA. Keep the source intact.
input=WORK/'input.wav'
subprocess.run([str(ROOT/'src-tauri/binaries/ffmpeg.exe'),'-v','error','-i',str(sample),'-t','1.25','-ac','2','-ar','48000','-c:a','pcm_s16le','-y',str(input)],check=True)
original=digest(input);proof=[]
models=json.loads((ROOT/'workers/audio-toolbox-models.json').read_text())['models']
for model in models:
 folder=WORK/'models'/model['id']
 for spec in model['files']:fetch(spec,folder/spec['name'])
 output=WORK/model['id'];result=WORK/(model['id']+'.json');request=WORK/(model['id']+'-request.json')
 request.write_text(json.dumps(dict(modelId=model['id'],modelDir=str(folder),runtimeDir=str(runtime),inputPath=str(input),outputDir=str(output),resultPath=str(result),device='cpu',prompt='A person speaking',windowSeconds=2)))
 start=time.monotonic();run=subprocess.run([str(python),'-B',str(worker),'--request',str(request)],env=env,text=True,capture_output=True,timeout=900)
 (WORK/(model['id']+'.stdout.log')).write_text(run.stdout,encoding='utf-8');(WORK/(model['id']+'.stderr.log')).write_text(run.stderr,encoding='utf-8')
 if run.returncode:print(run.stdout);print(run.stderr[-14000:]);raise RuntimeError(model['id'])
 data=json.loads(result.read_text());assert {v['id'] for v in data['outputs']}==set(model['outputs'])
 assert data['device']=='cpu' and 0<data['commonGain']<=1
 for row in data['outputs']:
  with wave.open(str(output/row['file'])) as w:assert w.getnframes()==60000 and w.getnchannels()==2 and w.getsampwidth()==2 and w.getframerate()==48000
 assert digest(input)==original
 proof.append(dict(model=model['id'],frames=60000,outputs=model['outputs'],seconds=round(time.monotonic()-start,2),device='CPU',sourceUnchanged=True))
 print('MODEL_SMOKE',proof[-1],flush=True)
(ROOT/'artifacts').mkdir(exist_ok=True)
(ROOT/'artifacts/audio-toolbox-validation.json').write_text(json.dumps(dict(head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),models=proof,torchProfile=manifest['profile'],runtimeWheels=len(manifest['files']),identities={p:digest(ROOT/p) for p in ['workers/audio_toolbox_worker.py','workers/audio-toolbox-models.json','workers/audio-toolbox-runtime.json','workers/vendor/audio-toolbox/audiosep-core.zip']},gpuBenchmark=False),indent=2)+'\n')
