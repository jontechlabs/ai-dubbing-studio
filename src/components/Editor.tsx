import { Mic2, AudioLines, Play, Type, Scissors, Combine, Trash2, Check } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { dialogueText, editDialogue } from '../domain/subtitles';
import type { Dialogue, Job, Project } from '../domain/types';
import {
  cueBounds,
  editCueText,
  mergeDialogue,
  retimeDialogue,
  splitDialogue,
  type TimingRole,
} from '../domain/timing';
import { TranslationSuggestion } from './TranslationSuggestion';
import { IconButton } from './IconButton';
import { formatTime, parseTime } from '../domain/time';

export function Editor({
  dubbingActive,
  dubbing,
  onDubbing,
  onEditorTab,
  onDelete,
  project,
  selected,
  onEdit,
  onPlay,
  onDub,
  busy,
  time,
  translationFocus,
  jobs,
  snapshot,
  run,
}: {
  dubbingActive: boolean;
  dubbing: ReactNode;
  onDubbing: () => void;
  onEditorTab: () => void;
  onDelete: (line: Dialogue) => void;
  project: Project | null;
  selected: Dialogue | undefined;
  onEdit: (update: (p: Project) => Project) => void;
  onPlay: (d: Dialogue) => void;
  onDub: (d: Dialogue) => void;
  busy: boolean;
  time: number;
  translationFocus: number;
  jobs: Job[];
  snapshot: () => Promise<Project>;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'text' | 'tts'>('text');
  const targetField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (translationFocus) {
      setTab('text');
      onEditorTab();
      requestAnimationFrame(() => targetField.current?.focus());
    }
  }, [translationFocus, onEditorTab]);
  const target = project && selected ? dialogueText(project, selected, 'target') : '';
  const update = (role: 'source' | 'target' | 'tts', value: string) =>
    selected && onEdit((p) => editDialogue(p, selected.id, role, value));
  const tabs = ['text', 'tts', 'dub'] as const;
  const activeTab = dubbingActive ? 'dub' : tab;
  const activate = (value: (typeof tabs)[number]) => {
    if (value === 'dub') onDubbing();
    else {
      setTab(value);
      onEditorTab();
    }
  };
  return (
    <section className="editor">
      <div className="editor-header">
        <div className="editor-tabs" role="tablist" aria-label={t('dubbingInspector.tabs')}>
          {tabs.map((value, index) => {
            const Icon = value === 'text' ? Type : value === 'tts' ? Mic2 : AudioLines;
            return (
              <button
                key={value}
                role="tab"
                id={`inspector-tab-${value}`}
                aria-controls={value === 'dub' ? 'inspector-panel-dub' : 'inspector-panel-editor'}
                aria-selected={activeTab === value}
                tabIndex={activeTab === value ? 0 : -1}
                disabled={value === 'dub' && !project}
                className={activeTab === value ? 'active' : ''}
                onClick={() => activate(value)}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'ArrowRight'
                      ? (index + 1) % 3
                      : event.key === 'ArrowLeft'
                        ? (index + 2) % 3
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? 2
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const button =
                    event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                      '[role=tab]',
                    )[next];
                  if (!button.disabled) {
                    activate(tabs[next]);
                    button.focus();
                  }
                }}
              >
                <Icon size={13} aria-hidden="true" />
                {t(value === 'text' ? 'textTab' : value === 'tts' ? 'ttsTab' : 'dub')}
              </button>
            );
          })}
        </div>
        {project && selected && !dubbingActive && (
          <div className="editor-actions">
            <IconButton
              label={t('linePreview')}
              onClick={() => onPlay(selected)}
              disabled={!project.media}
            >
              <Play size={12} />
            </IconButton>
            <IconButton
              label={t('workbench.addDub')}
              disabled={busy || selected.excludedFromDubbing || !target.trim()}
              onClick={() => onDub(selected)}
            >
              <Mic2 size={14} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={t('dialogueDeleteTitle')}
              disabled={busy}
              onClick={() => onDelete(selected)}
            >
              <Trash2 size={14} aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </div>
      <div
        id="inspector-panel-editor"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${tab}`}
        hidden={dubbingActive}
        className="editor-content"
      >
        {project && selected ? (
          <>
            <TimingEditor
              key={selected.id}
              project={project}
              selected={selected}
              onEdit={onEdit}
              busy={busy}
              time={time}
            />
            {tab === 'text' && (
              <TranslationSuggestion
                key={`${project.id}:${selected.id}`}
                project={project}
                line={selected}
                jobs={jobs}
                snapshot={snapshot}
                run={run}
                onEdit={onEdit}
                busy={busy}
              />
            )}
            {tab === 'text' ? (
              <div className="editor-fields">
                {(['source', 'target'] as const).map((role) => {
                  const ids = role === 'source' ? selected.sourceCueIds : selected.targetCueIds;
                  const existing = (
                    role === 'source' ? project.sourceCues : project.targetCues
                  ).filter((cue) => ids.includes(cue.id));
                  const fields = existing.length ? existing : [{ id: '', text: '' }];
                  return (
                    <div className="cue-fields" key={role}>
                      {fields.map((cue, index, cues) => (
                        <label key={`${role}:${index}`}>
                          <span>
                            {t(role === 'source' ? 'original' : 'displayedText')}{' '}
                            <small>
                              {project.languages[role].toUpperCase()}
                              {cues.length > 1 ? ` · ${index + 1}/${cues.length}` : ''}
                            </small>
                          </span>
                          <textarea
                            ref={role === 'target' && index === 0 ? targetField : undefined}
                            aria-label={
                              t(role === 'source' ? 'original' : 'displayedText') +
                              (cues.length > 1 ? ` ${index + 1}` : '')
                            }
                            value={cue.text}
                            disabled={busy}
                            placeholder={t('translationPlaceholder')}
                            onChange={(event) =>
                              cue.id
                                ? onEdit((p) => editCueText(p, role, cue.id, event.target.value))
                                : update(role, event.target.value)
                            }
                          />
                        </label>
                      ))}
                    </div>
                  );
                })}
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
          </>
        ) : (
          <div className="empty-editor">
            <Type size={17} />
            <span>{t('selectLine')}</span>
          </div>
        )}
      </div>
      <div
        id="inspector-panel-dub"
        role="tabpanel"
        aria-labelledby="inspector-tab-dub"
        className="inspector-dubbing"
        hidden={!dubbingActive}
      >
        {dubbing}
      </div>
    </section>
  );
}

function TimingEditor({
  project,
  selected,
  onEdit,
  busy,
  time,
}: {
  project: Project;
  selected: Dialogue;
  onEdit: (update: (p: Project) => Project) => void;
  busy: boolean;
  time: number;
}) {
  const { t } = useTranslation();
  const [role, setRole] = useState<TimingRole>('both');
  const cues = [
    ...(role !== 'target'
      ? project.sourceCues.filter((c) => selected.sourceCueIds.includes(c.id))
      : []),
    ...(role !== 'source'
      ? project.targetCues.filter((c) => selected.targetCueIds.includes(c.id))
      : []),
  ];
  const bounds = cues.length ? cueBounds(cues) : selected;
  const next = [...project.dialogues]
    .sort((a, b) => a.startMs - b.startMs)
    .at(
      [...project.dialogues]
        .sort((a, b) => a.startMs - b.startMs)
        .findIndex((d) => d.id === selected.id) + 1,
    );
  return (
    <div className="timing-editor">
      <select
        aria-label={t('timingScope')}
        value={role}
        disabled={busy}
        onChange={(event) => setRole(event.target.value as TimingRole)}
      >
        <option value="both">{t('timingBoth')}</option>
        <option value="source">{t('original')}</option>
        <option value="target">{t('displayedText')}</option>
      </select>
      <TimingFields
        key={`${role}:${bounds.startMs}:${bounds.endMs}`}
        start={bounds.startMs}
        end={bounds.endMs}
        disabled={busy || !cues.length}
        apply={(start, end) => onEdit((p) => retimeDialogue(p, selected.id, start, end, role))}
      />
      <button
        className="text-button compact-action"
        title={t('splitHint')}
        aria-label={t('split')}
        disabled={busy || time < selected.startMs + 100 || time > selected.endMs - 100}
        onClick={() => onEdit((p) => splitDialogue(p, selected.id, time))}
      >
        <Scissors size={13} />
      </button>
      <button
        className="text-button compact-action"
        title={t('merge')}
        aria-label={t('merge')}
        disabled={busy || !next}
        onClick={() => onEdit((p) => mergeDialogue(p, selected.id))}
      >
        <Combine size={13} />
      </button>
    </div>
  );
}
function TimingFields({
  start,
  end,
  disabled,
  apply,
}: {
  start: number;
  end: number;
  disabled: boolean;
  apply: (start: number, end: number) => void;
}) {
  const { t } = useTranslation();
  const [from, setFrom] = useState(formatTime(start)),
    [to, setTo] = useState(formatTime(end));
  const [error, setError] = useState(false);
  return (
    <form
      className="timing-fields"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const a = parseTime(from),
            b = parseTime(to);
          if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b - a < 100)
            throw new Error();
          apply(a, b);
          setError(false);
        } catch {
          setError(true);
        }
      }}
    >
      <input
        aria-label={t('timingStart')}
        value={from}
        disabled={disabled}
        onChange={(event) => setFrom(event.target.value)}
        aria-invalid={error}
      />
      <span>→</span>
      <input
        aria-label={t('timingEnd')}
        value={to}
        disabled={disabled}
        onChange={(event) => setTo(event.target.value)}
        aria-invalid={error}
      />
      <button
        className="text-button compact-action"
        title={t('timingApply')}
        aria-label={t('timingApply')}
        disabled={disabled}
      >
        <Check size={14} />
      </button>
      {error && (
        <span className="warning" role="alert">
          {t('errors.INVALID_CUE_RANGE')}
        </span>
      )}
    </form>
  );
}
