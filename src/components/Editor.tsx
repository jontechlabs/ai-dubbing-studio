import { Mic2, Play, Type, Scissors, Combine } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dialogueText, editDialogue } from '../domain/subtitles';
import type { Dialogue, Project } from '../domain/types';
import {
  cueBounds,
  editCueText,
  mergeDialogue,
  retimeDialogue,
  splitDialogue,
  type TimingRole,
} from '../domain/timing';
import { formatTime, parseTime } from '../domain/time';

export function Editor({
  project,
  selected,
  onEdit,
  onPlay,
  busy,
  time,
  translationFocus,
}: {
  project: Project | null;
  selected: Dialogue | undefined;
  onEdit: (update: (p: Project) => Project) => void;
  onPlay: (d: Dialogue) => void;
  busy: boolean;
  time: number;
  translationFocus: number;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'text' | 'tts'>('text');
  const targetField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (translationFocus) {
      setTab('text');
      requestAnimationFrame(() => targetField.current?.focus());
    }
  }, [translationFocus]);
  if (!project || !selected)
    return (
      <div className="editor empty-editor">
        <Type size={17} />
        <span>{t('selectLine')}</span>
      </div>
    );
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
      <TimingEditor
        key={selected.id}
        project={project}
        selected={selected}
        onEdit={onEdit}
        busy={busy}
        time={time}
      />
      {tab === 'text' ? (
        <div className="editor-fields">
          {(['source', 'target'] as const).map((role) => {
            const ids = role === 'source' ? selected.sourceCueIds : selected.targetCueIds;
            const existing = (role === 'source' ? project.sourceCues : project.targetCues).filter(
              (cue) => ids.includes(cue.id),
            );
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
        className="text-button"
        title={t('splitHint')}
        disabled={busy || time < selected.startMs + 100 || time > selected.endMs - 100}
        onClick={() => onEdit((p) => splitDialogue(p, selected.id, time))}
      >
        <Scissors size={13} />
        {t('split')}
      </button>
      <button
        className="text-button"
        disabled={busy || !next}
        onClick={() => onEdit((p) => mergeDialogue(p, selected.id))}
      >
        <Combine size={13} />
        {t('merge')}
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
      <button className="text-button" disabled={disabled}>
        {t('timingApply')}
      </button>
      {error && (
        <span className="warning" role="alert">
          {t('errors.INVALID_CUE_RANGE')}
        </span>
      )}
    </form>
  );
}
