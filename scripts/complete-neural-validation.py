"""Complete neural checks using an authenticated, already tested Windows build.

Only test/workflow/documentation changes are permitted. Every application,
worker, manifest, dependency and embedded guide must match the build commit.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPO = os.environ['GITHUB_REPOSITORY']
TOKEN = os.environ['GH_TOKEN']
BASE_RUN = int(os.environ['BASE_RUN_ID'])
HEAD = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
NEURAL = 'Actual VoxCPM2 and Chatterbox V3 French generation from Japanese reference'
ALLOWED = {'.github/workflows/windows.yml', 'scripts/complete-neural-validation.py',
           'scripts/test-multilingual.py', 'scripts/test-multilingual.ps1',
           'scripts/test-voice-conversion.py', 'docs/VOICE-QUALITY.md'}


def api(path):
    req = urllib.request.Request('https://api.github.com/repos/' + REPO + path,
        headers={'Authorization': 'Bearer ' + TOKEN, 'User-Agent': 'Studio-validation'})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


run = api(f'/actions/runs/{BASE_RUN}')
assert run['repository']['full_name'] == REPO and run['path'] == '.github/workflows/windows.yml'
assert run['status'] == 'completed' and run['conclusion'] == 'failure'
base = run['head_sha']
subprocess.run(['git', 'merge-base', '--is-ancestor', base, HEAD], cwd=ROOT, check=True)
changed = set(subprocess.check_output(['git', 'diff', '--name-only', base, HEAD], cwd=ROOT, text=True).splitlines())
assert changed and changed <= ALLOWED, f'Application changes require a fresh complete build: {sorted(changed - ALLOWED)}'
jobs = api(f'/actions/runs/{BASE_RUN}/jobs')['jobs']
assert len(jobs) == 1 and jobs[0]['name'] == 'windows'
job = jobs[0]
steps = job['steps']
assert [s['name'] for s in steps if s['conclusion'] == 'failure'] == [NEURAL]
boundary = next(i for i, step in enumerate(steps) if step['name'] == NEURAL)
assert all(step['status'] == 'completed' and step['conclusion'] == 'success' for step in steps[:boundary])
assert any(s['name'] == 'Packaged desktop controlled through the official MCP SDK' for s in steps[:boundary])
artifacts = api(f'/actions/runs/{BASE_RUN}/artifacts')['artifacts']
artifact = next(a for a in artifacts if a['name'] == 'failure-diagnostics' and not a['expired'])
assert artifact.get('digest', '').startswith('sha256:')
names = {'AI-Dubbing-Studio-0.27.0-Setup.exe', 'AI-Dubbing-Studio-0.27.0-Setup.exe.sig',
         'AI-Dubbing-Studio-Windows-Portable.zip', 'SHA256SUMS.txt',
         'cosyvoice-tail-validation.txt', 'latentsync-core-validation.txt',
         'drama-core-validation.txt', 'reference-transcription-validation.json',
         'translation-model-validation.txt', 'face-detection-validation.txt',
         'mcp-native-validation.json'}
output = ROOT / 'artifacts'
output.mkdir(exist_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


req = urllib.request.Request(artifact['archive_download_url'], headers={
    'Authorization': 'Bearer ' + TOKEN, 'User-Agent': 'Studio-validation'})
try:
    urllib.request.build_opener(NoRedirect).open(req, timeout=60)
    raise AssertionError('Expected artifact redirect')
except urllib.error.HTTPError as error:
    assert error.code == 302
    location = error.headers['Location']
with tempfile.TemporaryFile() as archive_file:
    digest = hashlib.sha256()
    received = 0
    with urllib.request.urlopen(location, timeout=180) as response:
        while data := response.read(1024 * 1024):
            archive_file.write(data)
            digest.update(data)
            received += len(data)
    assert received == artifact['size_in_bytes']
    assert artifact['digest'] == 'sha256:' + digest.hexdigest()
    archive_file.seek(0)
    with zipfile.ZipFile(archive_file) as archive:
        for name in names:
            matches = [entry for entry in archive.infolist()
                       if entry.filename in (name, 'artifacts/' + name)]
            assert len(matches) == 1, name
            with archive.open(matches[0]) as src, (output / name).open('wb') as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
build_names = names & {'AI-Dubbing-Studio-0.27.0-Setup.exe',
                      'AI-Dubbing-Studio-0.27.0-Setup.exe.sig',
                      'AI-Dubbing-Studio-Windows-Portable.zip'}
seen = set()
for line in (output / 'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines():
    digest, name = line.split('  ', 1)
    assert name in build_names and sha(output / name) == digest
    seen.add(name)
assert seen == build_names

# Use the executable and tools from this same verified portable package.
directory = ROOT / '.cache/recovered-desktop'
directory.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output / 'AI-Dubbing-Studio-Windows-Portable.zip') as archive:
    for entry in archive.infolist():
        path = PurePosixPath(entry.filename)
        assert path.parts[0] == 'AI-Dubbing-Studio-Windows'
        assert not path.is_absolute() and '..' not in path.parts and '\\' not in entry.filename
        assert (entry.external_attr >> 16) & 0o170000 != 0o120000
        destination = directory.joinpath(*path.parts[1:])
        assert destination.resolve().is_relative_to(directory.resolve())
        if entry.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as src, destination.open('wb') as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
release = ROOT / 'src-tauri/target/release'
release.mkdir(parents=True, exist_ok=True)
shutil.copyfile(directory / 'AI Dubbing Studio.exe', release / 'ai-dubbing-studio.exe')
for dll in directory.glob('*.dll'):
    shutil.copyfile(dll, release / dll.name)
shutil.copytree(directory / 'workers', release / 'workers', dirs_exist_ok=True)
shutil.copytree(directory / 'binaries', ROOT / 'src-tauri/binaries', dirs_exist_ok=True)
proof = dict(baseRunId=BASE_RUN, baseJobId=job['id'], binaryCodeHead=base,
             validationHead=HEAD, productTreeUnchanged=True,
             changedFiles=sorted(changed), baseSuccessfulSteps=[s['name'] for s in steps[:boundary]],
             artifactId=artifact['id'], artifactDigest=artifact['digest'],
             buildHashes={name: sha(output / name) for name in sorted(build_names)})
# A completed multilingual check can be reused independently of a later VC
# fixture failure, under the same strict application-source identity rule.
multilingual_run = os.environ.get('MULTILINGUAL_RUN_ID', '').strip()
if multilingual_run:
    prior = api(f'/actions/runs/{int(multilingual_run)}')
    assert prior['status'] == 'completed' and prior['conclusion'] == 'failure'
    assert prior['repository']['full_name'] == REPO
    subprocess.run(['git', 'merge-base', '--is-ancestor', prior['head_sha'], HEAD], cwd=ROOT, check=True)
    prior_changes = set(subprocess.check_output(['git', 'diff', '--name-only', base, prior['head_sha']], cwd=ROOT, text=True).splitlines())
    assert prior_changes <= ALLOWED
    previous_jobs = api(f'/actions/runs/{int(multilingual_run)}/jobs')['jobs']
    previous_job = next(j for j in previous_jobs if j['name'] == 'windows-neural-completion')
    assert [x['name'] for x in previous_job['steps'] if x['conclusion'] == 'failure'] == [NEURAL]
    previous_artifact = next(a for a in api(f'/actions/runs/{int(multilingual_run)}/artifacts')['artifacts'] if a['name'] == 'failure-diagnostics' and not a['expired'])
    req = urllib.request.Request(previous_artifact['archive_download_url'], headers={'Authorization': 'Bearer ' + TOKEN, 'User-Agent': 'Studio-validation'})
    try:
        urllib.request.build_opener(NoRedirect).open(req, timeout=60)
        raise AssertionError('Expected artifact redirect')
    except urllib.error.HTTPError as error:
        assert error.code == 302
        location = error.headers['Location']
    with tempfile.TemporaryFile() as previous_file:
        digest = hashlib.sha256()
        received = 0
        with urllib.request.urlopen(location, timeout=180) as response:
            while data := response.read(1024 * 1024):
                previous_file.write(data); digest.update(data); received += len(data)
        assert received == previous_artifact['size_in_bytes']
        assert previous_artifact['digest'] == 'sha256:' + digest.hexdigest()
        previous_file.seek(0)
        with zipfile.ZipFile(previous_file) as archive:
            previous_proof = json.loads(archive.read('artifacts/recovery-validation.json'))
            assert previous_proof['binaryCodeHead'] == base and previous_proof['validationHead'] == prior['head_sha']
            assert previous_proof['buildHashes'] == proof['buildHashes']
            content = archive.read('artifacts/multilingual-inference-validation.json')
            multilingual = json.loads(content)
            assert multilingual['device'] == 'CPU' and multilingual['packagedWorkers'] and multilingual['embeddedPython']
            assert {e['id'] for e in multilingual['engines']} == {'voxcpm2-bf16', 'chatterbox-multilingual-v3'}
            assert all(e['standardQuality'] and e['standardTextWordOverlap'] >= 4 and e['customLanguage'] == 'fr' and e['hotQualityReset'] for e in multilingual['engines'])
            (output / 'multilingual-inference-validation.json').write_bytes(content)
            standard = archive.read('.cache/multilingual-validation/chatterbox-multilingual-v3-standalone.wav')
            assert standard[:4] == b'RIFF' and len(standard) > 44
            standard_path = ROOT / '.cache/multilingual-validation/chatterbox-multilingual-v3-standalone.wav'
            standard_path.parent.mkdir(parents=True, exist_ok=True)
            standard_path.write_bytes(standard)
    proof['multilingualValidation'] = dict(runId=int(multilingual_run), validationHead=prior['head_sha'], artifactId=previous_artifact['id'], artifactDigest=previous_artifact['digest'], proofSha256=hashlib.sha256(content).hexdigest(), standardSourceWavSha256=hashlib.sha256(standard).hexdigest())
    print('Authenticated complete multilingual validation and its ASR-verified Standard source for the VC test.')
(output / 'recovery-validation.json').write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
print('Verified original build provenance, exact application source identity and all pre-neural checks.')
print('Reused build commit:', base, 'Validation commit:', HEAD)
