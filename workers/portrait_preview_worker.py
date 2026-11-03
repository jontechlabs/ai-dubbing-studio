"""Return every face in one preview frame; never assign an identity or save a crop."""
import argparse
import json
from pathlib import Path
import sys


def plain(value):
    value = str(value)
    return '\\\\' + value[8:] if value.startswith('\\\\?\\UNC\\') else value[4:] if value.startswith('\\\\?\\') else value


def preview(request):
    import cv2
    import numpy as np
    # Embedded Python does not automatically import sibling worker modules.
    sys.path.insert(0, plain(Path(__file__).resolve().parent))
    from face_detection_worker import Detector
    if request['profile'] not in ('auto', 'anime', 'live'):
        raise ValueError('FACE_PROFILE_INVALID')
    image = cv2.imdecode(np.fromfile(plain(request['input']), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or max(image.shape[:2]) > 640:
        raise ValueError('CHARACTER_PORTRAIT_INVALID')
    faces = Detector(plain(request['models']), request['profile']).detect(image)
    # Stable spatial labels, not character names or an acoustic identity match.
    faces = sorted(faces, key=lambda b: (round(b[1], 2), b[0]))[:32]
    result = dict(width=image.shape[1], height=image.shape[0], faces=[dict(x=x, y=y, width=w, height=h) for x, y, w, h in faces])
    Path(request['output']).write_text(json.dumps(result), encoding='utf-8')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    args = parser.parse_args()
    try:
        preview(json.loads(Path(args.request).read_text(encoding='utf-8-sig')))
    except Exception as error:
        print(json.dumps(dict(error=str(error))), flush=True)
        raise
