"""Review-only speaker candidates using pinned CAMPPlus/Silero on CPU."""
import argparse
import hashlib
import json
import sys
import wave
from pathlib import Path
sys.dont_write_bytecode = True
_worker_dir = str(Path(__file__).resolve().parent)
if _worker_dir.startswith('\\\\?\\'):
    _worker_dir = '\\\\' + _worker_dir[8:] if _worker_dir.startswith('\\\\?\\UNC\\') else _worker_dir[4:]
sys.path.insert(0, _worker_dir)


def rank_candidates(query, entries, threshold=.75, margin=.05):
    import numpy as np
    from speaker_worker import normalized
    query = normalized(query, np)
    rows = []
    for character_id, vectors in entries:
        scores = [float(query @ normalized(v, np)) for v in vectors]
        if scores:
            rows.append(dict(characterId=character_id, score=round(max(-1., min(1., max(scores))), 4)))
    rows.sort(key=lambda r: (-r['score'], r['characterId']))
    clear = bool(rows and rows[0]['score'] >= threshold and (len(rows) == 1 or rows[0]['score'] - rows[1]['score'] >= margin))
    return dict(candidates=rows[:3], reason='matched' if clear else 'uncertain', reliable=clear)


def analyze(request):
    import numpy as np
    import sherpa_onnx
    from speaker_worker import speech_samples, normalized, report
    root, cache = Path(request['runtime']), Path(request['cache'])
    manifest = json.loads(Path(__file__).with_name('speaker-model.json').read_text(encoding='utf8'))
    for file in manifest['files']:
        if file['kind'] != 'model': continue
        with (root/file['name']).open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != file['sha256']:
                raise ValueError('MODEL_CHECKSUM_FAILED')
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(root/'speaker.onnx'), num_threads=2, provider='cpu'))
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(root/'vad.onnx')
    config.silero_vad.min_silence_duration = .25
    config.silero_vad.min_speech_duration = .25
    config.sample_rate = 16000
    config.num_threads = 2
    vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=20)
    def embedding(path):
        with wave.open(str(path), 'rb') as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000) or wav.getnframes() > 20*16000:
                raise ValueError('INVALID_REFERENCE_AUDIO')
            audio = np.frombuffer(wav.readframes(20*16000), dtype='<i2').astype('float32') / 32768
        voice = speech_samples(audio, vad, config.silero_vad.window_size, np)
        if len(voice) < 16000: return None
        stream = extractor.create_stream(); stream.accept_waveform(sample_rate=16000, waveform=voice); stream.input_finished()
        return normalized(extractor.compute(stream), np) if extractor.is_ready(stream) else None
    query = embedding(request['input'])
    if query is None:
        result = dict(candidates=[], reason='tooShortOrNoSpeech', reliable=False)
    else:
        entries = []
        cache.mkdir(parents=True, exist_ok=True)
        for i, entry in enumerate(request['characters']):
            vectors = []
            for reference in entry['references']:
                key = reference['sha256']
                if len(key) != 64 or any(c not in '0123456789abcdef' for c in key): raise ValueError('INVALID_REFERENCE_AUDIO')
                # Content plus the pinned model fingerprint prevents stale embeddings.
                model_hash = next(f['sha256'] for f in manifest['files'] if f['name'] == 'speaker.onnx')
                saved = cache/(key+'-'+model_hash[:16]+'.npy')
                vector = None
                if saved.is_file() and saved.stat().st_size <= 16384:
                    try:
                        loaded = np.load(saved, allow_pickle=False)
                        if loaded.shape == query.shape and np.isfinite(loaded).all(): vector = normalized(loaded, np)
                    except (OSError, ValueError): pass
                if vector is None:
                    vector = embedding(reference['path'])
                    if vector is not None:
                        temporary = saved.with_suffix('.part')
                        with temporary.open('wb') as stream: np.save(stream, vector, allow_pickle=False)
                        temporary.replace(saved)
                if vector is not None: vectors.append(vector)
            entries.append((entry['characterId'], vectors))
            report(stage='characterMatch', progress=(i+1)/max(1,len(request['characters'])))
        result = rank_candidates(query, entries)
    Path(request['output']).write_text(json.dumps(result), encoding='utf8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--request', required=True)
    try:
        analyze(json.loads(Path(parser.parse_args().request).read_text(encoding='utf-8-sig')))
    except Exception as error:
        print(json.dumps(dict(error=str(error))), flush=True); sys.exit(1)
