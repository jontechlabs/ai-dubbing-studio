import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project, Track } from '../domain/types';
import type { Waveform as WaveformData } from '../domain/waveform';
import { waveform } from '../services/bridge';
import { peakEnvelope, peakInRange } from './timelineRendering';

export const Waveform = memo(function Waveform({
  project,
  scale,
  viewport,
  scrollLeft,
  height,
  track,
}: {
  project: Project;
  scale: number;
  viewport: number;
  scrollLeft: number;
  height: number;
  track?: Track;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<WaveformData | null>(null),
    [state, setState] = useState('waveformLoading');
  const canvas = useRef<HTMLCanvasElement>(null);
  const [attempt, setAttempt] = useState(0);
  const envelope = useMemo(() => (data ? peakEnvelope(data.peaks) : null), [data]);
  useEffect(() => {
    let disposed = false;
    void waveform(project, track)
      .then((result) => {
        if (!disposed) {
          setData(result);
          setState(result ? '' : 'waveformUnavailable');
        }
      })
      .catch(() => {
        if (!disposed) setState('waveformUnavailable');
      });
    return () => {
      disposed = true;
    };
    // The component is keyed by media identity; text edits never decode audio again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  useEffect(() => {
    const element = canvas.current,
      context = element?.getContext('2d');
    if (!element || !context || !data || !envelope) return;
    const ratio = devicePixelRatio || 1;
    element.width = Math.ceil(viewport * ratio);
    element.height = Math.ceil(height * ratio);
    context.scale(ratio, ratio);
    context.clearRect(0, 0, viewport, height);
    context.fillStyle = getComputedStyle(element).color;
    for (let x = 0; x < viewport; x++) {
      const from = Math.floor((scrollLeft + x) / scale / data.stepMs),
        to = Math.ceil((scrollLeft + x + 1) / scale / data.stepMs);
      const peak = peakInRange(envelope.levels, from, to);
      const amplitude = (peak / envelope.maximum) * (height - 6);
      context.fillRect(x, (height - amplitude) / 2, 1, Math.max(1, amplitude));
    }
  }, [data, envelope, scale, viewport, scrollLeft, height]);
  return (
    <div className="waveform" style={{ left: scrollLeft, width: viewport, height }}>
      {state ? (
        state === 'waveformUnavailable' ? (
          <button
            className="waveform-retry"
            onClick={() => {
              setState('waveformLoading');
              setAttempt((n) => n + 1);
            }}
            title={t('retry')}
          >
            {t(state)} · {t('retry')}
          </button>
        ) : (
          <span>{t(state)}</span>
        )
      ) : (
        <canvas aria-label={t('waveform')} ref={canvas} style={{ width: viewport, height }} />
      )}
    </div>
  );
});
