import { useState } from 'react';
import { Captions, FilePlus2, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../domain/types';
import * as bridge from '../services/bridge';

export function SubtitleImportPanel({
  project,
  role,
  run,
  close,
}: {
  project: Project;
  role: 'source' | 'target';
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  close: () => void;
}) {
  const { t } = useTranslation();
  const tracks = project.media?.streams.filter((stream) => stream.kind === 'subtitle') ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const [extracting, setExtracting] = useState(false);
  const importTrack = async () => {
    if (selected === null) return;
    setExtracting(true);
    try {
      await run(async () => {
        const result = await bridge.importEmbeddedSubtitles(role, selected);
        close();
        return result;
      });
    } finally {
      setExtracting(false);
    }
  };
  return (
    <div className="panel-body subtitle-picker" aria-busy={extracting}>
      <button
        className="button subtle wide"
        disabled={extracting}
        onClick={() => {
          void run(async () => {
            const result = await bridge.importSubtitles(role);
            if (result) close();
            return result;
          });
        }}
      >
        <FilePlus2 size={16} />
        {t('chooseSrtFile')}
      </button>
      <h3>
        <Captions size={17} />
        {t('embeddedTracks')}
      </h3>
      <p className="panel-description">{t('embeddedInstructions')}</p>
      <div className="subtitle-track-list">
        {tracks.map((stream) => (
          <label
            className={`subtitle-track ${stream.bitmap ? 'unavailable' : ''}`}
            key={stream.index}
          >
            <input
              type="radio"
              name="subtitle-track"
              value={stream.index}
              checked={selected === stream.index}
              disabled={stream.bitmap || extracting}
              onChange={() => setSelected(stream.index)}
            />
            <span>
              <strong>
                {t('subtitleTrack', { index: stream.index })} · {stream.language.toUpperCase()}
              </strong>
              <small>
                {stream.title || stream.codec.toUpperCase()} · {stream.codec.toUpperCase()}
              </small>
              {stream.bitmap && <small className="warning">{t('bitmapHint')}</small>}
            </span>
          </label>
        ))}
      </div>
      <p className="panel-description">{t('embeddedConversionHint')}</p>
      <button
        className="button accent wide"
        disabled={selected === null || extracting}
        onClick={() => void importTrack()}
      >
        {extracting ? <LoaderCircle size={16} className="spin" /> : <Captions size={16} />}
        {t(extracting ? 'extractingSubtitles' : 'useSubtitleTrack')}
      </button>
      {extracting && (
        <p role="status" className="panel-description">
          {t('extractingSubtitlesHint')}
        </p>
      )}
    </div>
  );
}
