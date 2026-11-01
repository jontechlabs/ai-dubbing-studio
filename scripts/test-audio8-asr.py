"""Independent automatic-language/content check of actual packaged Audio8 takes."""
from pathlib import Path
import json
import re
import subprocess
import unicodedata

ROOT=Path(__file__).resolve().parents[1]
proof_path=ROOT/'artifacts/audio8-inference-validation.json'
proof=json.loads(proof_path.read_text(encoding='utf8'))
work=ROOT/'.cache/audio8-asr'
work.mkdir(exist_ok=True)
def words(s):
    s=unicodedata.normalize('NFKD',s.lower())
    return set(re.findall(r'[a-z]+',''.join(c for c in s if not unicodedata.combining(c))))
for i,sample in enumerate(proof['samples']):
    audio=ROOT/'artifacts'/sample['path']
    raw=work/f'{i}.f32'
    output=work/f'{i}.json'
    subprocess.run([str(ROOT/'src-tauri/binaries/ffmpeg.exe'),'-v','error','-i',str(audio),'-ac','1','-ar','16000','-f','f32le','-y',str(raw)],check=True,timeout=30)
    run=subprocess.run([str(ROOT/'src-tauri/target/release/ai-dubbing-studio.exe'),'--transcribe-reference',str(ROOT/'.cache/reference-transcription/Référence 日本語/ggml-small-q5_1.bin'),str(raw),'auto',str(output)],text=True,encoding='utf8',capture_output=True,timeout=600,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    (work/f'{i}.stderr.log').write_text(run.stderr,encoding='utf8')
    assert run.returncode==0,run.stderr[-3000:]
    text=json.loads(output.read_text(encoding='utf-8-sig'))['text']
    assert re.search(r'auto-detected language: fr\b',run.stderr),run.stderr[-2000:]
    overlap=len(words(text)&words(sample['text']))
    assert overlap>=min(4,len(words(sample['text']))),text
    sample.update(detectedLanguage='fr',asrText=text,textWordOverlap=overlap)
    print('AUDIO8_ASR',i,text,flush=True)
proof['automaticFrenchLanguageAndContent']=True
proof_path.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
