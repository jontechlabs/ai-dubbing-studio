"""Real CPU weights, independent upstream golden parity, worker and PCM contracts."""
from pathlib import Path
import argparse,hashlib,importlib.util,json,os,subprocess,sys,time
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('spectral_fixture',Path(__file__).with_name('test-spectral-separation.py'))
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)

def main(args,work):
 sys.path.insert(0,str(ROOT/'workers'))
 import numpy as np,soundfile as sf,torch
 import inworld_isolator as adapter,audio_toolbox_worker as worker
 assert torch.__version__.split('+')[0]=='2.8.0'
 model_spec=next(m for m in json.loads((ROOT/'workers/audio-toolbox-models.json').read_text())['models'] if m['family']=='inworld')
 folder=work/'model-store/voice-engines/audio-toolbox'/model_spec['id']
 for row in model_spec['files']:fixture.fetch(row,folder/row['name'])
 rows=json.loads((ROOT/'scripts/inworld-smoke-audio.json').read_text())['files']
 for row in rows:fixture.fetch(row,work/'fixtures'/row['name'])
 with patch('socket.socket.connect',side_effect=AssertionError('Neural inference must remain offline')):
  model=adapter.engine(folder,'cpu');assert model.precision=='fp32'
  goldens=[]
  for name in ['offline_3s','offline_11s']:
   case=work/'fixtures'/name;meta=json.loads((case/'meta.json').read_text())
   assert fixture.digest(case/'input.wav')==meta['input_sha256'] and fixture.digest(case/'expected.npy')==meta['expected_sha256']
   assert fixture.digest(folder/'denoiser.safetensors')==meta['model_sha256']
   audio,rate=sf.read(case/'input.wav',dtype='float32');assert rate==48000
   started=time.monotonic();out,window,attempts=adapter.bounded(model,audio,8,'cpu',lambda _:None)
   error=float(np.max(np.abs(out-np.load(case/'expected.npy').reshape(-1))))
   assert error<meta['tolerance']==1e-4 and window==8 and attempts==1
   goldens.append(dict(fixture=name,maxAbsoluteError=error,elapsedMs=round((time.monotonic()-started)*1000),frames=len(out)))
  del model
  audio,_=sf.read(work/'fixtures/offline_3s/input.wav',dtype='float32')
  # Independent stereo bed and odd length exercise exact frame alignment.
  audio=np.pad(audio,(0,13));source=np.stack([audio,audio*.9+np.sin(np.arange(len(audio))*.03)*.002],axis=1).astype(np.float32)
  input_file=work/'input.wav';sf.write(input_file,source,48000,subtype='PCM_16');original=fixture.digest(input_file)
  decoded,_=sf.read(input_file,dtype='float32',always_2d=True)
  output=work/'results'/str(time.time_ns());output.parent.mkdir(exist_ok=True);request=dict(modelId=model_spec['id'],modelDir=str(folder),runtimeDir=str(work/'model-store/voice-engines/audio-toolbox-runtime'),inputPath=str(input_file),outputDir=str(output),resultPath=str(output)+'.json',device='cpu',prompt='',windowSeconds=2)
  worker.generate(request);result=json.loads(Path(request['resultPath']).read_text())
  assert result['precision']=='fp32' and result['windowMs']==2000 and result['device']=='cpu' and result['peakVramMb']==0
  assert fixture.digest(input_file)==original
  reconstructed=np.zeros_like(decoded)
  hashes={}
  for role in ['vocals','instrumental']:
   file=output/(role+'.wav');info=sf.info(file)
   assert info.frames==len(source) and info.channels==2 and info.samplerate==48000 and info.subtype=='PCM_16'
   wave,_=sf.read(file,dtype='float32',always_2d=True);assert np.isfinite(wave).all() and np.max(np.abs(wave))<=.981
   assert np.sqrt(np.mean(wave**2))>1e-7
   reconstructed+=wave;hashes[role]=fixture.digest(file)
  error=float(np.max(np.abs(reconstructed-decoded*result['commonGain'])))
  assert error<=2/32768
 video=work/'fixture.mkv'
 if not video.exists():subprocess.run([str(ROOT/'src-tauri/binaries/ffmpeg.exe'),'-v','error','-nostdin','-f','lavfi','-i','color=c=black:s=320x180:r=25','-i',str(input_file),'-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','pcm_s16le','-n',str(video)],check=True,timeout=60)
 files=['audio_toolbox_worker.py','inworld_isolator.py','audio-toolbox-models.json']+[p.relative_to(ROOT/'workers').as_posix() for p in (ROOT/'workers/vendor/inworld-isolator').rglob('*') if p.is_file()]
 hashes_source={n:hashlib.sha256((ROOT/'workers'/n).read_bytes().replace(b'\r\n',b'\n')).hexdigest() for n in files}
 report=dict(version='0.58.0',device='cpu',realNeuralInference=True,offlineSocketGuard=True,rtx5060TiQualified=False,shoutingQualityQualified=False,sourceRevision='c73b3fab81a870410cbac50d2f05f25edc4d10aa',goldens=goldens,scanBlock=8,peakRamBytes=fixture.peak_rss(),exactStereoFrames=len(source),reconstructionMaxError=error,sourcePreserved=True,outputHashes=hashes,inputSourceSha256=hashes_source,modelStore=str((work/'model-store').resolve()),video=str(video.resolve()))
 Path(args.proof).parent.mkdir(parents=True,exist_ok=True);Path(args.proof).write_text(json.dumps(report,indent=2)+'\n',encoding='utf8');print('INWORLD_NEURAL_PROOF',json.dumps(report),flush=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--work',required=True);parser.add_argument('--proof',required=True);parser.add_argument('--run',action='store_true');args=parser.parse_args();work=Path(args.work).resolve();work.mkdir(parents=True,exist_ok=True)
 if args.run:main(args,work)
 else:
  python=fixture.prepare_runtime(work,'audio-toolbox-runtime')
  extra=[json.loads((ROOT/'scripts/inworld-cpu-runtime.json').read_text()),next(r for r in json.loads((ROOT/'workers/audio-toolbox-runtime.json').read_text())['files'] if r['name'].startswith('safetensors-'))]
  for row in extra:fixture.unpack(fixture.fetch(row,work/'wheels'/row['name']),python.parent/'Lib/site-packages')
  subprocess.run([str(python),'-B',str(Path(__file__).resolve()),'--run','--work',str(work),'--proof',str(Path(args.proof).resolve())],check=True,timeout=1800,env={**os.environ,'PYTHONUTF8':'1','PYTHONDONTWRITEBYTECODE':'1','PYTHONUNBUFFERED':'1'})
