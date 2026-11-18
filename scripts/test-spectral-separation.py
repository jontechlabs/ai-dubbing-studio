"""Real pinned weights + five public voices; CPU qualification, optional CUDA.

Default: prepare a CPU-only fixture runtime, never a production CUDA install.
--run uses the current interpreter (and optionally --dependency-dir).
All signal files stay in this diagnostic's dedicated workspace.
"""
from pathlib import Path
import argparse
import gc
import hashlib
import itertools
import json
import os
import subprocess
import sys
import time
import urllib.request
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch(spec, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and target.stat().st_size == spec['size'] and digest(target) == spec['sha256']:
        return target
    partial = target.with_name(target.name + '.part')
    for attempt in range(3):
        try:
            request = urllib.request.Request(spec['url'], headers={'User-Agent': 'AI-Dubbing-Studio-spectral-validation'})
            with urllib.request.urlopen(request, timeout=90) as response, partial.open('wb') as output:
                while block := response.read(8 * 1024 ** 2):
                    output.write(block)
            assert partial.stat().st_size == spec['size'] and digest(partial) == spec['sha256'], target.name
            partial.replace(target)
            return target
        except Exception:
            if attempt == 2: raise
            time.sleep(2)


def unpack(source, target):
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as archive:
        assert all((target / n).resolve().is_relative_to(target.resolve()) for n in archive.namelist())
        archive.extractall(target)


def prepare_runtime(work):
    runtime = work / 'model-store/voice-engines/speaker-separation-runtime'
    python = runtime / 'python/python.exe'
    unpack(fetch(dict(url='https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', size=11133606,
                      sha256='4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'), work / 'python.zip'), python.parent)
    (python.parent / 'python312._pth').write_text('python312.zip\n.\nLib/site-packages\nimport site\n', encoding='utf8')
    needed = ['mpmath-', 'sympy-', 'networkx-', 'jinja2-', 'markupsafe-', 'typing_extensions-', 'filelock-', 'fsspec-',
              'numpy-', 'scipy-', 'soundfile-', 'cffi-', 'pycparser-', 'pyyaml-', 'einops-', 'rotary_embedding_torch-', 'beartype-', 'packaging-']
    rows = json.loads((ROOT / 'workers/speaker-separation-runtime.json').read_text())['files']
    rows = [r for r in rows if any(r['name'].startswith(n) for n in needed)]
    assert len(rows) == len(needed)
    rows.append(json.loads((ROOT / 'scripts/spectral-cpu-runtime.json').read_text())['torch'])
    for row in rows:
        print('CPU test dependency:', row['name'], flush=True)
        unpack(fetch(row, work / 'wheels' / row['name']), python.parent / 'Lib/site-packages')
    # Deliberately labelled test fixture. The application still ships its
    # unchanged CUDA 12.8 production runtime manifest for the user's GPU.
    (runtime / 'ready.json').write_text('{"profile":"cpu-neural-test-fixture"}', encoding='utf8')
    (runtime / 'devices.json').write_text('{"devices":[{"id":"cpu","name":"CPU"}]}', encoding='utf8')
    return python


def peak_rss():
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [(n, ctypes.c_size_t) for n in
                ['PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage',
                 'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage']]
        data = Counters(); data.cb = ctypes.sizeof(data)
        kernel = ctypes.WinDLL('kernel32'); kernel.GetCurrentProcess.restype = wintypes.HANDLE
        query = ctypes.WinDLL('psapi').GetProcessMemoryInfo
        query.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        query.restype = wintypes.BOOL
        assert query(kernel.GetCurrentProcess(), ctypes.byref(data), data.cb)
        return data.PeakWorkingSetSize
    import resource
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024


def run(args, work):
    sys.path.insert(0, str(ROOT / 'workers'))
    if args.dependency_dir: sys.path.insert(0, str(Path(args.dependency_dir).resolve()))
    import numpy as np
    import soundfile as sf
    import torch
    import speaker_separation_worker as worker
    assert torch.__version__.split('+')[0] == '2.8.0'
    specs = json.loads((ROOT / 'workers/speaker-separation-models.json').read_text())['models']
    specs = [s for s in specs if s['family'] in ('tfgridnet', 'srcorrnet')]
    audio_specs = json.loads((ROOT / 'scripts/spectral-separation-smoke-audio.json').read_text())['files']
    frames = 120013
    references = []
    for row in audio_specs:
        wave, rate = sf.read(fetch(row, work / 'audio' / row['name']), dtype='float32', always_2d=True)
        wave = worker.resample_exact(wave.mean(axis=1), rate, 48000, frames)
        wave *= .045 / max(float(np.sqrt(np.mean(wave ** 2))), 1e-8)
        references.append(wave)
    references = np.stack(references)
    proof = []
    mixtures = {}
    run_id = str(time.time_ns())
    for spec in specs:
        folder = work / 'model-store/voice-engines/speaker-separation' / spec['id']
        for row in spec['files']: fetch(row, folder / row['name'])
        for count in spec['speakerCounts']:
            key = spec['id'] + '-' + str(count)
            source = work / 'mixtures' / ('voices-' + str(count) + '.wav')
            source.parent.mkdir(exist_ok=True)
            if count not in mixtures:
                mixture = references[:count].sum(axis=0)
                sf.write(source, mixture, 48000, subtype='PCM_16'); mixtures[count] = source
            original = digest(source)
            output = work / 'results' / run_id / key
            if (output / 'result.json').is_file():
                raise RuntimeError('Use a fresh diagnostic output folder: ' + str(output))
            print('REAL_SPECTRAL_CASE', key, args.device, flush=True)
            with patch('socket.socket.connect', side_effect=AssertionError('Inference must remain offline')):
                worker.generate(dict(modelId=spec['id'], modelDir=str(folder), inputPath=str(source), outputDir=str(output),
                                     device=args.device, speakerCount=count, memoryProfile='gpu16', windowMs=2000))
            result = json.loads((output / 'result.json').read_text())
            assert result['frames'] == frames and result['speakers'] == count and result['precision'] == 'fp32'
            assert result['device'] == args.device and digest(source) == original
            assert result['windowMs'] <= 2000 and result['attempts'] >= 1 and len(result['outputs']) == count
            separated = []
            for row in result['outputs']:
                file = output / row['path']; info = sf.info(file)
                assert info.frames == frames and info.channels == 1 and info.samplerate == 48000 and info.subtype == 'PCM_16'
                assert digest(file) == row['sha256'] and file.stat().st_size == row['size']
                wave, _ = sf.read(file, dtype='float32'); assert np.isfinite(wave).all() and np.max(np.abs(wave)) <= .981
                assert np.sqrt(np.mean(wave ** 2)) > 1e-7
                separated.append(wave)
            # Report measured cross-language SI-SDR, without pretending this
            # establishes quality on shouting/anime or on a different GPU.
            def score(reference, candidate):
                reference = reference.astype('float64'); candidate = candidate.astype('float64')
                reference -= reference.mean(); candidate -= candidate.mean()
                target = reference * (np.dot(candidate, reference) / max(np.dot(reference, reference), 1e-12))
                return float(10 * np.log10(max(np.dot(target, target), 1e-12) / max(np.sum((candidate - target) ** 2), 1e-12)))
            table = [[score(r, s) for s in separated] for r in references[:count]]
            best = max(itertools.permutations(range(count)), key=lambda p: sum(table[i][j] for i, j in enumerate(p)))
            mixture, _ = sf.read(source, dtype='float32')
            improvement = sum(table[i][j] - score(references[i], mixture) for i, j in enumerate(best)) / count
            assert improvement > 0, (key, improvement)
            proof.append(dict(modelId=spec['id'], speakerCount=count, elapsedMs=result['elapsedMs'], windowMs=result['windowMs'],
                              peakVramMb=result['peakVramMb'], meanSiSdrImprovementDb=round(improvement, 3), outputsVerified=count,
                              sourceHashPreserved=True, exactFrames=True, outputHashesVerified=True, realWeights=True))
            gc.collect()
            if args.device.startswith('cuda:'): torch.cuda.empty_cache()
    videos = {}
    ffmpeg = ROOT / 'src-tauri/binaries/ffmpeg.exe'
    for count, source in mixtures.items():
        target = work / 'mixtures' / f'voices-{count}.mkv'
        if not target.exists():
            subprocess.run([str(ffmpeg), '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25',
                            '-i', str(source), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-n', str(target)], check=True, timeout=60)
        videos[str(count)] = str(target.resolve())
    source_files = ['speaker_separation_worker.py','spectral_separation.py','spectral_compat.py','speaker-separation-models.json',
                    'vendor/spectral-separation/sources.json','vendor/spectral-separation/tfgridnet-core.zip','vendor/spectral-separation/sr-corrnet-core.zip']
    hashes = {name: hashlib.sha256((ROOT/'workers'/name).read_bytes().replace(b'\r\n',b'\n') if not name.endswith('.zip') else (ROOT/'workers'/name).read_bytes()).hexdigest() for name in source_files}
    report = dict(version='0.57.0', device=args.device, torchVersion=torch.__version__, realNeuralInference=True, inputSourceSha256=hashes,
                  noRemoteInference=True, offlineSocketGuard=True, shoutingQualityQualified=False, rtx5060TiQualified=False,
                  sourceCount=len(references), cases=proof, caseCount=len(proof), peakRamBytes=peak_rss(),
                  modelStore=str((work / 'model-store').resolve()), videos=videos, mixtures={str(k): str(v.resolve()) for k, v in mixtures.items()})
    destination = Path(args.proof).resolve(); destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print('SPECTRAL_NEURAL_PROOF', json.dumps(report), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--work', required=True); parser.add_argument('--proof', required=True)
    parser.add_argument('--run', action='store_true'); parser.add_argument('--dependency-dir'); parser.add_argument('--device', default='cpu')
    args = parser.parse_args(); work = Path(args.work).resolve(); work.mkdir(parents=True, exist_ok=True)
    if args.run:
        run(args, work)
    else:
        python = prepare_runtime(work)
        subprocess.run([str(python), '-B', str(Path(__file__).resolve()), '--run', '--work', str(work), '--proof', str(Path(args.proof).resolve()), '--device', args.device],
                       env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUNBUFFERED': '1'}, check=True, timeout=1800)
