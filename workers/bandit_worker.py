"""Local, streaming adapter for the unmodified official Bandit v2 model."""
import argparse
import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path
sys.dont_write_bytecode = True

sys.path.insert(0, str(Path(__file__).parent / "vendor"))
paused = threading.Event()
def control():
    for line in sys.stdin:
        if line.strip() == 'pause': paused.set()
        elif line.strip() == 'resume': paused.clear()

def report(**values):
    print(json.dumps(values), flush=True)

def device_info():
    import torch
    devices = [{"id": "cpu", "name": "CPU"}]
    unavailable = []
    if torch.cuda.is_available():
        for index in range(torch.cuda.device_count()):
            identifier, name = f"cuda:{index}", f"GPU {index}"
            try:
                name = torch.cuda.get_device_name(index)
                # Detection alone can succeed with an unsupported GPU architecture.
                # Execute a kernel before offering this device (including Blackwell).
                torch.ones(1, device=identifier).add_(1)
                torch.cuda.synchronize(index)
                devices.append({"id": identifier, "name": name})
            except (RuntimeError, OSError) as error:
                unavailable.append({"id": identifier, "name": name, "reason": str(error)})
    return {"devices": devices, "unavailableDevices": unavailable, "cudaVersion": torch.version.cuda}

def select_device(requested, devices):
    if requested == "auto":
        return next((entry["id"] for entry in devices if entry["id"].startswith("cuda:")), "cpu")
    if requested not in {entry["id"] for entry in devices}:
        raise ValueError("DEVICE_UNAVAILABLE")
    return requested

def runtime_info():
    import torch
    import torchaudio
    import numpy
    import soundfile
    from bandit.models.bandit.bandit import Bandit
    torch_version = torch.__version__.split("+")[0]
    if torch_version != "2.8.0" or torchaudio.__version__.split("+")[0] != torch_version:
        raise ValueError("RUNTIME_INSTALL_FAILED")
    return {"runtimeReady": True, "torchVersion": torch_version, "cudaVersion": torch.version.cuda}

def separate(args):
    import numpy as np
    import soundfile as sf
    import torch
    from bandit.models.bandit.bandit import Bandit

    manifest = json.loads((Path(__file__).parent / "bandit-model.json").read_text())
    with open(args.model, "rb") as file:
        if hashlib.file_digest(file, "sha256").hexdigest() != manifest["sha256"]:
            raise ValueError("MODEL_CHECKSUM_FAILED")
    device = select_device(args.device, device_info()["devices"])
    torch.set_num_threads(min(4, max(1, (os.cpu_count() or 2) // 2)))
    model = Bandit(in_channels=1, stems=["speech", "music", "sfx"], fs=48000, n_sqm_modules=8, rnn_type="GRU", pad_mode="reflect")
    checkpoint = torch.load(args.model, map_location="cpu", weights_only=True)
    state = checkpoint["state_dict"]
    state = {key.removeprefix("model."): value for key, value in state.items() if key.startswith("model.")}
    model.load_state_dict(state, strict=True)
    del checkpoint, state
    model.eval().to(device)
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    report(stage="separate", progress=0, device=device)
    window = 8 * 48000; hop = 6 * 48000
    weights = np.maximum(np.hanning(window).astype(np.float32), 0.001)
    sums = {stem: np.zeros((window, 2), dtype=np.float32) for stem in model.stems}
    norm = np.zeros(window, dtype=np.float32)
    with sf.SoundFile(args.input) as source:
        if source.samplerate != 48000 or source.channels != 2 or source.frames < 1:
            raise ValueError("INVALID_SEPARATION_AUDIO")
        total = source.frames
        files = {stem: sf.SoundFile(output / f"{stem}.wav", mode="w", samplerate=48000, channels=2, subtype="PCM_16") for stem in model.stems}
        try:
            for start in range(0, total, hop):
                if paused.is_set():
                    report(stage='separationPaused',progress=start/total)
                    while paused.is_set(): time.sleep(0.1)
                source.seek(start)
                chunk = source.read(window, dtype="float32", always_2d=True)
                count = len(chunk)
                padded = np.pad(chunk, ((0, window-count), (0, 0)))
                audio = torch.from_numpy(padded.T.copy()).unsqueeze(1).to(device)
                with torch.inference_mode():
                    estimates = model({"mixture": {"audio": audio}})["estimates"]
                for stem in model.stems:
                    values = estimates[stem]["audio"].detach().cpu().numpy()[:, 0, :].T
                    sums[stem] += values * weights[:, None]
                norm += weights
                flush = min(hop, total-start)
                for stem in model.stems:
                    files[stem].write(sums[stem][:flush] / norm[:flush, None])
                    sums[stem][:-flush] = sums[stem][flush:]; sums[stem][-flush:] = 0
                norm[:-flush] = norm[flush:]; norm[-flush:] = 0
                del audio, estimates
                report(stage="separate", progress=min(1, (start+flush)/total))
        finally:
            for file in files.values(): file.close()
    report(stage="done", progress=1, sampleRate=48000, durationMs=round(total/48), device=device)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--info", action="store_true")
    parser.add_argument("--runtime-info", action="store_true")
    parser.add_argument("--input"); parser.add_argument("--output"); parser.add_argument("--model")
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()
    threading.Thread(target=control,daemon=True).start()
    try:
        if args.runtime_info: report(**runtime_info())
        elif args.info: report(**device_info())
        else: separate(args)
    except Exception as error:
        report(error=str(error)); sys.exit(1)
