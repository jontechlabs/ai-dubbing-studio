"""Keep the known ASR failure visible; test whether it reproduces outside a series."""
from pathlib import Path
import hashlib,json,re,subprocess,sys,unicodedata
ROOT=Path(__file__).resolve().parents[1]
proof_path=ROOT/'artifacts/audio8-cold-validation.json';proof=json.loads(proof_path.read_text())
folder=ROOT/'.cache/trials-cold';raw=folder/'cold.f32';out=folder/'cold-asr.json'
subprocess.run([str(ROOT/'src-tauri/binaries/ffmpeg.exe'),'-v','error','-i',str(ROOT/'artifacts'/proof['path']),'-ac','1','-ar','16000','-f','f32le','-y',str(raw)],check=True,timeout=30)
run=subprocess.run([sys.argv[1],'--transcribe-reference',str(ROOT/'.cache/reference-transcription/Référence 日本語/ggml-small-q5_1.bin'),str(raw),'auto',str(out)],capture_output=True,text=True,encoding='utf8',timeout=600,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
(ROOT/'artifacts/audio8-cold-asr.stderr.log').write_text(run.stderr,encoding='utf8')
assert run.returncode==0 and re.search(r'auto-detected language: fr\b',run.stderr),run.stderr[-2000:]
text=json.loads(out.read_text(encoding='utf-8-sig'))['text']
def words(s):return set(re.findall(r'[a-z]+',''.join(c for c in unicodedata.normalize('NFKD',s.lower()) if not unicodedata.combining(c))))
overlap=len(words(text)&words(proof['text']))
# A correct cold result would leave the hot-only regression concern unresolved.
assert overlap<4,('Known seed-14 problem did not reproduce cold; investigate before release',text)
proof.update(detectedLanguage='fr',asrText=text,textWordOverlap=overlap,contentMatched=False,seriesQualityIssueReproducedAlone=True)
assert hashlib.sha256((ROOT/'artifacts'/proof['path']).read_bytes()).hexdigest()==proof['sha256']
proof_path.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print('KNOWN_MODEL_QUALITY_ISSUE_REPRODUCED_IN_OLD_SINGLE_PATH:',text)
