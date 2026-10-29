import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  AudioLines,
  BadgeCheck,
  BadgeMinus,
  Captions,
  ChevronDown,
  FilePlus2,
  Play,
  ListChecks,
  ListX,
  ScanFace,
  RefreshCw,
  Search,
  UserRound,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { dialogueText } from '../domain/subtitles';
import { formatTime } from '../domain/time';
import type { Dialogue, Project } from '../domain/types';
import { assignCharacter } from '../domain/characters';
import { CharacterAvatar } from './CharacterTools';
import { selectedGeneration, staleGeneration } from '../domain/tts';
import { canApproveJointReview, reviewIndex, indexedTake } from '../domain/jointReview';
import type { OpenContextMenu } from './ContextMenu';
import { setDialogueExclusion } from '../domain/dialogueEditing';
import {
  approveTranslation,
  approveTranslations,
  translationState,
  translationStates,
  type TranslationState,
} from '../domain/translation';

function DialoguesPane({
  onAdd,
  onDelete,
  openContext,
  checkedIds,
  onCheck,
  onBatch,
  onLipBatch,
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
  onAdd: (atMs?: number) => void;
  onDelete: (ids: string[]) => void;
  openContext: OpenContextMenu;
  checkedIds: string[];
  onCheck: (ids: string[]) => void;
  onBatch: () => void;
  onLipBatch: () => void;
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
  const [showExcluded, setShowExcluded] = useState(false);
  const [translationFilter, setTranslationFilter] = useState<'all' | TranslationState>('all');
  const states = useMemo(() => (project ? translationStates(project) : new Map()), [project]);
  const selectedTranslations = useMemo(() => {
    const lines = new Map(project?.dialogues.map((l) => [l.id, l]));
    const index = project ? reviewIndex(project) : null;
    return {
      pending: checkedIds.filter((id) => {
        const l = lines.get(id);
        if (!project || !index || !l || l.excludedFromDubbing || states.get(id) !== 'translated')
          return false;
        const g = indexedTake(project, l, index);
        return !g || !staleGeneration(project, l, g);
      }).length,
      approved: checkedIds.filter((id) => states.get(id) === 'approved').length,
    };
  }, [checkedIds, states, project]);
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
        (!d.excludedFromDubbing || showExcluded) &&
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
  }, [project, review, search, translationFilter, states, showExcluded]);
  const getItemKey = useCallback((index: number) => lines[index].id, [lines]);
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 210,
    getItemKey,
    gap: 10,
    overscan: 4,
  });
  const measureRows = useCallback(() => {
    scrollRef.current?.querySelectorAll('[data-dialogue-row]').forEach(virtual.measureElement);
  }, [virtual]);
  // Measure the actual multiline content before paint, including reused rows
  // whose index changed after filtering. ResizeObserver alone can deliver late.
  useLayoutEffect(measureRows);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      virtual.measure();
      measureRows();
    });
    observer.observe(element);
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (!disposed) measureRows();
    });
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [virtual, measureRows]);
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
      {project?.dialogues.some((l) => l.excludedFromDubbing) && (
        <label className="checkbox-field dialogue-excluded-toggle">
          <input
            type="checkbox"
            checked={showExcluded}
            onChange={(e) => setShowExcluded(e.target.checked)}
          />
          {t('dialogueShowExcluded', {
            count: project.dialogues.filter((l) => l.excludedFromDubbing).length,
          })}
        </label>
      )}
      <label className="search-field">
        <Search size={15} />
        <input
          placeholder={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="subtitle-imports">
        <button disabled={!project || busy} onClick={() => onAdd()}>
          <Plus size={14} />
          {t('dialogueAdd')}
        </button>
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
          aria-label={t('batchCheckVisible')}
          title={t('batchCheckVisible')}
          disabled={!lines.length}
          onClick={() => onCheck(lines.map((l) => l.id))}
        >
          <ListChecks size={14} />
        </button>
        <button
          className="button subtle"
          aria-label={t('batchClearSelection')}
          title={t('batchClearSelection')}
          disabled={!checkedIds.length}
          onClick={() => onCheck([])}
        >
          <ListX size={14} />
        </button>
        <button
          className="button subtle"
          aria-label={t('dialogueDeleteSelection')}
          title={t('dialogueDeleteSelection')}
          disabled={busy || !checkedIds.length}
          onClick={() => onDelete(checkedIds)}
        >
          <Trash2 size={14} />
        </button>
        <button
          className="button accent"
          aria-label={`${t('batchDub')}${checkedIds.length > 0 ? ` (${checkedIds.length})` : ''}`}
          title={t('batchDub')}
          disabled={!project?.dialogues.length || busy}
          onClick={onBatch}
        >
          <AudioLines size={13} />
          {t('batchDubCompact')} {checkedIds.length > 0 && `(${checkedIds.length})`}
        </button>
        <button
          className="button subtle"
          aria-label={t('inpaintBatch')}
          title={t('inpaintBatch')}
          disabled={!project?.dialogues.length || busy}
          onClick={onLipBatch}
        >
          <ScanFace size={13} />
          {t('batchLipCompact')}
        </button>
        {checkedIds.length > 0 && (
          <div
            className="translation-selection-actions"
            role="group"
            aria-label={t('translationSelection')}
          >
            <span>{t('translationSelectionCount', { count: checkedIds.length })}</span>
            <button
              className="button subtle"
              aria-label={t('translationApproveSelection')}
              title={t('translationApproveSelectionHint', { count: selectedTranslations.pending })}
              disabled={busy || !selectedTranslations.pending}
              onClick={() => onEdit((p) => approveTranslations(p, checkedIds, true))}
            >
              <BadgeCheck size={14} />
              {t('translationApproveCompact')}
            </button>
            <button
              className="button subtle"
              aria-label={t('translationUnapproveSelection')}
              title={t('translationUnapproveSelectionHint', {
                count: selectedTranslations.approved,
              })}
              disabled={busy || !selectedTranslations.approved}
              onClick={() => onEdit((p) => approveTranslations(p, checkedIds, false))}
            >
              <BadgeMinus size={14} />
              {t('translationUnapproveCompact')}
            </button>
          </div>
        )}
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
                  data-dialogue-row={line.id}
                  ref={virtual.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <DialogueCard
                    onRestore={() => onEdit((p) => setDialogueExclusion(p, [line.id], false))}
                    onDelete={() => onDelete([line.id])}
                    openContext={(event) =>
                      openContext(event, t('dialogueContext'), [
                        { label: t('dialogueAdd'), disabled: busy, run: () => onAdd(line.endMs) },
                        {
                          label: t(
                            line.excludedFromDubbing ? 'dialogueRestore' : 'dialogueDeleteTitle',
                          ),
                          disabled: busy,
                          danger: true,
                          run: () =>
                            line.excludedFromDubbing
                              ? onEdit((p) => setDialogueExclusion(p, [line.id], false))
                              : onDelete([line.id]),
                        },
                        ...(checkedIds.includes(line.id)
                          ? [
                              {
                                label: t('dialogueDeleteSelection'),
                                disabled: busy,
                                danger: true,
                                run: () => onDelete(checkedIds),
                              },
                            ]
                          : []),
                      ])
                    }
                    busy={busy}
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
  onRestore,
  onDelete,
  openContext,
  busy,
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
  onRestore: () => void;
  onDelete: () => void;
  openContext: (event: import('react').MouseEvent<HTMLElement>) => void;
  busy: boolean;
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
      className={`dialogue-card translation-${translation} ${line.excludedFromDubbing ? 'dialogue-excluded' : ''} ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest('input,textarea,select')) return;
        openContext(event);
      }}
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
          {line.characterId && project.characterProfiles?.[line.characterId]?.portrait ? (
            <CharacterAvatar
              project={project}
              portrait={project.characterProfiles[line.characterId].portrait}
              small
            />
          ) : (
            <UserRound size={12} />
          )}
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
        {line.excludedFromDubbing && (
          <span className="translation-badge untranslated">{t('dialogueExcluded')}</span>
        )}
        <button
          className={`translation-badge ${translation}`}
          disabled={
            busy ||
            translation === 'untranslated' ||
            (translation !== 'approved' && !canApproveJointReview(project, line))
          }
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
          className="icon-button"
          aria-label={t(line.excludedFromDubbing ? 'dialogueRestore' : 'dialogueDeleteLine', {
            number: index,
          })}
          title={t(line.excludedFromDubbing ? 'dialogueRestore' : 'dialogueDeleteLine', {
            number: index,
          })}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            if (line.excludedFromDubbing) onRestore();
            else onDelete();
          }}
        >
          <Trash2 size={13} />
        </button>
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
