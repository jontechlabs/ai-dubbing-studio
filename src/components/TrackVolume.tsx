import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Project, Track } from '../domain/types';
import { editTrack, trackLabel } from '../domain/audio';
export function TrackVolume({
  track,
  onEdit,
  busy,
}: {
  track: Track;
  onEdit: (f: (p: Project) => Project) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const label = t('globalTrackVolume', { name: t(trackLabel(track)) });
  const change = (value: number) =>
    onEdit((p) => editTrack(p, track.id, { gain: Math.min(4, Math.max(0, value)) }));
  const opened = !!position;
  useEffect(() => {
    if (!opened) return;
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !button.current?.contains(event.target as Node)
      )
        setPosition(null);
    };
    const close = () => setPosition(null);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', close);
    };
  }, [opened]);
  return (
    <div className="track-volume">
      <button
        ref={button}
        aria-label={label}
        title={label}
        aria-expanded={opened}
        onClick={() => {
          if (opened) {
            setPosition(null);
            return;
          }
          const rect = button.current!.getBoundingClientRect();
          setPosition({
            left: Math.min(window.innerWidth - 240, Math.max(10, rect.left)),
            top: Math.max(10, Math.min(window.innerHeight - 205, rect.bottom + 5)),
          });
        }}
      >
        {Math.round(track.gain * 100)}%
      </button>
      {position &&
        createPortal(
          <div
            ref={popup}
            className="track-volume-popup"
            role="dialog"
            aria-label={label}
            style={{ position: 'fixed', top: position.top, left: position.left, right: 'auto' }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setPosition(null);
                button.current?.focus();
              }
            }}
          >
            <strong>{label}</strong>
            <input
              aria-label={label}
              type="range"
              min={0}
              max={4}
              step={0.05}
              value={track.gain}
              disabled={busy}
              onChange={(e) => change(Number(e.target.value))}
            />
            <label>
              <input
                aria-label={t('trackVolumePercent')}
                type="number"
                min={0}
                max={400}
                step={5}
                value={Math.round(track.gain * 100)}
                disabled={busy}
                onChange={(e) => change(Number(e.target.value) / 100)}
              />
              %
            </label>
            <button disabled={busy} onClick={() => change(1)}>
              {t('trackVolumeReset')}
            </button>
            <small>
              {t('trackVolumeIndependent')}
              {track.mute ? ` ${t('trackVolumeMuted')}` : ''}
            </small>
          </div>,
          document.body,
        )}
    </div>
  );
}
