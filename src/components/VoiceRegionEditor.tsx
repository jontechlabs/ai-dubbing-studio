import { useEffect, useRef, useState } from 'react';
import { Scissors, X, Play, Square, VolumeX, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Generation, Project } from '../domain/types';
import {
  editDuration,
  editVoice,
  resetVoiceEdit,
  voicePlan,
  type VoiceOperation,
} from '../domain/voiceEdit';
import { generationUrl } from '../services/bridge';

function releaseAudio(
  playback: { context: AudioContext; source: AudioBufferSourceNode | null } | null,
) {
  if (!playback) return;
  if (playback.source) {
    playback.source.onended = null;
    playback.source.stop();
    playback.source.disconnect();
  }
  void playback.context.close().catch(() => {});
}
export function VoiceRegionEditor({
  project,
  generation,
  busy,
  onEdit,
  onClose,
}: {
  project: Project;
  generation: Generation;
  busy: boolean;
  onEdit: (update: (p: Project) => Project) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const plan = voicePlan(project, generation),
    total = editDuration(plan);
  const key = JSON.stringify(plan);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const start = Math.min(range.start, total),
    end = Math.min(range.end, total),
    length = end - start;
  const [amount, setAmount] = useState(250),
    [gain, setGain] = useState(1);
  const [error, setError] = useState(''),
    [samples, setSamples] = useState<Float32Array | null>(null);
  const [playing, setPlaying] = useState(false),
    [loading, setLoading] = useState(false);
  const surface = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const audio = useRef<{ context: AudioContext; source: AudioBufferSourceNode | null } | null>(
      null,
    ),
    request = useRef(0);
  const [drag, setDrag] = useState<{
    kind: 'select' | 'stretch';
    anchor: number;
    x: number;
    duration: number;
    width: number;
  } | null>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!drag) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDrag(null);
      }
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [drag]);
  const stop = () => {
    request.current++;
    releaseAudio(audio.current);
    audio.current = null;
    setPlaying(false);
    setLoading(false);
  };
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    void generationUrl(generation.id)
      .then((url) => fetch(url, { signal: controller.signal }))
      .then((r) => {
        if (!r.ok) throw Error('TTS_AUDIO_MISSING');
        return r.arrayBuffer();
      })
      .then(async (bytes) => {
        const context = new AudioContext();
        try {
          const decoded = await context.decodeAudioData(bytes);
          if (!disposed) setSamples(decoded.getChannelData(0).slice());
        } finally {
          await context.close();
        }
      })
      .catch(() => {
        if (!disposed) setError('waveformUnavailable');
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [generation.id]);
  useEffect(() => {
    // A changed edit/undo must stop the old audio, including pending renders.
    const release = () => {
      request.current++;
      releaseAudio(audio.current);
      audio.current = null;
    };
    release();
    setPlaying(false);
    setLoading(false);
    const video = document.querySelector('video');
    const halt = () => {
      release();
      setPlaying(false);
      setLoading(false);
    };
    video?.addEventListener('play', halt);
    document.addEventListener('studio-voice-preview', halt);
    return () => {
      video?.removeEventListener('play', halt);
      document.removeEventListener('studio-voice-preview', halt);
      release();
    };
  }, [key, busy]);
  useEffect(() => {
    const c = canvas.current,
      context = c?.getContext('2d');
    if (!c || !context) return;
    const ratio = devicePixelRatio || 1;
    c.width = width * ratio;
    c.height = 70 * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, 70);
    context.strokeStyle = '#86d5b7';
    context.beginPath();
    if (samples) {
      let maxPeak = 0;
      for (const sample of samples) maxPeak = Math.max(maxPeak, Math.abs(sample));
      const normalize = 0.85 / Math.max(0.01, maxPeak);
      let offset = 0;
      for (const piece of plan.pieces) {
        const left = (offset / total) * width,
          right = ((offset + piece.durationMs) / total) * width;
        for (let x = Math.floor(left); x < right; x += 2) {
          let peak = 0;
          if (piece.sourceStartMs !== null && piece.gain > 0) {
            const local = Math.max(0, (x - left) / Math.max(1, right - left));
            const sourceMs =
              piece.sourceStartMs + (piece.sourceEndMs! - piece.sourceStartMs) * local;
            const at = Math.floor((sourceMs / generation.durationMs) * samples.length);
            const n = Math.max(
              1,
              Math.ceil(
                ((((piece.sourceEndMs! - piece.sourceStartMs) / generation.durationMs) *
                  samples.length) /
                  Math.max(1, right - left)) *
                  2,
              ),
            );
            for (let j = at; j < Math.min(samples.length, at + n); j++)
              peak = Math.max(peak, Math.abs(samples[j]) * piece.gain * normalize);
          }
          const h = Math.max(0.5, Math.min(1, peak) * 31);
          context.moveTo(x, 35 - h);
          context.lineTo(x, 35 + h);
        }
        offset += piece.durationMs;
      }
      context.stroke();
    }
    // The serialized plan is stable during unrelated project edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, width, key, total, generation.durationMs]);
  const apply = (operation: VoiceOperation) => {
    try {
      // Validate synchronously so a failed operation leaves selection/project intact.
      editVoice(project, generation.id, start, end, operation);
      onEdit((p) => editVoice(p, generation.id, start, end, operation));
      stop();
      setError('');
      if (operation.kind === 'silence') setRange({ start, end: start + operation.durationMs });
      if (operation.kind === 'delete') setRange({ start, end: start });
      if (operation.kind === 'stretch') setRange({ start, end: start + operation.durationMs });
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''));
    }
  };
  const position = (clientX: number) =>
    Math.max(
      0,
      Math.min(
        total,
        Math.round(((clientX - surface.current!.getBoundingClientRect().left) / width) * total),
      ),
    );
  const preview = async () => {
    document.dispatchEvent(new Event('studio-voice-preview'));
    stop();
    const token = request.current;
    setLoading(true);
    document.querySelector('video')?.pause();
    try {
      if (start >= total) {
        stop();
        return;
      }
      const context = new AudioContext();
      audio.current = { context, source: null };
      await context.resume();
      const url = await generationUrl(generation.id, plan);
      if (request.current !== token) return;
      const response = await fetch(url);
      if (!response.ok) throw Error('TTS_AUDIO_MISSING');
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (request.current !== token) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      audio.current = { context, source };
      source.onended = () => {
        if (request.current === token) stop();
      };
      // Schedule exactly the selected samples, independent of timeupdate cadence.
      source.start(0, start / 1000, (length > 0 ? length : total - start) / 1000);
      setPlaying(true);
      setLoading(false);
    } catch (e) {
      if (request.current === token) {
        stop();
        setError(String(e));
      }
    }
  };
  const input = (edge: 'start' | 'end', value: number) => {
    const n = Math.max(0, Math.min(total, Math.round(value || 0)));
    setRange(
      edge === 'start'
        ? { start: n, end: Math.max(n, end) }
        : { start: Math.min(start, n), end: n },
    );
  };
  return (
    <section className="voice-region-editor" aria-label={t('voiceRegionEditor')}>
      <div className="voice-editor-title">
        <strong>
          <Scissors size={15} />
          {t('voiceRegionEditor')}
        </strong>
        <span>{generation.text}</span>
        <button onClick={onClose} aria-label={t('closeVoiceEditor')}>
          <X size={16} />
        </button>
      </div>
      <div
        className="voice-edit-wave"
        ref={surface}
        role="group"
        aria-label={t('voiceWaveSelection')}
        onPointerDown={(e) => {
          if (busy || e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const anchor = position(e.clientX);
          setDrag({ kind: 'select', anchor, x: e.clientX, duration: 0, width });
          setRange({ start: anchor, end: anchor });
        }}
        onPointerMove={(e) => {
          if (!drag || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
          if (drag.kind === 'select') {
            const p = position(e.clientX);
            setRange({ start: Math.min(drag.anchor, p), end: Math.max(drag.anchor, p) });
          } else
            setDrag({
              ...drag,
              duration: Math.max(
                1,
                Math.min(120000, length + Math.round(((e.clientX - drag.x) / drag.width) * total)),
              ),
            });
        }}
        onPointerUp={(e) => {
          if (drag?.kind === 'stretch') apply({ kind: 'stretch', durationMs: drag.duration });
          setDrag(null);
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setDrag(null);
        }}
      >
        <canvas ref={canvas} />
        <span className="voice-wave-zero">0</span>
        <span className="voice-wave-total">{(total / 1000).toFixed(3)} s</span>
        {!samples && <span className="voice-wave-loading">{t('waveformLoading')}</span>}
        <div
          className="voice-wave-selection"
          style={{ left: `${(start / total) * 100}%`, width: `${(length / total) * 100}%` }}
        />
        {length > 0 && (
          <button
            type="button"
            className="voice-stretch-handle"
            style={{ left: `${(end / total) * 100}%` }}
            disabled={busy}
            title={t('stretchVoiceHint')}
            aria-label={t('stretchVoiceHint')}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              surface.current!.setPointerCapture(e.pointerId);
              setDrag({ kind: 'stretch', anchor: start, x: e.clientX, duration: length, width });
            }}
          >
            ↔
          </button>
        )}
        {drag?.kind === 'stretch' && (
          <output className="voice-stretch-preview">{drag.duration} ms</output>
        )}
      </div>
      <div className="voice-edit-controls">
        <label>
          {t('voiceSelectionStart')}
          <input
            type="number"
            aria-label={t('voiceSelectionStart')}
            min={0}
            max={total}
            value={start}
            disabled={busy}
            onChange={(e) => input('start', Number(e.target.value))}
          />
        </label>
        <label>
          {t('voiceSelectionEnd')}
          <input
            type="number"
            aria-label={t('voiceSelectionEnd')}
            min={0}
            max={total}
            value={end}
            disabled={busy}
            onChange={(e) => input('end', Number(e.target.value))}
          />
        </label>
        <button disabled={busy} onClick={() => setRange({ start: 0, end: total })}>
          {t('voiceSelectAll')}
        </button>
        <button disabled={busy} onClick={() => (playing || loading ? stop() : void preview())}>
          {playing ? <Square size={13} /> : <Play size={13} />}{' '}
          {t(loading ? 'voicePreparing' : playing ? 'voiceStopPreview' : 'voicePreview')}
        </button>
        <label>
          {t('voiceVolume')}
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={gain}
            disabled={busy || !length}
            onChange={(e) => setGain(Number(e.target.value))}
          />
          <output>{Math.round(gain * 100)}%</output>
        </label>
        <button disabled={busy || !length} onClick={() => apply({ kind: 'gain', gain })}>
          {t('voiceApplyVolume')}
        </button>
        <button disabled={busy || !length} onClick={() => apply({ kind: 'gain', gain: 0 })}>
          <VolumeX size={13} />
          {t('voiceMuteSelection')}
        </button>
        <button
          disabled={busy || !length || length === total}
          onClick={() => apply({ kind: 'delete' })}
        >
          <Scissors size={13} />
          {t('voiceDeleteSelection')}
        </button>
        <label>
          {t('voiceDurationAmount')}
          <input
            type="number"
            aria-label={t('voiceDurationAmount')}
            min={1}
            max={120000}
            value={amount}
            disabled={busy}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        </label>
        <button
          disabled={busy || !Number.isSafeInteger(amount) || amount < 1}
          onClick={() => apply({ kind: 'silence', durationMs: amount })}
        >
          {t('voiceInsertSilence')}
        </button>
        <button
          disabled={busy || !length || !Number.isSafeInteger(amount) || amount < 1}
          onClick={() => apply({ kind: 'stretch', durationMs: amount })}
        >
          {t('voiceStretchSelection')}
        </button>
        <button
          disabled={busy || !project.voiceEdits?.[generation.id]}
          onClick={() => {
            stop();
            onEdit((p) => resetVoiceEdit(p, generation.id));
            setRange({ start: 0, end: 0 });
            setError('');
          }}
        >
          <RotateCcw size={13} />
          {t('voiceResetEdit')}
        </button>
      </div>
      <small>{t('voiceEditHint')}</small>
      {error && <p role="alert">{t(error)}</p>}
    </section>
  );
}
