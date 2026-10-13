import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  Captions,
  ChevronDown,
  FilePlus2,
  Play,
  RefreshCw,
  Search,
  UserRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { dialogueText } from '../domain/subtitles';
import { formatTime } from '../domain/time';
import type { Dialogue, Project } from '../domain/types';

function DialoguesPane({
  project,
  selectedId,
  onSelect,
  onPlay,
  onImport,
  busy,
}: {
  project: Project | null;
  selectedId: string | null;
  onSelect: (line: Dialogue) => void;
  onPlay: (line: Dialogue) => void;
  onImport: (role: 'source' | 'target') => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [review, setReview] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    if (!project) return [];
    const source = new Map(project.sourceCues.map((cue) => [cue.id, cue.text]));
    const target = new Map(project.targetCues.map((cue) => [cue.id, cue.text]));
    return project.dialogues.filter(
      (d) =>
        (!review || d.warnings.length > 0 || d.status === 'review') &&
        [
          ...d.sourceCueIds.map((id) => source.get(id)),
          ...d.targetCueIds.map((id) => target.get(id)),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
    );
  }, [project, review, search]);
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 210,
    overscan: 4,
  });
  const selectionIndex = lines.findIndex((line) => line.id === selectedId);
  useEffect(() => {
    if (selectionIndex >= 0) virtual.scrollToIndex(selectionIndex, { align: 'auto' });
  }, [selectionIndex, virtual]);
  return (
    <section className="dialogues-pane">
      <div className="pane-heading">
        <div>
          <Captions size={17} />
          <h2>{t('dialogs')}</h2>
          <span className="count-badge">{project?.dialogues.length ?? 0}</span>
        </div>
        <button className="filter-button" onClick={() => setReview(!review)}>
          {t(review ? 'reviewOnly' : 'all')}
          <ChevronDown size={13} />
        </button>
      </div>
      <label className="search-field">
        <Search size={15} />
        <input
          placeholder={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="subtitle-imports">
        <button disabled={!project || busy} onClick={() => onImport('source')}>
          <FilePlus2 size={14} />
          {t('importSource')}
        </button>
        <button disabled={!project || busy} onClick={() => onImport('target')}>
          <FilePlus2 size={14} />
          {t('importTarget')}
        </button>
      </div>
      <div className="dialogue-scroll" ref={scrollRef}>
        {!lines.length ? (
          <div className="empty-dialogues">
            <div className="empty-symbol">
              <Captions size={25} />
            </div>
            <h3>{t(project?.dialogues.length ? 'noResults' : 'emptyDialogues')}</h3>
            <p>{t('emptyDialoguesHint')}</p>
          </div>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((item) => {
              const line = lines[item.index];
              return (
                <div
                  key={line.id}
                  data-index={item.index}
                  ref={virtual.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                    paddingBottom: 10,
                  }}
                >
                  <DialogueCard
                    project={project!}
                    line={line}
                    index={item.index + 1}
                    selected={line.id === selectedId}
                    onSelect={() => onSelect(line)}
                    onPlay={() => onPlay(line)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="pane-footnote">
        <span className="tiny-dot" />
        {t('dialogueCount', { count: project?.dialogues.length ?? 0 })}
      </div>
    </section>
  );
}
export const Dialogues = memo(DialoguesPane);
function DialogueCard({
  project,
  line,
  index,
  selected,
  onSelect,
  onPlay,
}: {
  project: Project;
  line: Dialogue;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onPlay: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article className={`dialogue-card ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <button
        className="line-select"
        aria-label={`${t('selectedLine', { index })} · ${formatTime(line.startMs)}`}
        onClick={onSelect}
      />
      <div className="cue-time">
        <span>
          {formatTime(line.startMs)} <span className="time-arrow">→</span> {formatTime(line.endMs)}
        </span>
        <span>{((line.endMs - line.startMs) / 1000).toFixed(2)} s</span>
      </div>
      <div className="character-label">
        <span className="character-avatar">
          <UserRound size={12} />
        </span>
        {t('unassigned')}
        <span className="line-number">{String(index).padStart(2, '0')}</span>
      </div>
      <div className="cue-text original-text">
        <button
          title={t('original')}
          aria-label={t('original')}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
            onPlay();
          }}
        >
          <Play size={12} />
        </button>
        <div>
          <span className="text-label">
            {project.languages.source.toUpperCase()} · {t('original')}
          </span>
          <p>{dialogueText(project, line, 'source') || t('noOriginal')}</p>
        </div>
      </div>
      <div className="cue-text target-text">
        <button disabled title={t('noDub')} aria-label={t('translated')}>
          <Play size={12} />
        </button>
        <div>
          <span className="text-label">
            {project.languages.target.toUpperCase()} · {t('translated')}
          </span>
          <p>{dialogueText(project, line, 'target') || t('noTranslation')}</p>
        </div>
      </div>
      <div className="card-footer">
        <span className="status">
          <span className="status-dot" />
          {t(line.status)}
        </span>
        {line.warnings.length > 0 && (
          <span className="warning" title={t('alignment')}>
            <AlertTriangle size={13} />
          </span>
        )}
        <button disabled title={t('futureTts')}>
          <RefreshCw size={12} />
          {t('regenerate')}
        </button>
      </div>
    </article>
  );
}
