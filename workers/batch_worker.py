"""One private NDJSON worker per dubbing lot. Exit is the GPU ownership boundary."""
import argparse
import contextlib
import faulthandler
import importlib
import json
import os
from pathlib import Path
import sys
import threading
import traceback

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

sys.dont_write_bytecode = True


def serve(module, incoming, protocol):
    state = {}
    profile = None
    def report(**values):
        print(json.dumps(values), file=protocol, flush=True)
    module.report = report
    for line in incoming:
        message = json.loads(line)
        if message.get('shutdown'):
            break
        key = message['requestId']
        try:
            request = json.loads(Path(message['path']).read_text(encoding='utf-8-sig'))
            current = tuple(request.get(key) for key in ('modelDir', 'variantId', 'device', 'compatibilityMode'))
            if profile is not None and profile != current:
                raise ValueError('INVALID_TTS_REQUEST')
            profile = current
            with contextlib.redirect_stdout(sys.stderr):
                module.generate(request, state)
            report(requestDone=key)
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            code = 'TTS_OUT_OF_MEMORY' if 'out of memory' in str(error).lower() else str(error).split(':')[0]
            if code == 'OUT_OF_MEMORY':
                code = 'TTS_OUT_OF_MEMORY'
            if not code.startswith(('TTS_', 'INVALID_', 'DEVICE_', 'MODEL_', 'OUT_')):
                code = 'TTS_ENGINE_FAILED'
            report(requestDone=key, error=code)
            # A failed native context or inference thread must never serve another line.
            break


def main():
    faulthandler.enable(file=sys.stderr, all_threads=True)
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=['cosyvoice_worker', 'fish_worker', 'drama_worker', 'multilingual_worker'], required=True)
    args = parser.parse_args()
    protocol = sys.stdout
    def thread_error(args):
        traceback.print_exception(args.exc_type, args.exc_value, args.exc_traceback, file=sys.stderr)
        message = str(args.exc_value).lower()
        code = 'TTS_OUT_OF_MEMORY' if 'out of memory' in message else 'TTS_FP8_MEMORY_REQUIRED' if 'insufficient vram' in message else 'TTS_ENGINE_FAILED'
        print(json.dumps({'error': code}), file=protocol, flush=True)
        os._exit(1)
    threading.excepthook = thread_error
    with contextlib.redirect_stdout(sys.stderr):
        module = importlib.import_module(args.engine)
    serve(module, sys.stdin, protocol)


if __name__ == '__main__':
    main()
