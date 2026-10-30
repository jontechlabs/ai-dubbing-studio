"""All three full-weight local separators on a real mixed Japanese/English/Korean clip.

CPU inference and packaging checks only; no GPU or language-quality qualification.
"""
from pathlib import Path
import hashlib,json,os,subprocess,time,urllib.request,zipfile,wave
ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.cache/speaker-separation-smoke/Référence 日本語';WORK.mkdir(parents=True,exist_ok=True)
def digest(p):
 with p.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def fetch(spec,target):
 target.parent.mkdir(parents=True,exist_ok=True)
 if target.is_file() and target.stat().st_size==spec['size'] and digest(target)==spec['sha256']:return target
 partial=target.with_name(target.name+'.part')
 for attempt in range(3):
  try:
   with urllib.request.urlopen(urllib.request.Request(spec['url'],headers={'User-Agent':'AI-Dubbing-Studio-speaker-separation-validation'}),timeout=180) as response,partial.open('wb') as output:
    while block:=response.read(8*1024**2):output.write(block)
   assert partial.stat().st_size==spec['size'] and digest(partial)==spec['sha256'],target.name
   partial.replace(target);return target
  except Exception:
   if attempt==2:raise
   time.sleep(2)
def extract(source,target):
 target.mkdir(parents=True,exist_ok=True)
 with zipfile.ZipFile(source) as archive:
  assert all((target/name).resolve().is_relative_to(target.resolve()) for name in archive.namelist())
  archive.extractall(target)
store=WORK/'model-store';engines=store/'voice-engines'
runtime=engines/'speaker-separation-runtime'
python_root=runtime/'python';python=python_root/'python.exe'
extract(fetch(dict(url='https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip',size=11133606,sha256='4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'),WORK/'python.zip'),python_root)
(python_root/'python312._pth').write_text('python312.zip\n.\nLib/site-packages\nimport site\n',encoding='utf-8')
manifest=json.loads((ROOT/'workers/speaker-separation-runtime.json').read_text())
for row in manifest['files']:extract(fetch(row,WORK/'wheels'/row['name']),python_root/'Lib/site-packages')
env={**os.environ,'PYTHONUTF8':'1','PYTHONDONTWRITEBYTECODE':'1','PYTHONUNBUFFERED':'1','OMP_NUM_THREADS':'2','MKL_NUM_THREADS':'2','HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','HF_HUB_DISABLE_TELEMETRY':'1'}
worker=ROOT/'workers/speaker_separation_worker.py'
subprocess.run([str(python),'-B',str(worker),'--info'],env=env,check=True,timeout=180)
subprocess.run([str(python),'-B','-m','unittest','discover','-s',str(ROOT/'workers'),'-p','test_speaker_separation_worker.py'],env=env,check=True,timeout=180)
sources=json.loads((ROOT/'scripts/speaker-separation-smoke-audio.json').read_text())['files']
audio=[fetch(row,WORK/'source'/row['name']) for row in sources]
source_hashes=[digest(p) for p in audio]
models=json.loads((ROOT/'workers/speaker-separation-models.json').read_text())['models'];proof=[]
for model in models:
 folder=engines/'speaker-separation'/model['id']
 for row in model['files']:fetch(row,folder/row['name'])
 mixture=WORK/(model['id']+'-input.wav');output=WORK/model['id'];request=WORK/(model['id']+'-request.json')
 count=model['speakers'];frames=120000
 args=[str(ROOT/'src-tauri/binaries/ffmpeg.exe'),'-v','error','-nostdin']
 for file in audio[:count]:args+=['-i',str(file)]
 filters=[f'[{i}:a]aresample=48000,aformat=channel_layouts=mono,atrim=end_sample={frames},asetpts=N/SR/TB,volume={.5/(i+1):.6f}[v{i}]' for i in range(count)]
 filters.append(''.join(f'[v{i}]' for i in range(count))+f'amix=inputs={count}:normalize=0:dropout_transition=0,apad,atrim=end_sample={frames}[mix]')
 args+=['-filter_complex',';'.join(filters),'-map','[mix]','-ac','1','-ar','48000','-c:a','pcm_s16le','-y',str(mixture)]
 subprocess.run(args,check=True,timeout=60);before=digest(mixture)
 request.write_text(json.dumps(dict(modelId=model['id'],modelDir=str(folder),inputPath=str(mixture),outputDir=str(output),device='cpu',windowMs=2000)),encoding='utf-8')
 started=time.monotonic();process=subprocess.run([str(python),'-B',str(worker),'--request',str(request)],env=env,text=True,encoding='utf-8',capture_output=True,timeout=900)
 (WORK/(model['id']+'.stdout.log')).write_text(process.stdout,encoding='utf-8');(WORK/(model['id']+'.stderr.log')).write_text(process.stderr,encoding='utf-8')
 if process.returncode:print(process.stdout);print(process.stderr[-14000:]);raise RuntimeError(model['id'])
 result=json.loads((output/'result.json').read_text());assert result['modelId']==model['id'] and result['device']=='cpu' and result['peakVramMb']==0
 assert len(result['outputs'])==count and result['frames']==frames and 0<result['commonGain']<=1
 assert len({r['sha256'] for r in result['outputs']})==count
 for row in result['outputs']:
  file=output/row['path'];assert file.stat().st_size==row['size'] and digest(file)==row['sha256']
  with wave.open(str(file)) as stream:assert stream.getnchannels()==1 and stream.getsampwidth()==2 and stream.getframerate()==48000 and stream.getnframes()==frames
 assert digest(mixture)==before and [digest(p) for p in audio]==source_hashes
 proof.append(dict(modelId=model['id'],speakers=count,frames=frames,sampleRate=48000,device='CPU',seconds=round(time.monotonic()-started,2),sourceUnchanged=True,distinctStreams=True,rmsDb=[r['rmsDb'] for r in result['outputs']]))
 print('SPEAKER_SEPARATION_MODEL_PROOF',json.dumps(proof[-1]),flush=True)
(runtime/'ready.json').write_text(json.dumps(dict(profile=manifest['profile'])),encoding='utf-8')
(runtime/'devices.json').write_text(json.dumps(dict(devices=[dict(id='cpu',name='CPU')])),encoding='utf-8')
paths=['workers/speaker_separation_worker.py','workers/speaker-separation-models.json','workers/speaker-separation-runtime.json','workers/vendor/speaker-separation/mossformer2-source.zip']
report=dict(head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),models=proof,profile=manifest['profile'],runtimeWheels=len(manifest['files']),identities={p:digest(ROOT/p) for p in paths},gpuBenchmark=False,languageQualityBenchmark=False)
(ROOT/'artifacts').mkdir(exist_ok=True);(ROOT/'artifacts/speaker-separation-validation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
