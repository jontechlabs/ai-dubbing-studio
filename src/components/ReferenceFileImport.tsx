import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as bridge from '../services/bridge';

export function ReferenceFileImport({
  busy,
  onError,
  onImport,
  onPending,
  label,
}: {
  busy: boolean;
  onError: (error: string) => void;
  onImport: (file: bridge.ReferenceFileSelection) => Promise<boolean>;
  onPending?: (pending: boolean) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<bridge.ReferenceAudioInfo | null>(null),
    [working, setWorking] = useState(false);
  const [start, setStart] = useState(0),
    [end, setEnd] = useState(20);
  const [canSeek, setCanSeek] = useState(false);
  const audio = useRef<HTMLAudioElement>(null),
    rangePlaying = useRef(false);
  const stop = () => {
    rangePlaying.current = false;
    audio.current?.pause();
  };
  const valid =
    !!file &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end <= file.durationMs / 1000 &&
    end - start >= 1 &&
    end - start <= 20;
  return (
    <div className="reference-file-import">
      <button
        className="button subtle wide"
        disabled={!bridge.native || busy || working}
        onClick={() => {
          stop();
          setWorking(true);
          void bridge
            .chooseReferenceAudio()
            .then((value) => {
              if (value) {
                setCanSeek(value.path === file?.path && (audio.current?.readyState ?? 0) >= 1);
                setFile(value);
                setStart(0);
                setEnd(Math.min(20, value.durationMs / 1000));
                onPending?.(true);
              }
            })
            .catch((e) => onError(String(e)))
            .finally(() => setWorking(false));
        }}
      >
        {t(label ?? 'ttsImportReference')}
      </button>
      {file && (
        <section className="settings-section reference-range">
          <strong>{file.path.split(/[\\/]/).at(-1)}</strong>
          <audio
            key={file.path}
            controls
            preload="metadata"
            src={file.url}
            ref={audio}
            aria-label={t('referenceSourcePreview')}
            onTimeUpdate={() => {
              if (rangePlaying.current && audio.current && audio.current.currentTime >= end) stop();
            }}
            onEnded={stop}
            onLoadedMetadata={() => setCanSeek(true)}
          />
          <div className="character-range">
            <label className="field">
              <span>{t('referenceStart')}</span>
              <input
                type="number"
                min="0"
                max={file.durationMs / 1000}
                step="0.001"
                value={start}
                onChange={(e) => {
                  stop();
                  setStart(Number(e.target.value));
                }}
                disabled={busy || working}
              />
            </label>
            <label className="field">
              <span>{t('referenceEnd')}</span>
              <input
                type="number"
                min="0"
                max={file.durationMs / 1000}
                step="0.001"
                value={end}
                onChange={(e) => {
                  stop();
                  setEnd(Number(e.target.value));
                }}
                disabled={busy || working}
              />
            </label>
          </div>
          <div className="reference-range-actions">
            <button
              className="text-button"
              disabled={!canSeek || busy || working}
              onClick={() => {
                const value = audio.current?.currentTime ?? 0;
                stop();
                setStart(Math.round(value * 1000) / 1000);
              }}
            >
              {t('referenceMarkStart')}
            </button>
            <button
              className="text-button"
              disabled={!canSeek || busy || working}
              onClick={() => {
                const value = audio.current?.currentTime ?? 0;
                stop();
                setEnd(Math.round(value * 1000) / 1000);
              }}
            >
              {t('referenceMarkEnd')}
            </button>
            <button
              className="button subtle"
              disabled={!canSeek || !valid || busy || working}
              onClick={() => {
                if (audio.current) {
                  audio.current.currentTime = start;
                  rangePlaying.current = true;
                  void audio.current.play().catch((e) => {
                    stop();
                    onError(String(e));
                  });
                }
              }}
            >
              {t('referencePlayRange')}
            </button>
          </div>
          <p className={valid ? 'panel-description' : 'warning'} role="status">
            {t('referenceRangeHint', { seconds: (end - start).toFixed(3) })}
          </p>
          <button
            className="button accent wide"
            disabled={!valid || busy || working}
            onClick={() => {
              stop();
              setWorking(true);
              void onImport({
                ...file,
                startMs: Math.round(start * 1000),
                endMs: Math.round(end * 1000),
              })
                .then((success) => {
                  if (success) {
                    setFile(null);
                    onPending?.(false);
                  }
                })
                .catch((e) => onError(String(e)))
                .finally(() => setWorking(false));
            }}
          >
            {t('referenceUseRange')}
          </button>
          <button
            className="text-button"
            disabled={working}
            onClick={() => {
              stop();
              setFile(null);
              onPending?.(false);
            }}
          >
            {t('cancel')}
          </button>
        </section>
      )}
    </div>
  );
}
