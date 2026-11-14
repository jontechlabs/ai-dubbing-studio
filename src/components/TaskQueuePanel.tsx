import { useState } from 'react';
import {
  ArrowUp,
  ArrowDown,
  ListOrdered,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkflowQueue } from '../domain/taskQueue';
import type { Job, Project } from '../domain/types';
import { IconButton } from './IconButton';
import { CurrentJobProgress } from './CurrentJobProgress';
import { BatchRecovery } from './BatchRecovery';
import * as bridge from '../services/bridge';
export function TaskQueuePanel({
  queue,
  project,
  jobs,
  snapshot,
  onChooseLine,
}: {
  queue: { data: WorkflowQueue | null; error: string; refresh: () => Promise<void> };
  project: Project | null;
  jobs: Job[];
  snapshot: () => Promise<Project>;
  onChooseLine: (id: string) => void;
}) {
  const { t } = useTranslation(),
    { data, error, refresh } = queue;
  const [working, setWorking] = useState(false),
    [localError, setError] = useState('');
  const [dismissed, setDismissed] = useState<string[]>([]);
  const act = async (action: Parameters<typeof bridge.controlTaskQueue>[0], id?: string) => {
    setWorking(true);
    setError('');
    try {
      await bridge.controlTaskQueue(action, id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="panel-body task-queue-panel">
      <p className="panel-description">{t('workflow.queueHint')}</p>
      <div className="compact-toolbar">
        <button
          className="button accent"
          disabled={!data || working || !!data.warning}
          onClick={() => void act(data!.paused ? 'resume' : 'pause')}
        >
          {data?.paused ? <Play size={14} /> : <Pause size={14} />}{' '}
          {t(data?.paused ? 'workflow.resume' : 'workflow.pause')}
        </button>
        <IconButton label={t('workflow.refresh')} disabled={working} onClick={() => void refresh()}>
          <RefreshCw size={14} />
        </IconButton>
        <IconButton
          label={t('workflow.clear')}
          disabled={
            working ||
            (!data?.entries.some((e) => !['pending', 'running'].includes(e.status)) &&
              !data?.warning)
          }
          onClick={() => void act('clear')}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
      {(error || localError || data?.warning) && (
        <p role="alert" className="warning">
          {t(`errors.${(localError || error || data?.warning || '').replace(/^Error: /, '')}`, {
            defaultValue: localError || error || data?.warning,
          })}
        </p>
      )}
      {!data ? (
        <p role="status">{t('workflow.loading')}</p>
      ) : (
        !data.entries.length && <p>{t('workflow.empty')}</p>
      )}
      {data?.entries.map((e) => {
        const active = e.status === 'running',
          job = jobs.find((j) => j.id === e.currentJobId);
        return (
          <section className="queue-entry settings-section" key={e.id} data-queue-id={e.id}>
            <div className="queue-entry-heading">
              <strong>
                <ListOrdered size={14} /> {e.name}
              </strong>
              <span className={'queue-state ' + e.status}>{t('workflow.status.' + e.status)}</span>
            </div>
            <small>
              {e.projectName} · {new Date(e.createdAt).toLocaleString()}
            </small>
            <p>
              {t(
                e.separation
                  ? e.dubbing
                    ? 'workflow.separateDub'
                    : 'workflow.separate'
                  : 'workflow.dub',
              )}{' '}
              · {t('workflow.lineCount', { count: e.total })}
            </p>
            {e.separation && (
              <small>
                {t('workflow.separationProgress', {
                  done: e.completed,
                  total: e.total,
                  failed: e.failed,
                })}
              </small>
            )}
            {active && <CurrentJobProgress job={job} starting={!job} onError={setError} />}
            {e.error && (
              <p role="alert" className="warning">
                {t('errors.' + e.error, { defaultValue: e.error })}
              </p>
            )}
            {!!e.problems.length && (
              <details>
                <summary>{t('workflow.problems')}</summary>
                <ul>
                  {e.problems.map((p, i) => (
                    <li key={i}>
                      {p.lineId && (
                        <button className="text-button" onClick={() => onChooseLine(p.lineId!)}>
                          #{(project?.dialogues.findIndex((l) => l.id === p.lineId) ?? -1) + 1}
                        </button>
                      )}{' '}
                      {t('errors.' + p.error, { defaultValue: p.error })}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {project?.id === e.projectId && !!e.batchIds.length && (
              <details>
                <summary>{t('workflow.batchResults')}</summary>
                {e.batchIds
                  .filter((id) => !dismissed.includes(id))
                  .map((id) => (
                    <BatchRecovery
                      key={id}
                      reportId={id}
                      project={project}
                      busy={
                        active ||
                        working ||
                        jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status))
                      }
                      starting={false}
                      job={jobs.find((j) => j.id === id)}
                      startTask={async (op) => op()}
                      snapshot={snapshot}
                      onDismiss={() => setDismissed((old) => [...old, id])}
                      onError={setError}
                      onChooseLine={onChooseLine}
                    />
                  ))}
              </details>
            )}
            <div className="compact-toolbar">
              {e.status === 'pending' && (
                <>
                  <IconButton
                    label={t('workflow.up')}
                    disabled={working}
                    onClick={() => void act('up', e.id)}
                  >
                    <ArrowUp size={14} />
                  </IconButton>
                  <IconButton
                    label={t('workflow.down')}
                    disabled={working}
                    onClick={() => void act('down', e.id)}
                  >
                    <ArrowDown size={14} />
                  </IconButton>
                </>
              )}
              {['pending', 'running'].includes(e.status) ? (
                <IconButton
                  label={t('workflow.cancel')}
                  disabled={working}
                  onClick={() => void act('cancel', e.id)}
                >
                  <Square size={14} />
                </IconButton>
              ) : (
                <>
                  {['failed', 'partial', 'cancelled', 'interrupted'].includes(e.status) && (
                    <IconButton
                      label={t('workflow.retry')}
                      disabled={working}
                      onClick={() => void act('retry', e.id)}
                    >
                      <RefreshCw size={14} />
                    </IconButton>
                  )}
                  <IconButton
                    label={t('workflow.remove')}
                    disabled={working}
                    onClick={() => void act('remove', e.id)}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
