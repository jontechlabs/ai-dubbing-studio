import { useEffect, useState, type RefObject } from 'react';
import { Check, Download, FileText, LoaderCircle, Terminal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AudioSelection,
  Dialogue,
  EnvironmentInfo,
  Generation,
  Job,
  Project,
} from '../domain/types';
import { APP_VERSION } from '../domain/project';
import { McpSettings } from './McpSettings';
import { jobProgress } from '../domain/batchProgress';
import { JobDuration } from './JobDuration';
import type { Panel } from './Header';
import { ImportPanel } from './ImportPanel';
import { IconButton } from './IconButton';
import { SubtitleImportPanel } from './SubtitleImportPanel';
import { AlignmentPanel } from './AlignmentPanel';
import { GraphicsSettings } from './GraphicsSettings';
import { UpdateSettings } from './UpdateSettings';
import type { Updater } from '../hooks/useUpdater';
import { AudioPanel } from './AudioPanel';
import { PlaybackMetrics } from './PlaybackMetrics';
import { CharactersPanel } from './CharactersPanel';
import { ModelsPanel } from './ModelsPanel';
import { DubPanel } from './DubPanel';
import { ModelStorageSettings } from './ModelStorageSettings';
import { MkvExportPanel } from './MkvExportPanel';
import { LipAnalysisPanel } from './LipAnalysisPanel';
import { InpaintPanel } from './InpaintPanel';
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
  updater,
  onEdit,
  videoRef,
  selectedId,
  batchIds,
  onPanel,
  audioSelection,
  toolboxModel,
  onPlayGeneration,
  onOriginal,
  activeGenerationId,
  onSelectDialogue,
}: {
  onSelectDialogue: (line: Dialogue) => void;
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
  updater: Updater;
  onEdit: (update: (project: Project) => Project) => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  selectedId: string | null;
  batchIds: string[];
  onPanel: (panel: Panel) => void;
  audioSelection: AudioSelection | null;
  toolboxModel?: string | null;
  onPlayGeneration: (generation: Generation) => void;
  onOriginal: (line: Dialogue) => void;
  activeGenerationId: string | null;
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
        className={`context-panel ${panel === 'alignment' || panel === 'lips' || panel === 'inpaint' || panel === 'inpaintBatch' || panel === 'characters' ? 'wide-panel' : ''}`}
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
        {(panel === 'dub' || panel === 'batchDub') && project && (
          <DubPanel
            onReferencePlay={() => {
              videoRef.current?.pause();
              document.dispatchEvent(new Event('studio-voice-preview'));
            }}
            key={`${project.id}:${panel}`}
            batch={panel === 'batchDub' ? { selectedIds: batchIds } : undefined}
            run={run}
            project={project}
            line={
              project.dialogues.find((d) => d.id === selectedId) ??
              (panel === 'batchDub' ? project.dialogues[0] : undefined)
            }
            jobs={jobs}
            onEdit={onEdit}
            snapshot={snapshot}
            onError={onError}
            onModels={() => onPanel('models')}
            onCharacters={() => onPanel('characters')}
            onLips={() => onPanel('lips')}
            onInpaint={() => onPanel('inpaint')}
            onOriginal={onOriginal}
            onPlay={onPlayGeneration}
            activeGenerationId={activeGenerationId}
          />
        )}
        {panel === 'lips' && project && (
          <LipAnalysisPanel
            project={project}
            line={project.dialogues.find((d) => d.id === selectedId)}
            jobs={jobs}
            snapshot={snapshot}
            applySnapshot={applySnapshot}
            onError={onError}
          />
        )}
        {(panel === 'inpaint' || panel === 'inpaintBatch') && project && (
          <InpaintPanel
            key={`${project.id}:${selectedId}`}
            project={project}
            line={project.dialogues.find((d) => d.id === selectedId)}
            batch={panel === 'inpaintBatch' ? { selectedIds: batchIds } : undefined}
            onStarted={showJobs}
            jobs={jobs}
            snapshot={snapshot}
            onEdit={onEdit}
            onError={onError}
          />
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
            onError={onError}
            jobs={jobs}
            padding={padding}
            setPadding={setPadding}
            theme={theme}
            setTheme={setTheme}
            updater={updater}
            videoRef={videoRef}
          />
        )}
        {panel === 'jobs' && <JobsPanel jobs={jobs} onError={onError} />}
        {panel === 'characters' && project && (
          <CharactersPanel
            onAudition={() => videoRef.current?.pause()}
            selection={audioSelection?.mediaId === project.media?.id ? audioSelection : null}
            snapshot={snapshot}
            applySnapshot={applySnapshot}
            onNavigate={(line) => {
              onSelectDialogue(line);
              close();
            }}
            project={project}
            jobs={jobs}
            selectedId={selectedId}
            onEdit={onEdit}
            run={run}
            showJobs={showJobs}
            onModels={() => onPanel('models')}
            onError={onError}
          />
        )}
        {panel === 'models' && (
          <ModelsPanel
            project={project}
            jobs={jobs}
            onEdit={onEdit}
            showJobs={showJobs}
            onAudio={() => onPanel('audio')}
            onError={onError}
          />
        )}
        {panel === 'audio' && (
          <AudioPanel
            toolboxModel={toolboxModel}
            snapshot={snapshot}
            selection={audioSelection?.mediaId === project?.media?.id ? audioSelection : null}
            selected={project?.dialogues.find((line) => line.id === selectedId)}
            videoRef={videoRef}
            project={project}
            jobs={jobs}
            run={run}
            onEdit={onEdit}
            showJobs={showJobs}
            onError={onError}
          />
        )}
        {panel === 'export' && project && (
          <div className="panel-body">
            <MkvExportPanel
              project={project}
              snapshot={snapshot}
              onEdit={onEdit}
              onError={onError}
              showJobs={showJobs}
              busy={busy || jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status))}
            />
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
  onError,
  jobs,
  padding,
  setPadding,
  theme,
  setTheme,
  updater,
  videoRef,
}: {
  onError: (message: string) => void;
  jobs: Job[];
  padding: number;
  setPadding: (n: number) => void;
  theme: string;
  setTheme: (s: string) => void;
  updater: Updater;
  videoRef: RefObject<HTMLVideoElement | null>;
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
      <ModelStorageSettings jobs={jobs} onError={onError} />
      <McpSettings />
      <UpdateSettings
        updater={updater}
        busy={jobs.some((job) => ['queued', 'running', 'paused'].includes(job.status))}
      />
      <GraphicsSettings />
      <PlaybackMetrics videoRef={videoRef} />
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
            ) : ['running', 'queued', 'paused'].includes(job.status) ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Terminal size={16} />
            )}
            <strong>
              {job.batch && `${t(job.kind === 'inpaintBatch' ? 'inpaintBatch' : 'batchDub')} · `}
              {t(
                job.status === 'paused'
                  ? 'jobStages.separationPaused'
                  : job.status === 'queued'
                    ? 'jobQueued'
                    : `jobStages.${job.stage}`,
              )}
            </strong>
            <span>
              {jobProgress(job) === null ? '' : `${Math.round(jobProgress(job)! * 100)}%`}
            </span>
          </div>
          <progress value={jobProgress(job) ?? undefined} max="1" />
          <JobDuration job={job} />
          {job.batch && (
            <p className="batch-job-summary">
              {t('batchJobSummary', {
                completed: job.batch.completed,
                total: job.batch.total,
                succeeded: job.batch.succeeded,
                failed: job.batch.failed,
                skipped: job.batch.skipped,
              })}
            </p>
          )}
          <span>
            {t(
              job.status === 'succeeded'
                ? 'jobDone'
                : job.status === 'paused'
                  ? 'jobStages.separationPaused'
                  : job.status === 'failed'
                    ? 'jobFailed'
                    : job.status === 'cancelled' || job.status === 'interrupted'
                      ? 'jobCancelled'
                      : job.status === 'queued'
                        ? 'jobQueued'
                        : 'jobRunning',
            )}
          </span>
          {['running', 'queued', 'paused'].includes(job.status) && (
            <button
              disabled={job.kind === 'modelMove' && job.stage === 'modelCommit'}
              className="text-button"
              onClick={() => {
                void bridge.cancelJob(job.id).catch((e) => onError(String(e)));
              }}
            >
              {t('cancel')}
            </button>
          )}
          {[
            'import',
            'separation',
            'runtime',
            'speakerInstall',
            'speakers',
            'ttsInstall',
            'tts',
            'ttsBatch',
            'mkvExport',
            'referenceTranscription',
            'translationInstall',
            'translationSuggest',
            'lipAnalysis',
            'inpaint',
            'inpaintInstall',
            'inpaintBatch',
            'faceDetection',
            'audioTransfer',
            'prosodyTransfer',
            'audioEffects',
          ].includes(job.kind) &&
            ['failed', 'cancelled', 'interrupted'].includes(job.status) && (
              <button
                className="text-button"
                onClick={() => {
                  void bridge.retryJob(job.id).catch((e) => onError(String(e)));
                }}
              >
                {t('retry')}
              </button>
            )}
          {job.kind === 'separation' && ['running', 'paused'].includes(job.status) && (
            <button
              className="text-button"
              onClick={() =>
                void bridge
                  .pauseJob(job.id, job.status !== 'paused')
                  .catch((error) => onError(String(error)))
              }
            >
              {t(job.status === 'paused' ? 'resumeJob' : 'pauseJob')}
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
