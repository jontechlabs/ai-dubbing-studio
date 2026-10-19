import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { editDuration, type VoiceEdit } from '../domain/voiceEdit';
import { sourceToEditedTime } from '../domain/voicePlayhead';
import { readVoicePlayback } from '../services/voicePlayback';

export function VoicePlayhead({
  generationId,
  plan,
  clipStartMs,
  busy,
  onPlace,
}: {
  generationId: string;
  plan: VoiceEdit;
  clipStartMs: number | undefined;
  busy: boolean;
  onPlace: (positionMs: number) => void;
}) {
  const { t } = useTranslation();
  const [cursor, setCursor] = useState<{
    position: number | null;
    original: number | null;
  } | null>(null);
  const ignored = useRef(0);
  const revision = JSON.stringify(plan);
  const previous = useRef(revision);
  const total = editDuration(plan);
  useEffect(() => {
    // A changed edit invalidates the position from the previous rendered WAV.
    if (previous.current !== revision) {
      ignored.current = readVoicePlayback().sequence;
      previous.current = revision;
    }
    let frame = 0,
      disposed = false;
    const video = document.querySelector('video');
    const followVideo = () => {
      ignored.current = readVoicePlayback().sequence;
    };
    const seekVideo = () => {
      // Selecting a reply seeks the paused video immediately before its audio
      // audition starts; the delayed seeking event must not steal that clock.
      if (!readVoicePlayback().playback?.playing) followVideo();
    };
    video?.addEventListener('play', followVideo);
    video?.addEventListener('seeking', seekVideo);
    const update = () => {
      if (disposed) return;
      const { sequence, playback } = readVoicePlayback();
      let next: typeof cursor = null;
      if (playback && sequence > ignored.current) {
        if (playback.generationId === generationId) {
          const position = playback.original
            ? sourceToEditedTime(plan, playback.positionMs)
            : playback.durationMs > 0
              ? (playback.positionMs / playback.durationMs) * total
              : null;
          next = {
            position: position === null ? null : Math.round(Math.max(0, Math.min(total, position))),
            original: playback.original ? Math.round(playback.positionMs) : null,
          };
        }
      } else if (video && clipStartMs !== undefined) {
        const local = video.currentTime * 1000 - clipStartMs;
        if (local >= 0 && local <= total) next = { position: Math.round(local), original: null };
      }
      // Only this small overlay updates during playback, not the waveform/editor.
      setCursor((old) =>
        old?.position === next?.position && old?.original === next?.original ? old : next,
      );
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      video?.removeEventListener('play', followVideo);
      video?.removeEventListener('seeking', seekVideo);
    };
  }, [generationId, revision, plan, total, clipStartMs]);
  const position = cursor?.position;
  return (
    <>
      {position !== null && position !== undefined && (
        <div
          className="voice-wave-playhead"
          aria-hidden="true"
          data-position-ms={position}
          style={{ left: `${(position / total) * 100}%` }}
        />
      )}
      <div className="voice-playback-clock" onPointerDown={(e) => e.stopPropagation()}>
        <output aria-label={t('voicePlaybackPosition')}>
          {cursor?.original !== null && cursor?.original !== undefined
            ? `${t('voiceOriginalClock')} ${(cursor.original / 1000).toFixed(3)} s · `
            : ''}
          {position !== null && position !== undefined
            ? `${(position / 1000).toFixed(3)} / ${(total / 1000).toFixed(3)} s`
            : cursor?.original !== null && cursor?.original !== undefined
              ? t('voiceSourceRemoved')
              : t('voicePlayheadIdle')}
        </output>
        <button
          type="button"
          disabled={busy || position === null || position === undefined}
          onClick={() => {
            if (position !== null && position !== undefined) onPlace(position);
          }}
        >
          {t('voicePlaceAtPlayhead')}
        </button>
      </div>
    </>
  );
}
