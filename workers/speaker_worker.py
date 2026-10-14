"""Local voice grouping of existing subtitle intervals with 3D-Speaker/Silero.

No inference code is reimplemented: sherpa-onnx runs the upstream ONNX models.
Audio reads are bounded to 15 seconds; only small embeddings stay in memory.
"""
import argparse
import hashlib
import json
import sys
import wave
from pathlib import Path
sys.dont_write_bytecode = True


def report(**values):
    print(json.dumps(values), flush=True)


def normalized(vector, np):
    value = np.asarray(vector, dtype=np.float32)
    norm = np.linalg.norm(value)
    if not np.isfinite(value).all() or norm < 1e-8:
        raise ValueError('SPEAKER_ANALYSIS_FAILED')
    return value / norm


def group_embeddings(embeddings, threshold=0.75, limit=32):
    import numpy as np
    centers, counts = [], []
    for vector in embeddings:
        scores = [float(vector @ center) for center in centers]
        best = int(np.argmax(scores)) if scores else -1
        if best >= 0 and scores[best] >= threshold:
            centers[best] = normalized(centers[best] * counts[best] + vector, np)
            counts[best] += 1
        elif len(centers) < limit:
            centers.append(vector.copy()); counts.append(1)
    assignments = []
    for vector in embeddings:
        scores = np.asarray([float(vector @ center) for center in centers])
        order = np.argsort(scores)[::-1]
        best = int(order[0])
        similarity = float(scores[best])
        ambiguous = len(order) > 1 and similarity - scores[order[1]] < 0.05
        assignments.append((None if ambiguous or similarity < threshold else best, similarity))
    return centers, assignments


def speech_samples(samples, vad, window, np):
    vad.reset()
    voiced = []
    # Include the last incomplete window, padded only for VAD inference.
    for start in range(0, len(samples), window):
        part = samples[start:start+window]
        vad.accept_waveform(np.pad(part, (0, window-len(part))))
        while not vad.empty():
            voiced.extend(vad.front.samples); vad.pop()
    vad.flush()
    while not vad.empty():
        voiced.extend(vad.front.samples); vad.pop()
    return np.asarray(voiced[:len(samples)], dtype=np.float32)


def analyze(args):
    import numpy as np
    import sherpa_onnx
    root = Path(args.runtime)
    manifest = json.loads(Path(__file__).with_name('speaker-model.json').read_text())
    for file in manifest['files']:
        if file['kind'] != 'model': continue
        with (root/file['name']).open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != file['sha256']:
                raise ValueError('MODEL_CHECKSUM_FAILED')
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(root/'speaker.onnx'), num_threads=2, provider='cpu'))
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(root/'vad.onnx')
    config.silero_vad.min_silence_duration = 0.25
    config.silero_vad.min_speech_duration = 0.25
    config.sample_rate = 16000
    config.num_threads = 2
    vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=20)
    lines = json.loads(Path(args.lines).read_text(encoding='utf-8'))
    embeddings, indices, voices = [], [], []
    assignments = [{'dialogueId':line['id'], 'speaker':None, 'similarity':None, 'reason':'noSpeech'} for line in lines]
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    with wave.open(args.input, 'rb') as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 16000):
            raise ValueError('INVALID_REFERENCE_AUDIO')
        for index, line in enumerate(lines):
            start = min(source.getnframes(), round(line['startMs']*16))
            count = min(15*16000, round((line['endMs']-line['startMs'])*16), source.getnframes()-start)
            source.setpos(start)
            samples = np.frombuffer(source.readframes(max(0, count)), dtype='<i2').astype(np.float32)/32768
            voice = speech_samples(samples, vad, config.silero_vad.window_size, np)
            if len(voice) >= 16000:
                stream = extractor.create_stream()
                stream.accept_waveform(sample_rate=16000, waveform=voice)
                stream.input_finished()
                if extractor.is_ready(stream):
                    embeddings.append(normalized(extractor.compute(stream), np))
                    indices.append(index)
                    # Save a candidate reference to disk, avoiding film-sized RAM.
                    with wave.open(str(output/f'line-{index}.wav'), 'wb') as reference:
                        reference.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                        reference.writeframes((np.clip(voice, -1, 1)*32767).astype('<i2').tobytes())
                    voices.append(len(voice)//16)
            elif len(voice):
                assignments[index]['reason'] = 'tooShort'
            report(stage='speakerEmbeddings', progress=(index+1)/max(1,len(lines))*0.9)
    if not embeddings:
        raise ValueError('NO_SPEECH_FOUND')
    report(stage='speakerClustering', progress=0.9)
    centers, grouped = group_embeddings(embeddings, args.threshold)
    best = {}
    for offset, (speaker, score) in enumerate(grouped):
        index = indices[offset]
        assignments[index].update(speaker=speaker, similarity=round(score,4), reason='identified' if speaker is not None else 'uncertain')
        if speaker is not None and (speaker not in best or voices[offset] > best[speaker][1]):
            best[speaker] = (index, voices[offset])
    clusters = []
    for speaker, (index, duration) in best.items():
        name = f'reference-{speaker}.wav'
        (output/f'line-{index}.wav').replace(output/name)
        clusters.append({'speaker':speaker, 'referenceFile':name, 'durationMs':duration, 'referenceDialogueId':lines[index]['id']})
    for file in output.glob('line-*.wav'): file.unlink()
    result = {'lines':lines, 'assignments':assignments, 'clusters':clusters}
    (output/'result.json').write_text(json.dumps(result), encoding='utf-8')
    report(stage='speakerClustering', progress=1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--info', action='store_true')
    parser.add_argument('--runtime'); parser.add_argument('--input'); parser.add_argument('--lines'); parser.add_argument('--output')
    parser.add_argument('--threshold', type=float, default=0.75)
    args = parser.parse_args()
    try:
        if args.info:
            import sherpa_onnx, numpy
            report(runtimeReady=True, version=sherpa_onnx.__version__)
        else: analyze(args)
    except Exception as error:
        report(error=str(error)); sys.exit(1)
