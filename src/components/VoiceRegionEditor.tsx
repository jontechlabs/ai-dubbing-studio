import { useEffect, useMemo, useRef, useState } from 'react';
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
import { dubbingBounds, dubbingClips, recoverDubbing } from '../domain/mix';
import { envelopeLevel } from '../domain/voiceEnvelope';
import { generationUrl, dubbingUrl } from '../services/bridge';
import { beginVoicePlayback } from '../services/voicePlayback';
import { VoicePlayhead } from './VoicePlayhead';
import { EffectsChainEditor } from './EffectsChainEditor';
import type { VoiceEdit } from '../domain/voiceEdit';

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
  busy: externalBusy,
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
  const [validating, setValidating] = useState(false);
  const busy = externalBusy || validating;
  const editToken = useRef(0);
  const editLock = useRef(false);
  useEffect(() => {
    const lifetime = editToken;
    editLock.current = false;
    setValidating(false);
    return () => {
      lifetime.current++;
    };
  }, [generation.id]);
  const plan = useMemo(() => voicePlan(project, generation), [project, generation]),
    total = editDuration(plan);
  const limits = dubbingBounds(project, generation.dialogueId);
  const blocked = limits.duration < limits.min;
  const maxInsert = Math.max(0, limits.max - total);
  const key = JSON.stringify(plan);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const start = Math.min(range.start, total),
    end = Math.min(range.end, total),
    length = end - start;
  const minimumStretch = useMemo(() => {
    let offset = 0,
      count = 0;
    for (const p of plan.pieces) {
      if (start < offset + p.durationMs && end > offset) count++;
      offset += p.durationMs;
    }
    return Math.max(1, count);
  }, [plan, start, end]);
  const [amount, setAmount] = useState(250),
    [gain, setGain] = useState(1);
  const [fadeIn, setFadeIn] = useState(50),
    [fadeOut, setFadeOut] = useState(50);
  const [error, setError] = useState(''),
    [samples, setSamples] = useState<Float32Array | null>(null);
  const [playing, setPlaying] = useState(false),
    [loading, setLoading] = useState(false);
  const surface = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const audio = useRef<{ context: AudioContext; source: AudioBufferSourceNode | null } | null>(
      null,
    ),
    request = useRef(0),
    finishPlayback = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<{
    kind: 'select' | 'stretch' | 'start' | 'end';
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
    finishPlayback.current?.();
    finishPlayback.current = null;
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
      finishPlayback.current?.();
      finishPlayback.current = null;
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
              peak = Math.max(
                peak,
                Math.abs(samples[j]) *
                  piece.gain *
                  normalize *
                  envelopeLevel(piece.envelope, local * piece.durationMs),
              );
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
  const editBasis = (p: Project) => {
    const clip = dubbingClips(p).find((c) => c.generation.id === generation.id);
    const take = p.generations.find((g) => g.id === generation.id);
    return JSON.stringify([
      p.id,
      p.media?.path,
      take,
      p.voiceEdits?.[generation.id],
      clip && [clip.startMs, clip.slotMs, clip.exactDuration],
    ]);
  };
  const apply = async (operation: VoiceOperation) => {
    if (editLock.current || externalBusy) return;
    const token = editToken.current;
    try {
      if (blocked) throw Error('VOICE_EDIT_NO_ROOM');
      const candidate = editVoice(
        project,
        generation.id,
        operation.kind === 'effects' && !length ? 0 : start,
        operation.kind === 'effects' && !length ? total : end,
        operation,
      );
      const clip = dubbingClips(candidate).find((c) => c.generation.id === generation.id)!;
      const expected = editBasis(candidate);
      editLock.current = true;
      setValidating(true);
      stop();
      // Render and fit a private cache copy before making an undoable project edit.
      await dubbingUrl(
        generation.id,
        clip.slotMs,
        clip.exactDuration,
        candidate.voiceEdits?.[generation.id],
      );
      if (editToken.current !== token) return;
      onEdit((p) => {
        const next = editVoice(
          p,
          generation.id,
          operation.kind === 'effects' && !length ? 0 : start,
          operation.kind === 'effects' && !length ? total : end,
          operation,
        );
        if (editBasis(next) !== expected) throw Error('VOICE_EDIT_STALE');
        return next;
      });
      setError('');
      if (operation.kind === 'silence') setRange({ start, end: start + operation.durationMs });
      if (operation.kind === 'delete') setRange({ start, end: start });
      if (operation.kind === 'stretch') setRange({ start, end: start + operation.durationMs });
    } catch (e) {
      if (editToken.current === token) {
        const message = String(e).replace(/^Error: /, '');
        setError(
          message.includes('VOICE_EDIT_FAILED') || message.includes('MIX_FIT_FAILED')
            ? 'voiceEditRenderFailedKept'
            : message,
        );
      }
    } finally {
      if (editToken.current === token) {
        editLock.current = false;
        setValidating(false);
      }
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
  const preview = async (original = false, previewPlan?: VoiceEdit) => {
    document.dispatchEvent(new Event('studio-voice-preview'));
    stop();
    const token = request.current;
    setLoading(true);
    document.querySelector('video')?.pause();
    try {
      if (!original && start >= total) {
        stop();
        return;
      }
      const context = new AudioContext();
      audio.current = { context, source: null };
      await context.resume();
      const url = await generationUrl(generation.id, original ? undefined : (previewPlan ?? plan));
      if (request.current !== token) return;
      const response = await fetch(url);
      if (!response.ok) throw Error('TTS_AUDIO_MISSING');
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (request.current !== token) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      audio.current = { context, source };
      let completed = false;
      source.onended = () => {
        completed = true;
        if (request.current === token) stop();
      };
      // Schedule exactly the selected samples, independent of timeupdate cadence.
      if (original) source.start(0);
      else source.start(0, start / 1000, (length > 0 ? length : total - start) / 1000);
      const began = context.currentTime;
      const offset = original ? 0 : start;
      const until = original
        ? buffer.duration * 1000
        : Math.min(buffer.duration * 1000, length > 0 ? end : total);
      finishPlayback.current = beginVoicePlayback(() => {
        // Prefer the device output clock to account for its audio buffer latency.
        const stamp = context.getOutputTimestamp?.();
        const clock =
          stamp && stamp.performanceTime && stamp.contextTime
            ? Math.min(
                context.currentTime,
                stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000,
              )
            : context.currentTime;
        return {
          generationId: generation.id,
          positionMs: completed
            ? until
            : Math.min(until, offset + Math.max(0, clock - began) * 1000),
          durationMs: original ? buffer.duration * 1000 : total,
          original,
          playing: !completed,
        };
      });
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
          } else if (drag.kind === 'start')
            setRange({ start: Math.min(drag.anchor - 1, position(e.clientX)), end: drag.anchor });
          else if (drag.kind === 'end')
            setRange({ start: drag.anchor, end: Math.max(drag.anchor + 1, position(e.clientX)) });
          else
            setDrag({
              ...drag,
              duration: Math.max(
                minimumStretch,
                Math.min(
                  limits.max - total + length,
                  length + Math.round(((e.clientX - drag.x) / drag.width) * total),
                ),
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
        {length > 0 &&
          (['start', 'end'] as const).map((edge) => (
            <button
              key={edge}
              className={`voice-range-edge ${edge}`}
              style={{ left: `${((edge === 'start' ? start : end) / total) * 100}%` }}
              disabled={busy}
              aria-label={t(
                edge === 'start' ? 'voiceResizeSelectionStart' : 'voiceResizeSelectionEnd',
              )}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();
                surface.current!.setPointerCapture(e.pointerId);
                setDrag({
                  kind: edge,
                  anchor: edge === 'start' ? end : start,
                  x: e.clientX,
                  duration: length,
                  width,
                });
              }}
            />
          ))}
        {length > 0 && (
          <button
            type="button"
            className="voice-stretch-handle"
            style={{ left: `${(end / total) * 100}%` }}
            disabled={busy}
            title={t('stretchVoiceHint')}
            aria-label={t('stretchVoiceHint')}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
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
        <VoicePlayhead
          generationId={generation.id}
          plan={plan}
          clipStartMs={
            dubbingClips(project).find((c) => c.generation.id === generation.id)?.startMs
          }
          busy={busy}
          onPlace={(positionMs) => {
            stop();
            document.dispatchEvent(new Event('studio-voice-preview'));
            document.querySelector('video')?.pause();
            setRange({ start: positionMs, end: positionMs });
          }}
        />
      </div>
      <p className="voice-duration-limits" role="status">
        {t('voiceDurationLimits', { duration: limits.duration, max: limits.max })}
      </p>
      {limits.limited && (
        <div role="alert">
          <p>{t('voiceTimingLimited')}</p>
          <button
            disabled={busy}
            onClick={() => onEdit((p) => recoverDubbing(p, generation.dialogueId))}
          >
            {t('voiceRecoverTiming')}
          </button>
        </div>
      )}
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
        <button disabled={busy} onClick={() => void preview(true)}>
          <Play size={13} /> {t('voiceOriginalPreview')}
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
        <label>
          {t('voiceFadeIn')}
          <input
            type="number"
            aria-label={t('voiceFadeIn')}
            min={0}
            max={Math.max(0, length - fadeOut)}
            value={fadeIn}
            disabled={busy || !length}
            onChange={(e) => setFadeIn(Number(e.target.value))}
          />
        </label>
        <label>
          {t('voiceFadeOut')}
          <input
            type="number"
            aria-label={t('voiceFadeOut')}
            min={0}
            max={Math.max(0, length - fadeIn)}
            value={fadeOut}
            disabled={busy || !length}
            onChange={(e) => setFadeOut(Number(e.target.value))}
          />
        </label>
        <button
          disabled={busy || !length}
          onClick={() => apply({ kind: 'fade', fadeInMs: fadeIn, fadeOutMs: fadeOut })}
        >
          {t('voiceApplyFades')}
        </button>
        <button
          disabled={busy || !length}
          onClick={() => {
            apply({ kind: 'fade', fadeInMs: 0, fadeOutMs: 0 });
            setFadeIn(0);
            setFadeOut(0);
          }}
        >
          {t('voiceClearFades')}
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
            max={Math.max(maxInsert, limits.max - total + length)}
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
      <details className="voice-effects-panel">
        <summary>{t('fxTitle')}</summary>
        <p className="panel-description">
          {t(length > 0 ? 'fxVoiceSelectionHint' : 'fxVoiceWholeHint')}
        </p>
        <EffectsChainEditor
          key={`${generation.id}:${start}:${end}:${JSON.stringify(plan.pieces.map((p) => p.effects ?? []))}`}
          initial={(() => {
            let offset = 0;
            for (const piece of plan.pieces) {
              offset += piece.durationMs;
              if (offset > (length > 0 ? start : 0)) return piece.effects ?? [];
            }
            return [];
          })()}
          disabled={busy || validating || loading}
          allowEmpty
          applyLabel={t('fxApplyVoice')}
          onApply={(effects) => void apply({ kind: 'effects', effects })}
          onPreview={(effects) => {
            try {
              const candidate = editVoice(
                project,
                generation.id,
                length > 0 ? start : 0,
                length > 0 ? end : total,
                { kind: 'effects', effects },
              );
              void preview(false, candidate.voiceEdits?.[generation.id]);
            } catch (e) {
              setError(String(e));
            }
          }}
        />
      </details>
      {validating && <p role="status">{t('voiceEditValidating')}</p>}
      <small>{t('voiceOriginalKept')}</small>
      <small>{t('fxWaveformHint')}</small>
      <small>{t('voiceEditHint')}</small>
      {error && <p role="alert">{t(error)}</p>}
    </section>
  );
}
