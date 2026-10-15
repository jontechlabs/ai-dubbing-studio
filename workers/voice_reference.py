"""Validate voice references and adapt legacy diarization WAVs without changing them."""
from contextlib import contextmanager
from math import gcd
from pathlib import Path
import tempfile


@contextmanager
def prepare_reference(path, report=lambda **values: None, destination=None):
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    try:
        info = sf.info(path)
        # Check before reading: references must stay small even if a wrong file is chosen.
        if not 8000 <= info.samplerate <= 192000 or not 1 <= info.channels <= 8:
            raise ValueError('INVALID_REFERENCE_AUDIO')
        if info.frames < info.samplerate or info.frames > 20 * info.samplerate:
            raise ValueError('INVALID_REFERENCE_AUDIO')
        audio, rate = sf.read(path, dtype='float32', always_2d=True)
    except (RuntimeError, OSError) as error:
        raise ValueError('INVALID_REFERENCE_AUDIO') from error
    audio = audio.mean(axis=1)
    if not np.isfinite(audio).all() or float(np.max(np.abs(audio))) < 0.001:
        raise ValueError('TTS_REFERENCE_SILENT')
    if rate == 24000 and info.channels == 1 and info.subtype == 'PCM_16':
        yield Path(path)
        return
    report(stage='ttsReference', progress=None,
           log=f'Reference conversion: {rate} Hz / {info.channels} channels -> 24000 Hz mono PCM16')
    factor = gcd(rate, 24000)
    if rate != 24000:
        audio = resample_poly(audio, 24000 // factor, rate // factor)
    if destination is not None:
        adapted = Path(destination)
        try:
            sf.write(adapted, audio, 24000, subtype='PCM_16')
            yield adapted
        finally:
            adapted.unlink(missing_ok=True)
        return
    with tempfile.TemporaryDirectory(prefix='dubbing-reference-') as directory:
        adapted = Path(directory) / 'reference.wav'
        sf.write(adapted, audio, 24000, subtype='PCM_16')
        yield adapted
