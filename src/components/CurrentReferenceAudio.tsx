import { useRef, useState } from 'react';
import { Play, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as bridge from '../services/bridge';
import type { Project } from '../domain/types';
export function CurrentReferenceAudio({
  lineId,
  trackId,
  snapshot,
  onError,
  onPlay,
  disabled,
}: {
  lineId: string;
  trackId?: string;
  snapshot: () => Promise<Project>;
  onError: (message: string) => void;
  onPlay: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation(),
    [url, setUrl] = useState(''),
    [working, setWorking] = useState(false),
    audio = useRef<HTMLAudioElement | null>(null);
  return (
    <div className="current-reference-audio">
      <button
        className="button subtle wide"
        disabled={disabled || working}
        onClick={() => {
          if (url && audio.current) {
            onPlay();
            void audio.current.play().catch((e) => onError(String(e)));
            return;
          }
          setWorking(true);
          void snapshot()
            .then(() => bridge.characterSampleUrl(lineId, trackId))
            .then((value) => setUrl(value))
            .catch((e) => onError(String(e)))
            .finally(() => setWorking(false));
        }}
      >
        {working ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{' '}
        {t('workbench.listenCurrentReference')}
      </button>
      {url && (
        <audio
          ref={audio}
          src={url}
          controls
          autoPlay
          preload="metadata"
          aria-label={t('ttsListenReference')}
          onPlay={onPlay}
        />
      )}
      <small>{t('workbench.referenceExcerpt')}</small>
    </div>
  );
}
