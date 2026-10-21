"""Finite accent requests, shared with the desktop catalogue; not an accent classifier."""
import json
from pathlib import Path

def accent_spec(request):
    accent = request.get('accent') or 'auto'
    if accent == 'auto':
        return None
    specs = json.loads(Path(__file__).with_name('voice-accents.json').read_text(encoding='utf-8'))['accents']
    spec = next((item for item in specs if item['id'] == accent), None)
    if spec is None or spec['language'] != request.get('language') or request.get('variantId', '').startswith(('qwen3', 'chatterbox')):
        raise ValueError('TTS_ACCENT_UNSUPPORTED')
    return spec
