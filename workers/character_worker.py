"""Local visual thumbnail descriptors and acoustic pitch measurements.

Visual similarity is a review aid, not proof of speaker identity. No sex/gender
classification is performed. The register is a measured fundamental frequency.
"""
import argparse
import json
from pathlib import Path
import sys


def plain(value):
    value = str(value)
    return '\\\\' + value[8:] if value.startswith('\\\\?\\UNC\\') else value[4:] if value.startswith('\\\\?\\') else value


def vocal_register(samples, rate=16000):
    import numpy as np
    samples = np.asarray(samples, dtype=np.float64)
    if rate != 16000 or samples.ndim != 1 or len(samples) < 1600 or not np.all(np.isfinite(samples)):
        return None
    samples = samples[:rate * 15]
    frame_size, hop = 800, 800
    low, high = max(1, rate // 700), rate // 50
    pitches, confidence = [], []
    for start in range(0, len(samples) - frame_size + 1, hop):
        frame = samples[start:start+frame_size].copy()
        frame -= np.mean(frame)
        if np.sqrt(np.mean(frame * frame)) < .005:
            continue
        frame *= np.hanning(frame_size)
        spectrum = np.fft.rfft(frame, n=2048)
        correlation = np.fft.irfft(spectrum * spectrum.conj(), n=2048)[:high+2]
        if correlation[0] <= 1e-12:
            continue
        candidates = [i for i in range(low+1, high) if correlation[i] >= correlation[i-1] and correlation[i] > correlation[i+1]]
        if not candidates:
            continue
        peak = max(correlation[candidates])
        lag = next(i for i in candidates if correlation[i] >= .94 * peak)
        certainty = float(correlation[lag] / correlation[0])
        if certainty < .6:
            continue
        denominator = correlation[lag-1] - 2 * correlation[lag] + correlation[lag+1]
        refined = lag + (.5 * (correlation[lag-1] - correlation[lag+1]) / denominator if abs(denominator) > 1e-12 else 0)
        frequency = rate / refined
        if 50 <= frequency <= 700:
            pitches.append(frequency)
            confidence.append(certainty)
    if len(pitches) < 8:
        return None
    return dict(medianHz=round(float(np.median(pitches)), 2), confidence=round(float(np.median(confidence)), 4), analyzedMs=len(pitches) * 50)


def describe(image):
    import cv2
    import numpy as np
    gray = cv2.resize(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), (9, 8), interpolation=cv2.INTER_AREA)
    bits = (gray[:, 1:] > gray[:, :-1]).reshape(-1)
    difference_hash = f'{sum(int(bit) << (63-i) for i, bit in enumerate(bits)):016x}'
    colors = []
    for channel in range(3):
        hist = cv2.calcHist([image], [channel], None, [16], [0, 256]).reshape(-1)
        colors.extend((hist / max(1, image.shape[0] * image.shape[1])).astype(float).tolist())
    return dict(differenceHash=difference_hash, colors=colors)


def portraits(request):
    import cv2
    import numpy as np
    sys.path.insert(0, plain(Path(__file__).resolve().parent))
    from face_detection_worker import Detector
    detector = Detector(plain(request['models']), request.get('profile', 'auto')) if request.get('auto', True) else None
    result = []
    for item in request['items']:
        image = cv2.imdecode(np.fromfile(plain(item['input']), dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None or image.shape[0] * image.shape[1] > 4096 * 4096:
            raise ValueError('CHARACTER_PORTRAIT_INVALID')
        crop = item.get('crop') or dict(x=0, y=0, width=1, height=1)
        reason = None
        if detector:
            faces = detector.detect(image)
            if len(faces) == 1:
                x, y, w, h = faces[0]
                crop = dict(x=max(0, x-w*.1), y=max(0, y-h*.1), width=min(1-max(0,x-w*.1),w*1.2), height=min(1-max(0,y-h*.1),h*1.2))
            else:
                reason = 'multipleFaces' if faces else 'noFace'
        if any(not np.isfinite(v) for v in crop.values()) or crop['x'] < 0 or crop['y'] < 0 or crop['width'] <= 0 or crop['height'] <= 0 or crop['x'] + crop['width'] > 1.000001 or crop['y'] + crop['height'] > 1.000001:
            raise ValueError('CHARACTER_PORTRAIT_INVALID')
        h, w = image.shape[:2]
        cut = image[int(crop['y']*h):max(int(crop['y']*h)+1,int((crop['y']+crop['height'])*h)), int(crop['x']*w):max(int(crop['x']*w)+1,int((crop['x']+crop['width'])*w))]
        scale = min(256 / cut.shape[1], 256 / cut.shape[0])
        cut = cv2.resize(cut, (max(1,round(cut.shape[1]*scale)), max(1,round(cut.shape[0]*scale))), interpolation=cv2.INTER_AREA)
        canvas = np.zeros((256,256,3), dtype=np.uint8)
        top, left = (256-cut.shape[0])//2, (256-cut.shape[1])//2
        canvas[top:top+cut.shape[0], left:left+cut.shape[1]] = cut
        ok, encoded = cv2.imencode('.png', canvas)
        if not ok: raise ValueError('CHARACTER_PORTRAIT_INVALID')
        encoded.tofile(plain(item['output']))
        result.append(dict(**item['metadata'], crop=crop, confirmed=not bool(detector), **describe(canvas), reason=reason))
    Path(request['output']).write_text(json.dumps(result), encoding='utf-8')


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--request', required=True); args = p.parse_args()
    try:
        portraits(json.loads(Path(args.request).read_text(encoding='utf-8-sig')))
    except Exception as error:
        print(json.dumps(dict(error=str(error))), flush=True)
        raise
