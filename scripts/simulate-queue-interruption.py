"""Fault injection for the isolated packaged-desktop qualification fixture only."""
import json
import sys
from pathlib import Path

path = Path(sys.argv[1]).resolve()
assert path.name == 'task-queue.json' and 'volume-leveling-native' in path.parts
data = json.loads(path.read_text(encoding='utf-8'))
assert len(data['entries']) == 2 and data['entries'][0]['spec']['name'] == 'Fixture separation'
data['paused'] = False
data['entries'][0]['status'] = 'running'
data['entries'][0]['rows'][0]['status'] = 'running'
path.write_text(json.dumps(data, ensure_ascii=False) + '\n', encoding='utf-8')
