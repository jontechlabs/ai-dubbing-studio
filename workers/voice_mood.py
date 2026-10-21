"""Shared acting directions; these are prompts, not guaranteed model classes."""
import json
from pathlib import Path

MOODS = json.loads(Path(__file__).with_name('voice-moods.json').read_text(encoding='utf-8'))['moods']

def mood_spec(request):
    mood = request.get('mood')
    mood = 'default' if mood is None else mood
    if not isinstance(mood, str) or mood not in MOODS or (
        mood != 'default' and str(request.get('variantId', '')).startswith('qwen3')
    ):
        raise ValueError('TTS_STYLE_UNSUPPORTED')
    return MOODS[mood]
