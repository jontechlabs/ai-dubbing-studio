"""Exercise the Windows pipe lifecycle, including an input pipe kept open."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class ProcessTests(unittest.TestCase):
    def test_pause_and_resume_commands_arrive_without_closing_stdin(self):
        script = (
            f'import sys;sys.path.insert(0,{str(Path(__file__).parent)!r})\n'
            'import bandit_worker as worker, threading, time\n'
            'threading.Thread(target=worker.control,daemon=True).start()\n'
            'deadline=time.monotonic()+5\n'
            'while not worker.paused.is_set() and time.monotonic()<deadline:time.sleep(0.01)\n'
            'assert worker.paused.is_set();print("paused",flush=True)\n'
            'while worker.paused.is_set() and time.monotonic()<deadline:time.sleep(0.01)\n'
            'assert not worker.paused.is_set();print("resumed",flush=True)\n'
        )
        child = subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            child.stdin.write('pause\n'); child.stdin.flush()
            self.assertEqual(child.stdout.readline().strip(), 'paused')
            child.stdin.write('resume\n'); child.stdin.flush()
            self.assertEqual(child.wait(timeout=8), 0)
            self.assertEqual(child.stdout.read().strip(), 'resumed')
            self.assertEqual(child.stderr.read(), '')
        finally:
            if child.poll() is None:
                child.kill(); child.wait()
            child.stdin.close(); child.stdout.close(); child.stderr.close()

    def test_info_modes_exit_with_open_input_pipe(self):
        worker = Path(__file__).with_name('bandit_worker.py')
        for mode in ['--info', '--runtime-info']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                # Run the real CLI entry point; replace only the large ML imports.
                entry = Path(folder) / 'probe.py'
                entry.write_text(
                    'import runpy, sys, types\n'
                    'torch=types.SimpleNamespace(__version__="2.8.0",version=types.SimpleNamespace(cuda=None),cuda=types.SimpleNamespace(is_available=lambda:False))\n'
                    'sys.modules["torch"]=torch\n'
                    'sys.modules["torchaudio"]=types.SimpleNamespace(__version__="2.8.0")\n'
                    'sys.modules["numpy"]=types.SimpleNamespace()\n'
                    'sys.modules["soundfile"]=types.SimpleNamespace()\n'
                    'sys.modules["bandit.models.bandit.bandit"]=types.SimpleNamespace(Bandit=object)\n'
                    f'runpy.run_path({str(worker)!r},run_name="__main__")\n', encoding='utf-8')
                child = subprocess.Popen([sys.executable, str(entry), mode], stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    # communicate() would close stdin and conceal this regression.
                    self.assertEqual(child.wait(timeout=8), 0)
                    info = json.loads(child.stdout.read())
                    self.assertTrue(info.get('runtimeReady') or info.get('devices'))
                    self.assertEqual(child.stderr.read(), '')
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                    child.stdin.close()
                    child.stdout.close()
                    child.stderr.close()

    def test_control_reader_exits_without_buffered_stdin_shutdown_lock(self):
        worker_folder = str(Path(__file__).parent)
        script = (
            f'import sys;sys.path.insert(0,{worker_folder!r})\n'
            'import bandit_worker, threading, time\n'
            'threading.Thread(target=bandit_worker.control,daemon=True).start()\n'
            'time.sleep(0.05)\n'
        )
        child = subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(child.wait(timeout=8), 0)
            self.assertEqual(child.stderr.read(), b'')
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdin.close()
            child.stdout.close()
            child.stderr.close()


if __name__ == '__main__':
    unittest.main()
