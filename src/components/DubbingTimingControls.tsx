import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Project } from '../domain/types';
import {
  dubbingBounds,
  dubbingDuration,
  dubbingOffset,
  moveDubbing,
  recoverDubbing,
  resizeDubbing,
} from '../domain/mix';

export function DubbingTimingControls({
  project,
  line,
  busy,
  onEdit,
}: {
  project: Project;
  line: Dialogue;
  busy: boolean;
  onEdit: (update: (p: Project) => Project) => void;
}) {
  const { t } = useTranslation();
  const limits = dubbingBounds(project, line.id),
    offset = dubbingOffset(project, line.id),
    duration = dubbingDuration(project, line.id) ?? limits.duration;
  const [draft, setDraft] = useState({ offset: String(offset), duration: String(duration) }),
    [error, setError] = useState('');
  useEffect(() => {
    setDraft({ offset: String(offset), duration: String(duration) });
    setError('');
  }, [project.id, line.id, project.languages.target, offset, duration]);
  const action = (operation: (p: Project) => Project) => {
    try {
      operation(project);
      onEdit(operation);
      setError('');
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''));
      setDraft({ offset: String(offset), duration: String(duration) });
    }
  };
  const commit = (key: 'offset' | 'duration', text: string) => {
    if (!text.trim()) {
      setDraft({ offset: String(offset), duration: String(duration) });
      return;
    }
    const n = Number(text);
    if (n === (key === 'offset' ? offset : duration)) return;
    action((p) => (key === 'offset' ? moveDubbing(p, line.id, n) : resizeDubbing(p, line.id, n)));
  };
  return (
    <>
      {(['offset', 'duration'] as const).map((key) => (
        <label className="field" key={key}>
          <span>{t(key === 'offset' ? 'dubbingOffset' : 'dubbingDuration')}</span>
          <input
            type="number"
            step="1"
            min={key === 'offset' ? -line.startMs : limits.min}
            max={
              key === 'offset'
                ? project.media!.durationMs - limits.duration - line.startMs
                : limits.max
            }
            value={draft[key]}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            onBlur={(e) => commit(key, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
              }
              if (e.key === 'Escape') {
                e.currentTarget.value = String(key === 'offset' ? offset : duration);
                setDraft({ offset: String(offset), duration: String(duration) });
                setError('');
              }
              if (e.key === 'Escape' || e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </label>
      ))}
      <div className="voice-timing-actions">
        <button
          className="text-button"
          disabled={busy || offset === 0}
          onClick={() => action((p) => moveDubbing(p, line.id, 0))}
        >
          {t('dubbingResetOffset')}
        </button>
        <button
          className="text-button"
          disabled={busy || dubbingDuration(project, line.id) === undefined}
          onClick={() => action((p) => resizeDubbing(p, line.id, null))}
        >
          {t('dubbingAutoDuration')}
        </button>
      </div>
      <p className="panel-description">
        {t('dubbingDurationHint')} {t('voiceTimingCommitHint')}
      </p>
      <p role="status">
        {t('voiceDurationLimits', { duration: limits.duration, max: limits.max })}
      </p>
      {limits.limited && (
        <div role="alert">
          <p>{t('voiceTimingLimited')}</p>
          <button
            className="button subtle"
            disabled={busy}
            onClick={() => action((p) => recoverDubbing(p, line.id))}
          >
            {t('voiceRecoverTiming')}
          </button>
        </div>
      )}
      {error && <p role="alert">{t(`errors.${error}`, { defaultValue: t('errors.UNKNOWN') })}</p>}
    </>
  );
}
