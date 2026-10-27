"""Bounded acoustic delivery cues; no emotion/identity inference or resynthesis."""
import math


def analyze(path):
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly, correlate, find_peaks
    info = sf.info(path)
    if info.channels != 1 or not 8000 <= info.samplerate <= 192000 or not info.samplerate <= info.frames <= 20 * info.samplerate:
        raise ValueError('TTS_GUIDE_TOO_SHORT')
    audio, rate = sf.read(path, dtype='float32')
    peak = float(np.max(np.abs(audio)))
    if not np.isfinite(audio).all() or peak < .001:
        raise ValueError('TTS_REFERENCE_SILENT')
    factor = math.gcd(rate, 8000)
    audio = resample_poly(audio, 8000 // factor, rate // factor)
    frame_size, hop = 320, 160
    frames = np.lib.stride_tricks.sliding_window_view(audio, frame_size)[::hop]
    energy = np.sqrt(np.mean(frames ** 2, axis=1))
    active = energy > max(.001, float(np.max(energy)) * .06)
    if int(np.count_nonzero(active)) * hop < 2000:
        raise ValueError('TTS_REFERENCE_SILENT')
    pitch, positions = [], []
    for index in np.flatnonzero(active):
        frame = frames[index].copy(); frame -= np.mean(frame); frame *= np.hanning(frame_size)
        corr = correlate(frame, frame, mode='full', method='fft')[frame_size-1:]
        if corr[0] <= 1e-9: continue
        low, high = 13, 134
        peaks, _ = find_peaks(corr[low:high])
        if not len(peaks): continue
        lag = int(peaks[np.argmax(corr[low:high][peaks])]) + low
        if corr[lag] / corr[0] >= .4:
            pitch.append(8000 / lag); positions.append(index / max(1, len(frames)-1))
    pause_fraction = float(1 - np.mean(active))
    active_energy = energy[active]
    dynamic_db = float(20 * np.log10(max(1e-8, np.percentile(active_energy, 90)) / max(1e-8, np.percentile(active_energy, 10))))
    cues = ['clear pauses between speech groups' if pause_fraction > .2 else 'connected, continuous delivery']
    result = dict(durationMs=round(len(audio)/8), activeAudioFraction=round(1-pause_fraction, 3), dynamicRangeDb=round(dynamic_db, 2), pitchConfidence=round(len(pitch)/max(1, int(np.count_nonzero(active))), 3))
    if len(pitch) >= 8:
        values, times = np.asarray(pitch), np.asarray(positions)
        spread = float(12 * np.log2(np.percentile(values, 90)/np.percentile(values, 10)))
        result['pitchRangeSemitones'] = round(spread, 2)
        cues.append('varied melodic intonation' if spread >= 4 else 'small, restrained pitch changes')
        first, last = values[times < .4], values[times > .6]
        if len(first) >= 3 and len(last) >= 3:
            delta = float(12*np.log2(np.median(last)/np.median(first)))
            result['endPitchChangeSemitones'] = round(delta, 2)
            if abs(delta) >= 1.5: cues.append('a rising ending' if delta > 0 else 'a falling ending')
    if dynamic_db > 10: cues.append('noticeable contrasts of intensity')
    result['direction'] = 'Use ' + ', '.join(cues) + '.'
    return result
