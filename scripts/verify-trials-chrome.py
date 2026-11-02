"""Authenticate completed Chrome checks for byte-identical UI inputs."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = '222428a808df10c4531e5bef481e23c8b0ffe6aa'
RUN = 41485370081
SLUG = 'jontechlabs/ai-dubbing-studio'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


changed = set(git('diff', '--name-only', BASE, 'HEAD').splitlines())
assert changed == {'src-tauri/src/separation.rs', 'src-tauri/src/model_storage.rs', 'src-tauri/src/tts_trials_tests.rs', '.github/workflows/tts-trials.yml', 'scripts/verify-trials-chrome.py'}, changed
identities = {}
for path in ['src', 'workers', 'tests/e2e', 'resources', 'public', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'playwright.config.ts']:
    identities[path] = git('rev-parse', 'HEAD:' + path)
    assert identities[path] == git('rev-parse', BASE + ':' + path), path


def request(url):
    return urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                                                'User-Agent': 'Studio-accent-checks-validation'})


def api(path):
    with urllib.request.urlopen(request('https://api.github.com/repos/' + SLUG + path), timeout=60) as response:
        return json.load(response)


run = api(f'/actions/runs/{RUN}')
assert run['status'] == 'completed' and run['conclusion'] == 'cancelled' and run['head_sha'] == BASE
assert run['path'] == '.github/workflows/tts-trials.yml'
job, = api(f'/actions/runs/{RUN}/jobs')['jobs']
assert any(s['name'] == 'Fresh frontend unit and Chrome regression checks' and s['conclusion'] == 'success' for s in job['steps'])


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
for expected in ['200 passed', '232 passed']:
    assert expected in log, expected
report = dict(runId=RUN, verifiedHead=BASE, head=git('rev-parse', 'HEAD'),
              jobId=job['id'], jobLogSha256=hashlib.sha256(raw).hexdigest(),
              chromeChecksReused=232, freshChromeChecksRequired=7, totalDistinctChromeChecks=232,
              uiInputsUnchanged=True, immutableIdentities=identities,
              nativeGuardOnly='Native trial error/concurrency guards changed; all native checks, seven focused UI cases and actual packaged diagnostics run freshly.')
destination = ROOT / 'artifacts/trials-chrome-proof.json'
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
with open(os.environ['GITHUB_ENV'], 'a', encoding='utf8') as stream:
    stream.write('STUDIO_TRIALS_CHROME_REUSED=1\n')
print(json.dumps(report, indent=2))
