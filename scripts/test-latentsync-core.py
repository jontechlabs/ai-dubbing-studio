"""Actual small neural models, CPU only. No full-checkpoint/GPU qualification."""
from pathlib import Path
import json
import sys
sys.dont_write_bytecode = True
import tempfile
import gc
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'workers'))
import torch
from diffusers import AutoencoderKL, DDIMScheduler
from transformers import WhisperConfig, WhisperModel
from latentsync_worker import encoder_features, audio_embeddings, sequential_guidance, strict_load, denoise
from latentsync.models.unet import UNet3DConditionModel

torch.set_num_threads(2)
torch.manual_seed(7)
headers = json.loads((root / 'workers/vendor/latentsync/checkpoint-headers.json').read_text(encoding='utf-8'))
for model_id, suffix in [('latentsync-15', '15'), ('latentsync-16', '16')]:
    config_path = root / f'workers/vendor/latentsync/config-{suffix}.json'
    with torch.device('meta'):
        architecture = UNet3DConditionModel.from_config(json.loads(config_path.read_text(encoding='utf-8')))
    expected = headers[model_id]['tensors']
    actual_shapes = {name: list(value.shape) for name, value in architecture.state_dict().items()}
    assert actual_shapes == {name: value['shape'] for name, value in expected.items()}
    assert len(actual_shapes) == 1246
    del architecture
    print(f'PASS: {model_id} actual official checkpoint header: all 1246 names/shapes match the vendored architecture.', flush=True)
with torch.inference_mode():
    encoder = WhisperModel(WhisperConfig(d_model=32, encoder_layers=4, decoder_layers=1,
        encoder_attention_heads=4, decoder_attention_heads=4, encoder_ffn_dim=64, decoder_ffn_dim=64,
        max_source_positions=8)).encoder.eval()
    mel = torch.randn(1, 80, 16)
    features = encoder_features(torch, encoder, mel)
    assert features.shape == (1, 8, 5, 32)
    assert torch.isfinite(features).all()
    assert not torch.allclose(features[:, :, -1], encoder(mel).last_hidden_state)
    raw = torch.arange(20 * 5 * 384).reshape(20, 5, 384).float()
    chunks = audio_embeddings(torch, raw, [0, 1, 9])
    assert torch.equal(chunks[0, :5], raw[0])
    assert torch.equal(chunks[2, -5:], raw[-1])
    print('PASS: actual Whisper encoder captures pre-LayerNorm conditioning and exact wrapper boundary indices.', flush=True)

    config = dict(sample_size=8, in_channels=13, out_channels=4, block_out_channels=(32, 64),
        down_block_types=('CrossAttnDownBlock3D', 'DownBlock3D'),
        up_block_types=('UpBlock3D', 'CrossAttnUpBlock3D'), layers_per_block=1,
        cross_attention_dim=384, attention_head_dim=4, norm_num_groups=8, add_audio_layer=True,
        use_motion_module=True, motion_module_resolutions=(1, 2), motion_module_type='Vanilla',
        motion_module_kwargs=dict(num_attention_heads=4, num_transformer_block=1,
            attention_block_types=['Temporal_Self', 'Temporal_Self'], temporal_position_encoding=True,
            temporal_position_encoding_max_len=24, temporal_attention_dim_div=1, zero_initialize=False))
    model = UNet3DConditionModel.from_config(config).eval()
    # Trained weights are nonzero. Randomize the upstream zero-init output for
    # a meaningful guidance equivalence test using the actual 3D architecture.
    model.conv_out.weight.normal_(0, .01)
    value = torch.randn(1, 13, 4, 8, 8)
    audio = torch.randn(4, 50, 384)
    batched = model(value.repeat(2, 1, 1, 1, 1), 5,
        encoder_hidden_states=torch.cat((torch.zeros_like(audio), audio))).sample
    expected = batched[:1] + 1.5 * (batched[1:] - batched[:1])
    actual = sequential_guidance(model, value, 5, audio, 1.5)
    assert torch.allclose(expected, actual, atol=2e-5, rtol=2e-4)
    assert torch.isfinite(actual).all()
    print('PASS: actual wrapper UNet3D/SDPA/temporal layers; sequential guidance matches batch-two guidance.', flush=True)

    with tempfile.TemporaryDirectory(prefix='LatentSync 日本語 ') as d:
        checkpoint = Path(d) / 'unet.pt'
        torch.save({'state_dict': model.state_dict()}, checkpoint)
        loaded = strict_load(torch, UNet3DConditionModel.from_config(config), checkpoint).eval()
        assert torch.allclose(model(value, 5, encoder_hidden_states=audio).sample,
            loaded(value, 5, encoder_hidden_states=audio).sample)
        del loaded
        gc.collect()
        wrong = dict(model.state_dict()); wrong.pop('conv_in.weight')
        bad_checkpoint = Path(d) / 'invalid.pt'
        torch.save({'state_dict': wrong}, bad_checkpoint)
        try:
            strict_load(torch, UNet3DConditionModel.from_config(config), bad_checkpoint)
            raise AssertionError('Missing trained layer was accepted')
        except RuntimeError:
            pass
        gc.collect()
    print('PASS: strict actual PyTorch checkpoint load under Unicode paths; missing trained layers rejected.', flush=True)

    references = torch.randn(9, 4, 8, 8)
    masked = torch.randn_like(references)
    mask = torch.ones(1, 8, 8)
    feature = torch.randn(18, 5, 384)
    scheduler = DDIMScheduler(beta_start=.00085, beta_end=.012, beta_schedule='scaled_linear',
        clip_sample=False, set_alpha_to_one=False, steps_offset=1)
    outputs = denoise(torch, model, scheduler, references, masked, mask, feature,
        torch.device('cpu'), torch.float32, 2, 1.5, 17, 4, progress=lambda **_: None)
    assert outputs.shape == references.shape and torch.isfinite(outputs).all()
    assert outputs.device.type == 'cpu'
    repeat = denoise(torch, model, scheduler, references, masked, mask, feature,
        torch.device('cpu'), torch.float32, 2, 1.5, 17, 4, progress=lambda **_: None)
    assert torch.equal(outputs, repeat)
    print('PASS: actual diffusion over overlapping bounded windows, deterministic CPU output and complete frame coverage.', flush=True)

    vae = AutoencoderKL(in_channels=3, out_channels=3, latent_channels=4,
        down_block_types=('DownEncoderBlock2D',) * 4, up_block_types=('UpDecoderBlock2D',) * 4,
        block_out_channels=(32, 32, 32, 32), norm_num_groups=8, sample_size=64).eval()
    pixels = torch.randn(1, 3, 64, 64)
    latent = vae.encode(pixels).latent_dist.sample()
    assert latent.shape == (1, 4, 8, 8)
    decoded = vae.decode(latent).sample.float().cpu()
    assert decoded.shape == pixels.shape and torch.isfinite(decoded).all()
    print('PASS: actual single-frame VAE encode/decode and CPU conversion; no full clip retained on a GPU.', flush=True)

print('CPU diagnostics passed. Full pretrained rendering and RTX 5060 Ti peak VRAM were not measured.', flush=True)
