import contextlib
import gc
import io
import json
from pathlib import Path
import sys
import subprocess
import shutil
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import weakref

import numpy as np
import soundfile as sf
import batch_worker


def modules(names):
    result = {}
    for name in names:
        parts = name.split('.')
        for n in range(1, len(parts) + 1):
            key = '.'.join(parts[:n])
            if key not in result:
                result[key] = types.ModuleType(key)
                result[key].__path__ = []
            if n > 1:
                setattr(result['.'.join(parts[:n-1])], parts[n-1], result[key])
    return result


class BatchSessionTests(unittest.TestCase):
    def test_standalone_adapter_bootstraps_in_isolated_python_and_reuses_one_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            adapter=root/'batch_worker.py';shutil.copyfile(Path(batch_worker.__file__),adapter)
            (root/'cosyvoice_worker.py').write_text("import json,os\nfrom pathlib import Path\ndef generate(request,state):\n    if 'model' not in state:state['model']=object();state['loads']=1\n    Path(request['resultPath']).write_text(json.dumps(dict(pid=os.getpid(),loads=state['loads'],text=request['text'])))\n",encoding='utf-8')
            commands=[]
            for index,text in enumerate(['Bonjour','Bonsoir']):
                path=root/f'request-{index}.json';path.write_text(json.dumps(dict(text=text,resultPath=str(root/f'{index}.json'))),encoding='utf-8-sig')
                commands.append(json.dumps(dict(requestId=str(index),path=str(path))))
            result=subprocess.run([sys.executable,'-I','-B',str(adapter),'--engine','cosyvoice_worker'],input='\n'.join(commands)+'\n',text=True,encoding='utf-8',capture_output=True,timeout=15,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            self.assertEqual(result.returncode,0,result.stderr)
            output=[json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(output,[{'requestDone':'0'},{'requestDone':'1'}])
            a,b=[json.loads((root/f'{index}.json').read_text()) for index in [0,1]]
            self.assertEqual(a['pid'],b['pid']);self.assertEqual([a['loads'],b['loads']],[1,1])
            self.assertEqual([a['text'],b['text']],['Bonjour','Bonsoir'])

    def test_model_device_and_compatibility_profile_cannot_change_inside_a_session(self):
        for changed in [{'device':'cuda:1'}, {'modelDir':'other'}, {'variantId':'other'}, {'compatibilityMode':True}]:
            calls=[]
            with tempfile.TemporaryDirectory() as directory:
                commands=[]
                for index,extra in enumerate([{},changed]):
                    path=Path(directory)/f'{index}.json'
                    path.write_text(json.dumps(dict(device='cpu',modelDir='model',variantId='cosy',**({'compatibilityMode':False} if 'compatibilityMode' not in extra else {})) | extra))
                    commands.append(json.dumps({'requestId':str(index),'path':str(path)}))
                protocol=io.StringIO()
                with contextlib.redirect_stderr(io.StringIO()):
                    batch_worker.serve(types.SimpleNamespace(generate=lambda request,state:calls.append(request)),io.StringIO('\n'.join(commands)),protocol)
                self.assertEqual(len(calls),1)
                self.assertEqual(json.loads(protocol.getvalue().splitlines()[-1]),{'requestDone':'1','error':'INVALID_TTS_REQUEST'})

    def test_one_cache_serves_distinct_requests_and_dies_when_session_ends(self):
        class Model: pass
        refs, calls = [], []
        module = types.SimpleNamespace()
        def generate(request, state):
            if 'model' not in state:
                state['model'] = Model(); refs.append(weakref.ref(state['model']))
            calls.append((request['text'], id(state['model'])))
            print('third-party output')
        module.generate = generate
        with tempfile.TemporaryDirectory() as directory:
            incoming = []
            for index, text in enumerate(['Bonjour', 'Bonsoir']):
                path = Path(directory) / f'référence-{index}.json'
                path.write_text(json.dumps({'text': text}), encoding='utf-8-sig')
                incoming.append(json.dumps({'requestId': str(index), 'path': str(path)}))
            protocol, logs = io.StringIO(), io.StringIO()
            with contextlib.redirect_stderr(logs):
                batch_worker.serve(module, io.StringIO('\n'.join(incoming)), protocol)
        self.assertEqual([c[0] for c in calls], ['Bonjour', 'Bonsoir'])
        self.assertEqual(calls[0][1], calls[1][1])
        self.assertEqual(len(refs), 1)
        gc.collect(); self.assertIsNone(refs[0]())
        self.assertEqual([json.loads(line) for line in protocol.getvalue().splitlines()], [{'requestDone':'0'}, {'requestDone':'1'}])
        self.assertIn('third-party output', logs.getvalue())

    def test_failed_context_never_accepts_a_second_request(self):
        calls = []
        def generate(request, state):
            calls.append(request)
            raise RuntimeError('CUDA out of memory')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'r.json';path.write_text('{}')
            command = json.dumps({'requestId':'one','path':str(path)})+'\n'
            protocol = io.StringIO()
            with contextlib.redirect_stderr(io.StringIO()):
                batch_worker.serve(types.SimpleNamespace(generate=generate), io.StringIO(command+command), protocol)
        self.assertEqual(len(calls), 1)
        self.assertEqual(json.loads(protocol.getvalue()), {'requestDone':'one','error':'TTS_OUT_OF_MEMORY'})

    def test_cosyvoice_loads_and_verifies_once_but_seeds_and_renders_each_line(self):
        import cosyvoice_worker as cosy
        fake = modules(['cosyvoice.cli.cosyvoice','cosyvoice_adapter'])
        model = object(); rng = [0]
        def construct(*args,**kwargs):
            rng[0] += 100  # Simulate random numbers consumed while constructing layers.
            return model
        factory = Mock(side_effect=construct)
        fake['cosyvoice.cli.cosyvoice'].CosyVoice3 = factory
        fake['cosyvoice.cli.cosyvoice'].load_hyperpyyaml = object()
        fake['cosyvoice_adapter'].inference_yaml = object()
        seed = Mock(side_effect=lambda value:rng.__setitem__(0,value))
        fake['torch'] = types.SimpleNamespace(set_num_threads=Mock(),random=types.SimpleNamespace(default_generator=types.SimpleNamespace(manual_seed=seed)))
        state = {}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'ref.wav';sf.write(path,np.ones(24000,dtype=np.float32)*.1,24000)
            request=dict(device='cpu',referenceAudio=str(path),modelDir=directory,text='Bonjour',language='fr',mode='crossLingual',speed=1,seed=1)
            with patch.dict(sys.modules,fake), patch.object(cosy,'verify_model') as verify, patch.object(cosy,'track_reference') as track, patch.object(cosy,'render',side_effect=lambda model,request,*args:self.assertEqual(rng[0],request['seed'])) as render:
                cosy.generate_normalized(request,state)
                cosy.generate_normalized(dict(request,text='Bonsoir',seed=2),state)
                self.assertEqual(factory.call_count,1);verify.assert_called_once();track.assert_called_once()
                self.assertEqual(render.call_count,2)
                self.assertTrue(all(call.args[0] is model for call in render.call_args_list))
                self.assertEqual([call.args[0] for call in seed.call_args_list],[1,1,2,2])

    def test_fish_reuses_engine_and_codec_without_reusing_text_seed_or_transcript(self):
        import fish_worker as fish
        fake=modules(['fish_speech.models.text2semantic.inference','fish_speech.models.dac.inference','fish_speech.inference_engine','fish_speech.utils.schema'])
        requests=[]
        class Request:
            def __init__(self,**kwargs):self.__dict__.update(kwargs);requests.append(kwargs)
        class Engine:
            def __init__(self,*args):pass
            def inference(self,request):
                yield types.SimpleNamespace(code='final',audio=(24000,np.ones(2400,dtype=np.float32)*.1))
        launch=Mock(return_value=(object(),object()));decoder=Mock(return_value=object());engine=Mock(side_effect=Engine)
        fake['fish_speech.models.text2semantic.inference'].launch_thread_safe_queue=launch
        fake['fish_speech.models.dac.inference'].load_model=decoder
        fake['fish_speech.inference_engine'].TTSInferenceEngine=engine
        fake['fish_speech.utils.schema'].ServeTTSRequest=Request
        fake['fish_speech.utils.schema'].ServeReferenceAudio=lambda **kwargs:types.SimpleNamespace(**kwargs)
        fake['torch']=types.SimpleNamespace(bfloat16=object(),cuda=types.SimpleNamespace(max_memory_allocated=lambda:0))
        fake['librosa']=types.SimpleNamespace(resample=lambda audio,**kwargs:audio)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'ref.wav';sf.write(path,np.ones(24000,dtype=np.float32)*.1,24000)
            request=dict(text='Bonjour',referenceTranscript='Original 1',speed=1,seed=1,outputPath=str(Path(directory)/'out.wav'),resultPath=str(Path(directory)/'out.json'))
            state={}
            with patch.dict(sys.modules,fake):
                fish.synthesize(request,path,Path(directory),'cuda','cuda:0','Protocol test',session=state)
                fish.synthesize(dict(request,text='Bonsoir',seed=2,referenceTranscript='Original 2'),path,Path(directory),'cuda','cuda:0','Protocol test',session=state)
            self.assertEqual(engine.call_count,1);launch.assert_called_once();decoder.assert_called_once()
            self.assertEqual([r['text'] for r in requests],['Bonjour','Bonsoir'])
            self.assertEqual([r['seed'] for r in requests],[1,2])
            self.assertEqual([r['references'][0].text for r in requests],['Original 1','Original 2'])
            self.assertTrue(all(r['use_memory_cache']=='off' for r in requests))


if __name__ == '__main__':unittest.main()
