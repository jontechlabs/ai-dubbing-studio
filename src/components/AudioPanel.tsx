import { removeEffectsTrack } from '../domain/audioEffects';
import { useEffect, useState } from 'react';
import { Download, LoaderCircle, RefreshCw, Scissors, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AudioSelection, Dialogue, Job, Project } from '../domain/types';
import type { RefObject } from 'react';
import { AudioQuickControls } from './AudioQuickControls';
import { AudioRegionsEditor } from './AudioRegionsEditor';
import { AudioEffectsPanel } from './AudioEffectsPanel';
import { AudioMeter } from './AudioMeter';
import { useAudioLevels } from '../hooks/useAudioLevels';
import { audioTracks, editTrack, trackLabel, dubbingMix } from '../domain/audio';
import { setAudioSource } from '../domain/audioPatch';
import { mixReport } from '../domain/mix';
import * as bridge from '../services/bridge';
export function AudioPanel({
  project,
  jobs,
  run,
  onEdit,
  showJobs,
  onError,
  selection,
  selected,
  videoRef,
}: {
  project: Project | null;
  jobs: Job[];
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  onEdit: (update: (project: Project) => Project) => void;
  showJobs: () => void;
  onError: (error: string) => void;
  selection: AudioSelection | null;
  selected?: Dialogue;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const { t } = useTranslation();
  const levels = useAudioLevels();
  const [runtime, setRuntime] = useState<Awaited<
    ReturnType<typeof bridge.separationStatus>
  > | null>(null);
  const [device, setDevice] = useState(localStorage.getItem('studio.separationDevice') ?? 'auto');
  const [cuda, setCuda] = useState(false),
    [working, setWorking] = useState(false);
  const [repairRuntime, setRepairRuntime] = useState(false);
  const runtimeCompletion = jobs
    .filter(
      (job) =>
        ['runtime', 'modelMove'].includes(job.kind) &&
        ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status),
    )
    .map((job) => `${job.id}:${job.status}`)
    .sort()
    .join(',');
  const active = jobs.some(
    (job) =>
      [
        'runtime',
        'separation',
        'import',
        'subtitles',
        'speakerInstall',
        'speakers',
        'modelMove',
        'audioTransfer',
        'audioEffects',
        'tts',
        'ttsInstall',
        'voiceInstall',
        'inpaint',
        'inpaintInstall',
      ].includes(job.kind) && ['running', 'queued', 'paused'].includes(job.status),
  );
  useEffect(() => {
    let disposed = false;
    if (bridge.native)
      void bridge
        .separationStatus()
        .then((result) => {
          if (!disposed) {
            setRuntime(result);
            setCuda(!!result.cudaVersion);
          }
        })
        .catch((error) => {
          if (!disposed) onError(String(error));
        });
    return () => {
      disposed = true;
    };
  }, [onError, runtimeCompletion]);
  const tracks = project ? audioTracks(project) : [];
  const selectedDevice =
    device === 'auto' || runtime?.devices.some((entry) => entry.id === device) ? device : 'auto';
  return (
    <div className="panel-body audio-panel">
      <h3>{t('separationTitle')}</h3>
      <p className="panel-description">{t('separationHint')}</p>
      {runtime?.deviceProbeWarning && (
        <p className="warning" role="alert">
          {t(`errors.${runtime.deviceProbeWarning}`)}
        </p>
      )}
      {runtime?.unavailableDevices?.map((entry) => (
        <p className="warning" role="alert" key={entry.id}>
          {t('runtimeDeviceUnavailable', { name: entry.name })}
        </p>
      ))}
      {(!runtime?.installed || repairRuntime) && (
        <div className="runtime-card">
          <strong>Bandit v2 Multilingual</strong>
          <p>{t('runtimeHint')}</p>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={cuda}
              disabled={active || working}
              onChange={(event) => setCuda(event.target.checked)}
            />
            {t('runtimeCuda')}
          </label>
          <button
            className="button accent wide"
            disabled={!bridge.native || active || working}
            onClick={() => {
              setWorking(true);
              void bridge
                .installSeparationRuntime(cuda)
                .then(showJobs)
                .catch((error) => onError(String(error)))
                .finally(() => setWorking(false));
            }}
          >
            <Download size={15} />
            {t(runtime?.installed ? 'runtimeReinstall' : 'runtimeInstall')}
          </button>
        </div>
      )}
      <button
        className="text-button"
        disabled={!bridge.native || active || working}
        onClick={() => {
          setWorking(true);
          void bridge
            .separationStatus()
            .then(setRuntime)
            .catch((error) => onError(String(error)))
            .finally(() => setWorking(false));
        }}
      >
        <RefreshCw size={13} />
        {t('runtimeRefresh')}
      </button>
      {runtime?.installed && (
        <>
          <label className="field">
            <span>{t('separationDevice')}</span>
            <select
              value={selectedDevice}
              disabled={active}
              onChange={(event) => {
                setDevice(event.target.value);
                localStorage.setItem('studio.separationDevice', event.target.value);
              }}
            >
              <option value="auto">{t('graphicsAuto')}</option>
              {runtime.devices.map((entry) => (
                <option value={entry.id} key={entry.id}>
                  {entry.name} ({entry.id})
                </option>
              ))}
            </select>
          </label>
          <button
            className="button accent wide"
            disabled={!project?.media || active || working}
            onClick={() => {
              void run(async () => {
                await bridge.separateAudio(runtime?.deviceProbeWarning ? 'cpu' : selectedDevice);
                showJobs();
                return null;
              });
            }}
          >
            {working ? <LoaderCircle className="spin" size={15} /> : <Scissors size={15} />}{' '}
            {t('separateAudio')}
          </button>
          <button
            className="text-button"
            disabled={active || working}
            onClick={() => setRepairRuntime(!repairRuntime)}
          >
            {t('runtimeModify')}
          </button>
        </>
      )}
      <p className="panel-description">{t('separationQuality')}</p>
      {!!tracks.length && (
        <>
          <h3>{t('audioMixer')}</h3>
          {project && (
            <section className="settings-section">
              {(['referenceTrackId', 'dubbingSourceTrackId'] as const).map((key) => (
                <label className="field" key={key}>
                  <span>
                    {t(key === 'referenceTrackId' ? 'referenceTrack' : 'replacementTrack')}
                  </span>
                  <select
                    value={project.modelPreferences?.[key] ?? 'auto'}
                    onChange={(e) => onEdit((p) => setAudioSource(p, key, e.target.value))}
                  >
                    <option value="auto">{t('referenceTrackDefault')}</option>
                    {tracks
                      .filter((t) => t.kind !== 'dubbing')
                      .map((track) => (
                        <option key={track.id} value={track.id}>
                          {t(trackLabel(track))}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              <p className="panel-description">{t('audioSourceHint')}</p>
            </section>
          )}

          {!!project && !!mixReport(project).clips.length && (
            <>
              <button
                className="button accent wide"
                onClick={() => {
                  videoRef.current?.pause();
                  onEdit(dubbingMix);
                }}
              >
                {t('prepareDubbingMix')}
              </button>
              <p className="panel-description">{t('dubbingMixHint')}</p>
            </>
          )}
          <p className="panel-description">{t('mixerHint')}</p>
          <section className="audio-levels-overview">
            <h4>{t('meterTitle')}</h4>
            <p className="panel-description">{t('meterHint')}</p>
            <AudioMeter name={t('meterMix')} />
            <button className="text-button" onClick={() => levels.reset()}>
              {t('meterResetAll')}
            </button>
          </section>
          <AudioQuickControls project={project!} onEdit={onEdit} />
          <p className="panel-description">{t('quickAudioHint')}</p>
          <div className="audio-mixer">
            {tracks.map((track) => (
              <div className="mixer-track" key={track.id}>
                <div className="mixer-row">
                  <strong>{t(trackLabel(track))}</strong>
                  <button
                    className={`mixer-toggle ${!track.mute ? 'active' : ''}`}
                    aria-pressed={!track.mute}
                    aria-label={t(track.mute ? 'enableTrack' : 'muteTrack', {
                      name: t(trackLabel(track)),
                    })}
                    onClick={() => onEdit((p) => editTrack(p, track.id, { mute: !track.mute }))}
                  >
                    {track.mute ? <VolumeX size={14} /> : <Volume2 size={14} />}
                  </button>
                  <button
                    className={`mixer-toggle ${track.solo ? 'active' : ''}`}
                    aria-pressed={track.solo}
                    aria-label={`${t('solo')} ${t(trackLabel(track))}`}
                    onClick={() => onEdit((p) => editTrack(p, track.id, { solo: !track.solo }))}
                  >
                    S
                  </button>
                  <input
                    aria-label={`${t('trackGain')} ${t(trackLabel(track))}`}
                    type="range"
                    min="0"
                    max="4"
                    step="0.05"
                    value={track.gain}
                    onChange={(event) =>
                      onEdit((p) => editTrack(p, track.id, { gain: Number(event.target.value) }))
                    }
                  />
                  <span>{Math.round(track.gain * 100)}%</span>
                  {project!.generations.some(
                    (g) => g.kind === 'audioEffects' && g.trackId === track.id,
                  ) && (
                    <button
                      className="text-button"
                      disabled={
                        active ||
                        project!.generations.some(
                          (g) => g.kind === 'audioEffects' && g.sourceTrackId === track.id,
                        )
                      }
                      aria-label={t('fxRemoveTrack', { name: t(trackLabel(track)) })}
                      onClick={() => onEdit((p) => removeEffectsTrack(p, track.id))}
                    >
                      × FX
                    </button>
                  )}
                  {track.kind === 'audio' && (
                    <button
                      className="mixer-export"
                      aria-label={t('exportSourceTrack', { name: t(trackLabel(track)) })}
                      onClick={() =>
                        void run(async () => {
                          await bridge.exportAudioTrack(project!, track.id);
                          return null;
                        })
                      }
                    >
                      <Download size={14} />
                    </button>
                  )}
                </div>
                <AudioMeter id={track.id} name={t(trackLabel(track))} />
              </div>
            ))}
          </div>
          {project?.media && (
            <AudioEffectsPanel
              key={`${project.media.id}:${selection?.trackId}:${selection?.startMs}:${selection?.endMs}`}
              project={project}
              selection={selection}
              busy={active || working}
              run={run}
              onError={onError}
            />
          )}
          {project?.media && (
            <AudioRegionsEditor
              key={`${project.media.id}:${selection?.trackId}:${selection?.regionId}:${selection?.startMs}:${selection?.endMs}`}
              project={project}
              selection={selection}
              selected={selected}
              videoRef={videoRef}
              onEdit={onEdit}
              busy={active || working || !bridge.native}
              onTransfer={(options) => {
                videoRef.current?.pause();
                void run(async () => {
                  await bridge.transferAudio(options);
                  showJobs();
                  return null;
                });
              }}
              onExport={(id) =>
                void run(async () => {
                  if (await bridge.exportAudioTrack(project, id, true)) showJobs();
                  return null;
                })
              }
            />
          )}
        </>
      )}
      <div className="settings-section">
        <h3>{t('previewPerformance')}</h3>
        <p className="panel-description">{t('lightPreviewHint')}</p>
        <button
          className="button accent wide"
          disabled={!bridge.native || !project?.media || active}
          onClick={() =>
            void run(async () => {
              await bridge.prepareProxy(true);
              showJobs();
              return null;
            })
          }
        >
          <RefreshCw size={15} />
          {t('lightPreview')}
        </button>
      </div>
      <h3>{t('mediaInfo')}</h3>
      <strong>{project?.media?.originalName}</strong>
      <div className="stream-list">
        {project?.media?.streams.map((stream) => (
          <div key={stream.index}>
            <span className="stream-kind">{stream.kind}</span>
            <strong>{stream.codec.toUpperCase()}</strong>
            <small>
              {stream.language} {stream.width ? `${stream.width} × ${stream.height}` : ''}{' '}
              {stream.channels ? `${stream.channels} ch` : ''}
            </small>
          </div>
        ))}
      </div>
    </div>
  );
}
