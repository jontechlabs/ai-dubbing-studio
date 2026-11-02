"""Authenticate 224 successful Chrome checks; rerun the one corrected locator."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = 'a02264769238791a2358a6f863b461db292141b3'
RUN = 41456463686
SLUG = 'jontechlabs/ai-dubbing-studio'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


changed = set(git('diff', '--name-only', BASE, 'HEAD').splitlines())
assert changed == {'scripts/verify-accent-checks.py', 'scripts/verify-accent-ui.py',
                   '.github/workflows/voice-accents.yml', 'tests/e2e/multilingual.pw.ts'}, changed
before = subprocess.check_output(['git', 'show', BASE + ':tests/e2e/multilingual.pw.ts'], cwd=ROOT)
after = (ROOT / 'tests/e2e/multilingual.pw.ts').read_bytes().replace(b'\r\n', b'\n')
assert after == before.replace(b'/la langue cible du projet/', b'/^Ce moteur utilise la r\xc3\xa9f\xc3\xa9rence audio sans transcription/')
identities = {}
for path in ['src', 'workers', 'src-tauri', 'resources', 'public', 'package.json', 'pnpm-lock.yaml']:
    identities[path] = git('rev-parse', 'HEAD:' + path)
    assert identities[path] == git('rev-parse', BASE + ':' + path), path


def request(url):
    return urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                                                'User-Agent': 'Studio-accent-checks-validation'})


def api(path):
    with urllib.request.urlopen(request('https://api.github.com/repos/' + SLUG + path), timeout=60) as response:
        return json.load(response)


run = api(f'/actions/runs/{RUN}')
assert run['status'] == 'completed' and run['conclusion'] == 'failure' and run['head_sha'] == BASE
assert run['path'] == '.github/workflows/voice-accents.yml'
job, = api(f'/actions/runs/{RUN}/jobs')['jobs']
assert [s['name'] for s in job['steps'] if s['conclusion'] == 'failure'] == ['Fresh frontend unit and Chrome regression checks']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


try:
    urllib.request.build_opener(NoRedirect).open(request(f'https://api.github.com/repos/{SLUG}/actions/jobs/{job["id"]}/logs'), timeout=60)
    raise AssertionError('Expected job log redirect')
except urllib.error.HTTPError as error:
    assert error.code == 302
    location = error.headers['Location']
# The redirected object-storage request must never receive the account token.
with urllib.request.urlopen(location, timeout=90) as response:
    raw = response.read(32 * 1024 * 1024 + 1)
assert len(raw) <= 32 * 1024 * 1024
log = re.sub(r'(?:\x1b|\^\[)\[[0-9;:]*[A-Za-z]', '', raw.decode('utf-8-sig', errors='replace'))
for expected in ['200 passed', '224 passed', '1 failed', 'resolved to 2 elements',
                 'multilingual.pw.ts:4:1', 'la langue cible du projet']:
    assert expected in log, expected
report = dict(runId=RUN, verifiedHead=BASE, head=git('rev-parse', 'HEAD'),
              jobId=job['id'], jobLogSha256=hashlib.sha256(raw).hexdigest(),
              chromeChecksReused=224, freshChromeChecksRequired=17, totalDistinctChromeChecks=225,
              applicationInputsUnchanged=True, immutableIdentities=identities,
              fixedTestOnly='One locator now targets the intended cloning help, instead of two help paragraphs.')
destination = ROOT / 'artifacts/accent-chrome-proof.json'
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
with open(os.environ['GITHUB_ENV'], 'a', encoding='utf8') as stream:
    stream.write('STUDIO_ACCENT_CHROME_REUSED=1\n')
print(json.dumps(report, indent=2))
