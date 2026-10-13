import { Mic2, Play, Type } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dialogueText, editDialogue } from '../domain/subtitles';
import type { Dialogue, Project } from '../domain/types';

export function Editor({
  project,
  selected,
  onEdit,
  onPlay,
  busy,
}: {
  project: Project | null;
  selected: Dialogue | undefined;
  onEdit: (update: (p: Project) => Project) => void;
  onPlay: (d: Dialogue) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'text' | 'tts'>('text');
  if (!project || !selected)
    return (
      <div className="editor empty-editor">
        <Type size={17} />
        <span>{t('selectLine')}</span>
      </div>
    );
  const source = dialogueText(project, selected, 'source');
  const target = dialogueText(project, selected, 'target');
  const update = (role: 'source' | 'target' | 'tts', value: string) =>
    onEdit((p) => editDialogue(p, selected.id, role, value));
  return (
    <section className="editor">
      <div className="editor-header">
        <div className="editor-tabs">
          <button className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}>
            <Type size={13} />
            {t('textTab')}
          </button>
          <button className={tab === 'tts' ? 'active' : ''} onClick={() => setTab('tts')}>
            <Mic2 size={13} />
            {t('ttsTab')}
          </button>
        </div>
        <button className="line-preview" onClick={() => onPlay(selected)} disabled={!project.media}>
          <Play size={12} />
          {t('linePreview')}
        </button>
      </div>
      {tab === 'text' ? (
        <div className="editor-fields">
          <label>
            <span>
              {t('original')} <small>{project.languages.source.toUpperCase()}</small>
            </span>
            <textarea
              aria-label={t('original')}
              value={source}
              disabled={busy}
              onChange={(e) => update('source', e.target.value)}
              placeholder={t('noOriginal')}
            />
          </label>
          <label>
            <span>
              {t('displayedText')} <small>{project.languages.target.toUpperCase()}</small>
            </span>
            <textarea
              aria-label={t('displayedText')}
              value={target}
              disabled={busy}
              onChange={(e) => update('target', e.target.value)}
              placeholder={t('noTranslation')}
            />
          </label>
        </div>
      ) : (
        <div className="tts-editor">
          <label>
            <span>{t('ttsText')}</span>
            <textarea
              aria-label={t('ttsText')}
              value={selected.ttsText ?? target}
              disabled={busy}
              onChange={(e) => update('tts', e.target.value)}
            />
          </label>
          <div>
            <p>{t('ttsHint')}</p>
            <button className="text-button" onClick={() => update('tts', '')}>
              {t('useTranslation')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
