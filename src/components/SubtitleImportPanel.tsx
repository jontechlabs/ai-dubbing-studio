import { useState } from 'react';
import { Captions, FilePlus2, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../domain/types';
import * as bridge from '../services/bridge';
import { autoAlignment } from '../services/autoAlignment';

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
  const aliases: Record<string, string[]> = {
    fr: ['fr', 'fre', 'fra'],
    ja: ['ja', 'jpn'],
    en: ['en', 'eng'],
    de: ['de', 'deu', 'ger'],
    es: ['es', 'spa'],
    it: ['it', 'ita'],
  };
  const languages = aliases[project.languages[role]] ?? [project.languages[role]];
  const [selected, setSelected] = useState<number | null>(
    tracks.find((track) => !track.bitmap && languages.includes(track.language.toLowerCase()))
      ?.index ?? null,
  );
  const [extracting, setExtracting] = useState(false);
  const [synchronize, setSynchronize] = useState(true),
    [warning, setWarning] = useState<string | null>(null);
  const finish = async (result: Project | null): Promise<Project | null> => {
    if (!result) return null;
    if (synchronize && result.sourceCues.length >= 3 && result.targetCues.length >= 3) {
      try {
        const next = await autoAlignment(result, role);
        const saved = await bridge.replaceProject(next, result.revision);
        close();
        return saved;
      } catch (error) {
        setWarning(String(error).replace(/^Error:\s*/, ''));
        return result;
      }
    }
    close();
    return result;
  };
  const importTrack = async () => {
    if (selected === null) return;
    setExtracting(true);
    setWarning(null);
    try {
      await run(async () => {
        return finish(await bridge.importEmbeddedSubtitles(role, selected));
      });
    } finally {
      setExtracting(false);
    }
  };
  return (
    <div className="panel-body subtitle-picker" aria-busy={extracting}>
      <p className="panel-description">{t('subtitleImportHint')}</p>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={synchronize}
          disabled={extracting}
          onChange={(event) => setSynchronize(event.target.checked)}
        />
        {t('autoAlignImported')}
      </label>
      <p className="panel-description">{t('autoAlignImportedHint')}</p>
      {warning && (
        <p className="warning" role="alert">
          {t('subtitleImportedAlignmentSkipped')}{' '}
          {t(`errors.${warning}`, { defaultValue: t('errors.ALIGNMENT_FAILED') })}
        </p>
      )}
      <button
        className="button subtle wide"
        disabled={extracting}
        onClick={() => {
          void run(async () => {
            setExtracting(true);
            setWarning(null);
            try {
              return await finish(await bridge.importSubtitles(role));
            } finally {
              setExtracting(false);
            }
          });
        }}
      >
        {extracting ? <LoaderCircle size={16} className="spin" /> : <FilePlus2 size={16} />}
        {t('chooseSrtFile')}
      </button>
      {extracting && (
        <p className="panel-description" role="status">
          {t('subtitleImportWorking')}
        </p>
      )}
      {!!tracks.length && (
        <>
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
        </>
      )}
    </div>
  );
}
