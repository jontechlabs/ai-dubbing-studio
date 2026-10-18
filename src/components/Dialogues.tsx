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
import { assignCharacter } from '../domain/characters';
import { selectedGeneration, staleGeneration } from '../domain/tts';
import {
  approveTranslation,
  translationState,
  translationStates,
  type TranslationState,
} from '../domain/translation';

function DialoguesPane({
  checkedIds,
  onCheck,
  onBatch,
  project,
  selectedId,
  onSelect,
  onPlay,
  onImport,
  busy,
  onEdit,
  onCharacters,
  onAlignment,
  onTranslation,
  onDub,
  onPlayDub,
}: {
  checkedIds: string[];
  onCheck: (ids: string[]) => void;
  onBatch: () => void;
  project: Project | null;
  selectedId: string | null;
  onSelect: (line: Dialogue) => void;
  onPlay: (line: Dialogue) => void;
  onImport: (role: 'source' | 'target') => void;
  busy: boolean;
  onEdit: (update: (project: Project) => Project) => void;
  onCharacters: () => void;
  onAlignment: () => void;
  onTranslation: (line: Dialogue) => void;
  onDub: (line: Dialogue) => void;
  onPlayDub: (line: Dialogue) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [review, setReview] = useState(false);
  const [translationFilter, setTranslationFilter] = useState<'all' | TranslationState>('all');
  const states = useMemo(() => (project ? translationStates(project) : new Map()), [project]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const checkedAnchor = useRef<string | null>(null);
  const numbers = useMemo(
    () => new Map(project?.dialogues.map((line, index) => [line.id, index + 1]) ?? []),
    [project],
  );
  const lines = useMemo(() => {
    if (!project) return [];
    const source = new Map(project.sourceCues.map((cue) => [cue.id, cue.text]));
    const target = new Map(project.targetCues.map((cue) => [cue.id, cue.text]));
    return project.dialogues.filter(
      (d) =>
        (translationFilter === 'all' || states.get(d.id) === translationFilter) &&
        (!review ||
          d.warnings.length > 0 ||
          d.status === 'review' ||
          (selectedGeneration(project, d) &&
            staleGeneration(project, d, selectedGeneration(project, d)!))) &&
        [
          ...d.sourceCueIds.map((id) => source.get(id)),
          ...d.targetCueIds.map((id) => target.get(id)),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
    );
  }, [project, review, search, translationFilter, states]);
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
      <label className="translation-filter">
        <span>{t('translationFilter')}</span>
        <select
          aria-label={t('translationFilter')}
          value={translationFilter}
          onChange={(e) => setTranslationFilter(e.target.value as typeof translationFilter)}
        >
          <option value="all">{t('translationFilterAll')}</option>
          {(['untranslated', 'translated', 'approved'] as const).map((state) => (
            <option key={state} value={state}>
              {t(`translationState.${state}`)}
            </option>
          ))}
        </select>
        <span className="translation-filter-count" aria-label={t('translationFilterCount')}>
          {lines.length} / {project?.dialogues.length ?? 0}
        </span>
      </label>
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
        <button
          disabled={!project?.sourceCues.length || !project?.targetCues.length || busy}
          onClick={onAlignment}
        >
          <RefreshCw size={14} />
          {t('syncSubtitles')}
        </button>
      </div>
      <div className="batch-selection-actions">
        <button
          className="button subtle"
          disabled={!lines.length}
          onClick={() => onCheck(lines.map((l) => l.id))}
        >
          {t('batchCheckVisible')}
        </button>
        <button className="text-button" disabled={!checkedIds.length} onClick={() => onCheck([])}>
          {t('batchClearSelection')}
        </button>
        <button
          className="button accent"
          disabled={!project?.dialogues.length || busy}
          onClick={onBatch}
        >
          {t('batchDub')} {checkedIds.length > 0 && `(${checkedIds.length})`}
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
                    checked={checkedIds.includes(line.id)}
                    onCheck={(shift) => {
                      const next = new Set(checkedIds),
                        anchor = lines.findIndex((l) => l.id === checkedAnchor.current);
                      if (shift && anchor >= 0) {
                        for (const entry of lines.slice(
                          Math.min(anchor, item.index),
                          Math.max(anchor, item.index) + 1,
                        ))
                          next.add(entry.id);
                      } else if (next.has(line.id)) next.delete(line.id);
                      else next.add(line.id);
                      checkedAnchor.current = line.id;
                      onCheck([...next]);
                    }}
                    project={project!}
                    line={line}
                    index={numbers.get(line.id) ?? item.index + 1}
                    selected={line.id === selectedId}
                    onSelect={() => onSelect(line)}
                    onPlay={() => onPlay(line)}
                    onCharacter={(characterId) =>
                      onEdit((p) => assignCharacter(p, [line.id], characterId))
                    }
                    onCharacters={onCharacters}
                    onTranslation={() => onTranslation(line)}
                    onDub={() => onDub(line)}
                    onPlayDub={() => onPlayDub(line)}
                    onApprove={() =>
                      onEdit((p) =>
                        approveTranslation(p, line.id, translationState(p, line) !== 'approved'),
                      )
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="translation-legend" aria-label={t('translationLegend')}>
        {(['untranslated', 'translated', 'approved'] as const).map((state) => (
          <span key={state} className={`translation-badge ${state}`}>
            ● {t(`translationState.${state}`)}
          </span>
        ))}
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
  checked,
  onCheck,
  project,
  line,
  index,
  selected,
  onSelect,
  onPlay,
  onCharacter,
  onCharacters,
  onTranslation,
  onDub,
  onPlayDub,
  onApprove,
}: {
  onApprove: () => void;
  checked: boolean;
  onCheck: (shift: boolean) => void;
  project: Project;
  line: Dialogue;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onPlay: () => void;
  onCharacter: (id: string | null) => void;
  onCharacters: () => void;
  onTranslation: () => void;
  onDub: () => void;
  onPlayDub: () => void;
}) {
  const { t } = useTranslation();
  const translation = translationState(project, line);
  const generation = selectedGeneration(project, line);
  const stale = !!generation && staleGeneration(project, line, generation);
  return (
    <article
      className={`dialogue-card translation-${translation} ${selected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      <button
        className="line-select"
        aria-label={`${t('selectedLine', { index })} · ${formatTime(line.startMs)}`}
        onClick={onSelect}
      />
      <div className="cue-time">
        <input
          type="checkbox"
          className="dialogue-check"
          checked={checked}
          aria-label={t('batchCheckLine', { number: index })}
          onClick={(e) => {
            e.stopPropagation();
            onCheck(e.shiftKey);
          }}
          onChange={() => {}}
        />
        <span>
          {formatTime(line.startMs)} <span className="time-arrow">→</span> {formatTime(line.endMs)}
        </span>
        <span>{((line.endMs - line.startMs) / 1000).toFixed(2)} s</span>
      </div>
      <div className="character-label">
        <span
          className="character-avatar"
          style={{
            color: project.characters.find((character) => character.id === line.characterId)?.color,
          }}
        >
          <UserRound size={12} />
        </span>
        <select
          aria-label={`${t('character')} ${index}`}
          value={line.characterId ?? ''}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onCharacter(event.target.value || null)}
        >
          <option value="">{t('unassigned')}</option>
          {project.characters.map((character) => (
            <option key={character.id} value={character.id}>
              {character.name}
            </option>
          ))}
        </select>
        <button
          className="text-button"
          aria-label={`${t('characters')} ${index}`}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
            onCharacters();
          }}
        >
          <UserRound size={12} />
        </button>
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
        <button
          disabled={!generation}
          title={t(generation ? 'ttsListenDub' : 'noDub')}
          aria-label={t('translated')}
          onClick={(event) => {
            event.stopPropagation();
            onPlayDub();
          }}
        >
          <Play size={12} />
        </button>
        <div>
          <span className="text-label">
            {project.languages.target.toUpperCase()} · {t('translated')}
          </span>
          {dialogueText(project, line, 'target') ? (
            <p>{dialogueText(project, line, 'target')}</p>
          ) : (
            <button
              className="add-translation"
              onClick={(event) => {
                event.stopPropagation();
                onTranslation();
              }}
            >
              {t('noTranslation')}
            </button>
          )}
        </div>
      </div>
      <div className="translation-review">
        <button
          className={`translation-badge ${translation}`}
          disabled={translation === 'untranslated'}
          aria-pressed={translation === 'approved'}
          aria-label={t(
            translation === 'approved' ? 'translationUnapprove' : 'translationApprove',
            { number: index },
          )}
          title={t('translationReviewHint')}
          onClick={(e) => {
            e.stopPropagation();
            onApprove();
          }}
        >
          <span aria-hidden="true">{translation === 'approved' ? '✓' : '●'}</span>{' '}
          {t(`translationState.${translation}`)}
        </button>
      </div>
      <div className="card-footer">
        <button
          className="status"
          title={t('ttsOpenHint')}
          onClick={(event) => {
            event.stopPropagation();
            onDub();
          }}
        >
          <span className="status-dot" />
          {t(stale ? 'review' : line.status)}
        </button>
        {line.warnings.length > 0 && (
          <span className="warning" title={t('alignment')}>
            <AlertTriangle size={13} />
          </span>
        )}
        <button
          title={t('ttsOpenHint')}
          onClick={(event) => {
            event.stopPropagation();
            onDub();
          }}
        >
          <RefreshCw size={12} />
          {t(generation ? 'regenerate' : 'ttsDubLine')}
        </button>
      </div>
    </article>
  );
}
