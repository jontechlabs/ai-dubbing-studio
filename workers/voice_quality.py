"""Bounded request controls shared with the desktop and native project validator."""
import json
import math
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name('voice-quality.json').read_text(encoding='utf-8'))['variants']


def quality_options(request):
    variant = request.get('variantId') or 'cosy3-official'
    supplied = request.get('quality')
    if supplied is None:
        supplied = {}
    spec = CATALOG.get(variant)
    if not spec or not isinstance(supplied, dict):
        raise ValueError('INVALID_TTS_QUALITY')
    params = spec['parameters']
    for key, value in supplied.items():
        bounds = params.get(key)
        if not bounds or isinstance(value, bool) or not isinstance(value, (int, float)) or not bounds['min'] <= value <= bounds['max'] or not math.isfinite(value) or (bounds['step'] == 1 and value != int(value)):
            raise ValueError('INVALID_TTS_QUALITY')
    return {key: supplied.get(key, bounds['default']) for key, bounds in params.items()}
