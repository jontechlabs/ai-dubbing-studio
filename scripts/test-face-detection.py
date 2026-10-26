"""Actual CPU model checks; fixture images are downloaded only to a temporary folder."""
from pathlib import Path
import hashlib,json,sys,tempfile,urllib.request,subprocess
import numpy as np
import cv2
sys.dont_write_bytecode=True
repo=Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo/'workers'))
from face_detection_worker import Detector,propose
def fetch(f,root):
    data=urllib.request.urlopen(urllib.request.Request(f['url'],headers={'User-Agent':'AI-Dubbing-Studio-validation'}),timeout=60).read()
    assert len(data)==f['size'] and hashlib.sha256(data).hexdigest()==f['sha256']
    path=root/f['name'];path.write_bytes(data);return path
with tempfile.TemporaryDirectory(prefix='faces-é-') as folder:
    root=Path(folder);manifest=json.loads((repo/'workers/face-detection.json').read_text())
    for f in manifest['files']:fetch(f,root)
    print('PASS: pinned YuNet and anime cascade sizes/SHA-256',flush=True)
    fixtures=json.loads((repo/'scripts/face-test-fixtures.json').read_text())
    for f,profile in zip(fixtures,['live','anime']):
        path=fetch(f,root);image=cv2.imdecode(np.fromfile(path,dtype='uint8'),cv2.IMREAD_COLOR)
        detector=Detector(root,profile);boxes=detector.detect(image)
        assert len(boxes)==1,(profile,boxes)
        assert len(Detector(root,'auto').detect(image))==1
        crop=propose([boxes]*5)['crop'];assert crop is not None
        image_dir=root/profile;image_dir.mkdir()
        for n in range(5):cv2.imencode('.png',image)[1].tofile(image_dir/f'{n:06}.png')
        assert detector.analyze(image_dir)['crop'] is not None
        request=image_dir/'request.json';output=image_dir/'result.json'
        request.write_text(json.dumps(dict(profile=profile,models=str(root),inputDirectory=str(image_dir),output=str(output))),encoding='utf-8-sig')
        subprocess.run([sys.executable,'-B',str(repo/'workers/face_detection_worker.py'),'--request',str(request)],check=True,capture_output=True)
        assert json.loads(output.read_text())['crop'] is not None
        portrait_output=image_dir/'portrait.png';metadata=image_dir/'portraits.json';portrait_request=image_dir/'portrait-request.json'
        portrait_request.write_text(json.dumps(dict(profile=profile,models=str(root),auto=True,items=[dict(input=str(path),output=str(portrait_output),metadata=dict(path='characters/portrait.png',sourcePath='media/video.mkv',lineId='dialogue',atMs=1000))],output=str(metadata))),encoding='utf-8-sig')
        subprocess.run([sys.executable,'-B',str(repo/'workers/character_worker.py'),'--request',str(portrait_request)],check=True,capture_output=True)
        portrait=json.loads(metadata.read_text())[0]
        assert portrait['confirmed'] is False and len(portrait['colors'])==48 and len(portrait['differenceHash'])==16
        assert cv2.imdecode(np.fromfile(portrait_output,dtype='uint8'),cv2.IMREAD_COLOR).shape==(256,256,3)
        assert portrait['crop']['width']<1 and portrait['crop']['height']<1
        print(f'PASS: actual {profile} proposed 256px character crop, image descriptors and Unicode worker paths',flush=True)
        both=np.concatenate([image,image],axis=1)
        assert len(detector.detect(both))>=2
        assert propose([detector.detect(both)]*5)['reason']=='FACE_MULTIPLE'
        print(f'PASS: actual {profile} face detection, five-frame proposal and multiple-face refusal on CPU',flush=True)
    black=np.zeros((512,512,3),dtype='uint8')
    assert Detector(root,'auto').detect(black)==[]
    print('PASS: actual detectors reject an empty frame',flush=True)
print('CPU checks only; no speaker identification, full-scene tracking or RTX benchmark.',flush=True)
