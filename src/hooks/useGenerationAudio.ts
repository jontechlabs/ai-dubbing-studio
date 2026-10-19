import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Generation } from '../domain/types';
import { generationUrl } from '../services/bridge';
import { beginVoicePlayback } from '../services/voicePlayback';
export function useGenerationAudio(
  video: RefObject<HTMLVideoElement | null>,
  mediaKey: string | undefined,
  volume: number,
  onError: (error: string) => void,
  edits?: import('../domain/types').Project['voiceEdits'],
) {
  const audio = useRef<HTMLAudioElement | null>(null),
    finishPlayback = useRef<(() => void) | null>(null),
    token = useRef(0),
    [active, setActive] = useState<string | null>(null);
  const stop = useCallback(() => {
    finishPlayback.current?.();
    finishPlayback.current = null;
    token.current++;
    audio.current?.pause();
    if (audio.current) audio.current.src = '';
    audio.current = null;
    setActive(null);
  }, []);
  const play = useCallback(
    (generation: Generation) => {
      stop();
      document.dispatchEvent(new Event('studio-voice-preview'));
      const request = token.current;
      video.current?.pause();
      setActive(generation.id);
      void generationUrl(generation.id, edits?.[generation.id])
        .then((url) => {
          if (request !== token.current) return;
          const element = new Audio(url);
          audio.current = element;
          element.volume = volume;
          finishPlayback.current = beginVoicePlayback(() => ({
            generationId: generation.id,
            positionMs: element.currentTime * 1000,
            durationMs: Number.isFinite(element.duration)
              ? element.duration * 1000
              : generation.durationMs,
            original: false,
            playing: !element.paused,
          }));
          element.onended = () => {
            if (request === token.current) stop();
          };
          element.onerror = () => {
            if (request === token.current) {
              stop();
              onError('TTS_AUDIO_MISSING');
            }
          };
          return element.play();
        })
        .catch((error) => {
          if (request === token.current) {
            stop();
            onError(String(error));
          }
        });
    },
    [stop, video, volume, onError, edits],
  );
  const editKey = JSON.stringify(edits ?? {});
  useEffect(() => {
    stop();
  }, [editKey, stop]);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    stop();
    const element = video.current;
    element?.addEventListener('play', stop);
    document.addEventListener('studio-voice-preview', stop);
    return () => {
      element?.removeEventListener('play', stop);
      document.removeEventListener('studio-voice-preview', stop);
      stop();
    };
  }, [mediaKey, video, stop]);
  return { play, stop, active };
}
