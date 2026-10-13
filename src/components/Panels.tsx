import { useEffect, useState } from 'react';
import { Check, Download, FileText, LoaderCircle, RefreshCw, Terminal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EnvironmentInfo, Job, Project } from '../domain/types';
import { APP_VERSION } from '../domain/project';
import type { Panel } from './Header';
import { ImportPanel } from './ImportPanel';
import { IconButton } from './IconButton';
import { SubtitleImportPanel } from './SubtitleImportPanel';
import { AlignmentPanel } from './AlignmentPanel';
import * as bridge from '../services/bridge';
import { downloadText } from '../services/browserStore';

export function Panels({
  panel,
  project,
  jobs,
  run,
  close,
  closeSubtitles,
  showJobs,
  subtitleRole,
  onError,
  padding,
  setPadding,
  theme,
  setTheme,
  snapshot,
  applySnapshot,
  busy,
}: {
  panel: Panel;
  project: Project | null;
  jobs: Job[];
  run: (op: () => Promise<Project | null>) => Promise<void>;
  close: () => void;
  closeSubtitles: () => void;
  showJobs: () => void;
  subtitleRole: 'source' | 'target';
  onError: (message: string) => void;
  padding: number;
  setPadding: (n: number) => void;
  theme: string;
  setTheme: (s: string) => void;
  snapshot: () => Promise<Project>;
  applySnapshot: (before: Project, after: Project) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const title =
    panel === 'import'
      ? 'importTitle'
      : panel === 'subtitles'
        ? subtitleRole === 'source'
          ? 'importSource'
          : 'importTarget'
        : (panel ?? '');
  useEffect(() => {
    if (!panel) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [panel, close]);
  if (!panel) return null;
  return (
    <div
      className="panel-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <aside
        className={`context-panel ${panel === 'alignment' ? 'wide-panel' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t(title)}
      >
        <div className="panel-title">
          <h2>{t(title)}</h2>
          <IconButton label={t('close')} onClick={close}>
            <X size={19} />
          </IconButton>
        </div>
        {panel === 'import' && (
          <ImportPanel run={run} onClose={close} onStarted={showJobs} onError={onError} />
        )}
        {panel === 'alignment' && project && (
          <AlignmentPanel
            project={project}
            snapshot={snapshot}
            applySnapshot={applySnapshot}
            busy={busy}
          />
        )}
        {panel === 'subtitles' && project && (
          <SubtitleImportPanel
            project={project}
            role={subtitleRole}
            run={run}
            close={closeSubtitles}
          />
        )}
        {panel === 'settings' && (
          <SettingsPanel
            jobs={jobs}
            padding={padding}
            setPadding={setPadding}
            theme={theme}
            setTheme={setTheme}
          />
        )}
        {panel === 'jobs' && <JobsPanel jobs={jobs} onError={onError} />}
        {panel === 'audio' && (
          <div className="panel-body">
            <p className="panel-description">{t('audioHint')}</p>
            <h3>{t('mediaInfo')}</h3>
            <strong>{project?.media?.originalName}</strong>
            <div className="stream-list">
              {project?.media?.streams.map((s) => (
                <div key={s.index}>
                  <span className="stream-kind">{s.kind}</span>
                  <strong>{s.codec.toUpperCase()}</strong>
                  <small>
                    {s.language} {s.width ? `${s.width} × ${s.height}` : ''}{' '}
                    {s.channels ? `${s.channels} ch` : ''}
                  </small>
                  {s.bitmap && <small className="warning">{t('bitmap')}</small>}
                </div>
              ))}
            </div>
            <button
              className="button accent wide"
              disabled={
                !bridge.native ||
                jobs.some(
                  (j) =>
                    ['import', 'subtitles'].includes(j.kind) &&
                    ['running', 'queued'].includes(j.status),
                )
              }
              onClick={() => {
                void run(async () => {
                  await bridge.prepareProxy();
                  showJobs();
                  return null;
                });
              }}
            >
              <RefreshCw size={15} />
              {t('prepareProxy')}
            </button>
          </div>
        )}
        {panel === 'export' && project && (
          <div className="panel-body">
            <p className="panel-description">{t('exportHint')}</p>
            {(['source', 'target'] as const).map((role) => (
              <button
                className="export-choice"
                key={role}
                disabled={!project[role === 'source' ? 'sourceCues' : 'targetCues'].length}
                onClick={() => {
                  void run(async () => {
                    await bridge.exportSubtitles(project, role);
                    return null;
                  });
                }}
              >
                <FileText size={20} />
                <span>{t(role === 'source' ? 'exportSource' : 'exportTarget')}</span>
                <Download size={15} />
              </button>
            ))}
            {!bridge.native && (
              <button
                className="export-choice"
                onClick={() => downloadText('project.json', JSON.stringify(project, null, 2))}
              >
                <FileText size={20} />
                <span>{t('exportProject')}</span>
                <Download size={15} />
              </button>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
function SettingsPanel({
  jobs,
  padding,
  setPadding,
  theme,
  setTheme,
}: {
  jobs: Job[];
  padding: number;
  setPadding: (n: number) => void;
  theme: string;
  setTheme: (s: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void bridge.environment().then(setEnv);
  }, []);
  const diagnostic = JSON.stringify(
    { version: APP_VERSION, environment: env, commandErrors: bridge.diagnosticErrors(), jobs },
    null,
    2,
  );
  return (
    <div className="panel-body">
      <label className="field">
        <span>{t('language')}</span>
        <select
          value={i18n.resolvedLanguage}
          onChange={(e) => {
            localStorage.setItem('studio.language', e.target.value);
            void i18n.changeLanguage(e.target.value);
          }}
        >
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
      </label>
      <label className="field">
        <span>{t('theme')}</span>
        <select value={theme} onChange={(e) => setTheme(e.target.value)}>
          <option value="dark">{t('dark')}</option>
          <option value="light">{t('light')}</option>
        </select>
      </label>
      <label className="field">
        <span>{t('loopPadding')}</span>
        <input
          type="number"
          min="0"
          max="5000"
          step="50"
          value={padding}
          onChange={(e) => setPadding(Math.min(5000, Math.max(0, Number(e.target.value))))}
        />
      </label>
      <div className="diagnostics">
        <h3>
          <Terminal size={15} />
          {t('diagnostics')}
        </h3>
        <div className="diagnostic-status">
          <span>{env?.platform}</span>
          <span>FFmpeg {env?.ffmpeg ? '✓' : '—'}</span>
          <span>FFprobe {env?.ffprobe ? '✓' : '—'}</span>
        </div>
        <pre>{diagnostic}</pre>
        <button
          className="button subtle"
          onClick={() => {
            void navigator.clipboard.writeText(diagnostic).then(() => setCopied(true));
          }}
        >
          {t(copied ? 'copied' : 'copyDiagnostics')}
        </button>
        <button
          className="button subtle"
          onClick={() => {
            void bridge.exportReport('diagnostic.json', diagnostic);
          }}
        >
          {t('exportDiagnostics')}
        </button>
      </div>
    </div>
  );
}
function JobsPanel({ jobs, onError }: { jobs: Job[]; onError: (s: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="panel-body">
      {!jobs.length && <p>{t('noJobs')}</p>}
      {jobs.map((job) => (
        <div className="job-card" key={job.id}>
          <div className="job-card-title">
            {job.status === 'succeeded' ? (
              <Check size={16} />
            ) : ['running', 'queued'].includes(job.status) ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Terminal size={16} />
            )}
            <strong>{t(job.status === 'queued' ? 'jobQueued' : `jobStages.${job.stage}`)}</strong>
            <span>{job.progress === null ? '' : `${Math.round(job.progress * 100)}%`}</span>
          </div>
          <progress value={job.progress ?? undefined} max="1" />
          <span>
            {t(
              job.status === 'succeeded'
                ? 'jobDone'
                : job.status === 'failed'
                  ? 'jobFailed'
                  : job.status === 'cancelled' || job.status === 'interrupted'
                    ? 'jobCancelled'
                    : 'jobRunning',
            )}
          </span>
          {['running', 'queued'].includes(job.status) && (
            <button
              className="text-button"
              onClick={() => {
                void bridge.cancelJob(job.id).catch((e) => onError(String(e)));
              }}
            >
              {t('cancel')}
            </button>
          )}
          {job.kind === 'import' && ['failed', 'cancelled', 'interrupted'].includes(job.status) && (
            <button
              className="text-button"
              onClick={() => {
                void bridge.retryJob(job.id).catch((e) => onError(String(e)));
              }}
            >
              {t('retry')}
            </button>
          )}
          <details>
            <summary>{t('logs')}</summary>
            <pre>{[job.error, ...job.logs].filter(Boolean).join('\n')}</pre>
          </details>
        </div>
      ))}
    </div>
  );
}
