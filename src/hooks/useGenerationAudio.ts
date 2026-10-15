import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Generation } from '../domain/types';
import { generationUrl } from '../services/bridge';
export function useGenerationAudio(
  video: RefObject<HTMLVideoElement | null>,
  mediaKey: string | undefined,
  volume: number,
  onError: (error: string) => void,
) {
  const audio = useRef<HTMLAudioElement | null>(null),
    token = useRef(0),
    [active, setActive] = useState<string | null>(null);
  const stop = useCallback(() => {
    token.current++;
    audio.current?.pause();
    if (audio.current) audio.current.src = '';
    audio.current = null;
    setActive(null);
  }, []);
  const play = useCallback(
    (generation: Generation) => {
      stop();
      const request = token.current;
      video.current?.pause();
      setActive(generation.id);
      void generationUrl(generation.id)
        .then((url) => {
          if (request !== token.current) return;
          const element = new Audio(url);
          audio.current = element;
          element.volume = volume;
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
    [stop, video, volume, onError],
  );
  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    stop();
    const element = video.current;
    element?.addEventListener('play', stop);
    return () => {
      element?.removeEventListener('play', stop);
      stop();
    };
  }, [mediaKey, video, stop]);
  return { play, stop, active };
}
