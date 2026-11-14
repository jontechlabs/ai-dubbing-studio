"""Conservative multi-speaker hints from the installed CAMPPlus + Silero runtime.
Not an overlap detector: short or perfectly overlapping voices can be missed.
Only small speech windows/embeddings remain in memory. Never modifies audio.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import wave

_worker_dir = str(Path(__file__).resolve().parent)
if _worker_dir.startswith('\\\\?\\'):
    _worker_dir = '\\\\' + _worker_dir[8:] if _worker_dir.startswith('\\\\?\\UNC\\') else _worker_dir[4:]
sys.path.insert(0, _worker_dir)


def supported_clusters(vectors, threshold=.65):
    """Require at least two independent windows per dissimilar cluster."""
    groups = []
    for vector in vectors:
        scores = [float(vector @ group['center']) for group in groups]
        best = max(range(len(scores)), key=scores.__getitem__) if scores else None
        if best is not None and scores[best] >= threshold:
            group = groups[best]
            group['sum'] += vector
            group['count'] += 1
            group['center'] = group['sum'] / max(float((group['sum'] @ group['sum']) ** .5), 1e-8)
        else:
            groups.append(dict(sum=vector.copy(), center=vector.copy(), count=1))
    return max(1, min(8, sum(group['count'] >= 2 for group in groups))) if vectors else None


def main(args):
    import numpy as np
    import sherpa_onnx
    from speaker_worker import speech_samples
    root = Path(args.runtime)
    manifest = json.loads(Path(__file__).with_name('speaker-model.json').read_text(encoding='utf8'))
    for entry in manifest['files']:
        if entry['kind'] == 'model':
            with (root/entry['name']).open('rb') as file:
                if hashlib.file_digest(file, 'sha256').hexdigest() != entry['sha256']:
                    raise ValueError('MODEL_CHECKSUM_FAILED')
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(root/'speaker.onnx'), num_threads=2, provider='cpu'))
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(root/'vad.onnx')
    config.silero_vad.min_silence_duration = .25
    config.silero_vad.min_speech_duration = .25
    config.sample_rate = 16000
    config.num_threads = 2
    vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=5)
    request = json.loads(Path(args.input).read_text(encoding='utf-8-sig'))

    def count(path, start_ms, end_ms):
        vectors = []
        with wave.open(str(path), 'rb') as audio:
            if audio.getsampwidth() != 2 or audio.getnchannels() != 1:
                raise ValueError('INVALID_REFERENCE_AUDIO')
            rate = audio.getframerate()
            start = min(audio.getnframes(), max(0, round(start_ms*rate/1000)))
            end = min(audio.getnframes(), round(end_ms*rate/1000)) if end_ms is not None else audio.getnframes()
            # Disjoint 1.5 s speech windows, spread across at most 120 s.
            for position in range(start, min(end, start+120*rate), round(1.5*rate)):
                size = min(end-position, round(1.5*rate))
                if size < rate:
                    break
                audio.setpos(position)
                samples = np.frombuffer(audio.readframes(size), dtype='<i2').astype(np.float32)/32768
                if rate != 16000:
                    samples = np.interp(np.arange(round(len(samples)*16000/rate))*rate/16000,
                                        np.arange(len(samples)), samples).astype(np.float32)
                voice = speech_samples(samples, vad, config.silero_vad.window_size, np)
                if len(voice) < 16000:
                    continue
                stream = extractor.create_stream()
                stream.accept_waveform(sample_rate=16000, waveform=voice)
                stream.input_finished()
                if extractor.is_ready(stream):
                    vector = np.asarray(extractor.compute(stream), dtype=np.float32)
                    norm = float(np.linalg.norm(vector))
                    if norm > 1e-8:
                        vectors.append(vector/norm)
        return supported_clusters(vectors)

    rows = []
    for index, entry in enumerate(request['entries']):
        row = dict(id=entry['id'], sourceVoices=None, dubbingVoices=None)
        if request.get('source') and request['mode'] in ('source', 'both'):
            row['sourceVoices'] = count(request['source'], entry['startMs'], entry['endMs'])
        if entry.get('dubbing') and request['mode'] in ('dubbing', 'both'):
            row['dubbingVoices'] = count(entry['dubbing'], 0, None)
        rows.append(row)
        print(json.dumps(dict(stage='auditVoices', progress=(index+1)/max(1, len(request['entries'])))), flush=True)
    Path(args.output).write_text(json.dumps(rows), encoding='utf8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('runtime', 'input', 'output'):
        parser.add_argument('--'+name, required=True)
    try:
        main(parser.parse_args())
    except Exception as error:
        print(json.dumps(dict(error=str(error))), flush=True)
        raise

