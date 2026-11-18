"""Inference-only, native-complex STFT interface for the pinned ESPnet model.

Equivalent fixed-length, single-item STFT settings; no training/ASR imports.
The unmodified TF-GridNet layers and their checkpoint stay in the vendor ZIP.
"""
import torch
from torch import nn


AbsSeparator = nn.Module


def get_layer(name):
    return {'relu': nn.ReLU, 'prelu': nn.PReLU, 'gelu': nn.GELU}[name.lower()]


def new_complex_like(reference, parts):
    return torch.complex(*parts)


class STFTEncoder(nn.Module):
    def __init__(self, n_fft, win_length, hop_length, window='hann', **kwargs):
        super().__init__()
        if window != 'hann':
            raise ValueError('SPEAKER_SEPARATION_MODEL_INVALID')
        self.n_fft, self.hop_length = n_fft, hop_length
        self.register_buffer('window', torch.hann_window(win_length), persistent=False)

    def forward(self, samples, lengths):
        batch, size, channels = samples.shape
        flat = samples.transpose(1, 2).reshape(batch * channels, size)
        spectrum = torch.stft(flat, self.n_fft, self.hop_length,
                              window=self.window, center=True, return_complex=True)
        spectrum = spectrum.reshape(batch, channels, spectrum.shape[-2], spectrum.shape[-1])
        return spectrum.permute(0, 3, 1, 2), lengths


class STFTDecoder(nn.Module):
    def __init__(self, n_fft, win_length, hop_length, window='hann', **kwargs):
        super().__init__()
        if window != 'hann':
            raise ValueError('SPEAKER_SEPARATION_MODEL_INVALID')
        self.n_fft, self.hop_length = n_fft, hop_length
        self.register_buffer('window', torch.hann_window(win_length), persistent=False)

    def forward(self, spectrum, lengths):
        wave = torch.istft(spectrum.transpose(1, 2), self.n_fft, self.hop_length,
                          window=self.window, center=True, length=int(lengths.max().item()))
        return wave, lengths
