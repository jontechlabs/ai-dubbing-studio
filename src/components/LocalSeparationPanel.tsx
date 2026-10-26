import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { audioTracks, trackLabel } from '../domain/audio';
import { formatTime } from '../domain/time';
import type { AudioSelection, Job, Project } from '../domain/types';
import * as bridge from '../services/bridge';

export function LocalSeparationPanel({
  project,
  selection,
  jobs,
  device,
  ready,
  busy,
  run,
  onError,
  showJobs,
}: {
  project: Project;
  selection: AudioSelection | null;
  jobs: Job[];
  device: string;
  ready: boolean;
  busy: boolean;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  onError: (message: string) => void;
  showJobs: () => void;
}) {
  const { t } = useTranslation();
  const tracks = audioTracks(project).filter((track) => track.kind !== 'dubbing');
  const [source, setSource] = useState(selection?.trackId ?? 'auto');
  const [start, setStart] = useState(selection?.startMs ?? 0),
    [end, setEnd] = useState(selection?.endMs ?? 0);
  const [reference, setReference] = useState('');
  const [proposals, setProposals] = useState<bridge.LocalSeparationProposal[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const completed = jobs
    .filter(
      (j) => j.kind === 'separation' && j.status === 'succeeded' && j.projectId === project.id,
    )
    .map((j) => j.id)
    .slice(-8)
    .join(',');
  useEffect(() => {
    let disposed = false;
    void Promise.all(
      completed
        .split(',')
        .filter(Boolean)
        .map((id) => bridge.localSeparationResult(id).catch(() => null)),
    ).then((values) => {
      if (!disposed) setProposals(values.filter((v): v is bridge.LocalSeparationProposal => !!v));
    });
    return () => {
      disposed = true;
    };
  }, [completed, project.id, project.revision]);
  const proposalKey = proposals.map((p) => p.id).join(',');
  useEffect(() => {
    let disposed = false;
    void Promise.all(
      proposalKey
        .split(',')
        .filter(Boolean)
        .flatMap((id) =>
          ['speech', 'music', 'sfx'].map(async (role) => {
            try {
              return [`${id}:${role}`, await bridge.localSeparationUrl(id, role)] as const;
            } catch {
              return null;
            }
          }),
        ),
    ).then((values) => {
      if (!disposed) setUrls(Object.fromEntries(values.filter((v) => v !== null)));
    });
    return () => {
      disposed = true;
    };
  }, [proposalKey, project.id]);
  const selectedTrack =
    source === 'auto'
      ? (tracks.find((track) => track.role === 'speech') ??
        tracks.find((track) => track.kind === 'original'))
      : tracks.find((track) => track.id === source);
  const hasStems = ['speech', 'music', 'sfx'].every((role) =>
    tracks.some((track) => track.role === role && track.sourcePath === project.media?.path),
  );
  const valid =
    selectedTrack &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end <= (project.media?.durationMs ?? 0) &&
    end - start >= 100 &&
    end - start <= 60000;
  return (
    <section className="settings-section local-separation">
      <h3>{t('localSeparationTitle')}</h3>
      <p className="panel-description">{t('localSeparationHint')}</p>
      <div className="speaker-scope-controls">
        <label className="field">
          <span>{t('localSeparationSource')}</span>
          <select
            aria-label={t('localSeparationSource')}
            value={selectedTrack?.id ?? ''}
            onChange={(e) => setSource(e.target.value)}
          >
            {tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {t(trackLabel(track))}
              </option>
            ))}
          </select>
        </label>
        <div className="character-crop-inputs">
          {(['start', 'end'] as const).map((edge) => (
            <label key={edge}>
              {t(edge === 'start' ? 'localSeparationStart' : 'localSeparationEnd')}
              <input
                aria-label={t(edge === 'start' ? 'localSeparationStart' : 'localSeparationEnd')}
                type="number"
                min="0"
                step="0.001"
                value={(edge === 'start' ? start : end) / 1000}
                onChange={(e) =>
                  (edge === 'start' ? setStart : setEnd)(Math.round(Number(e.target.value) * 1000))
                }
              />
            </label>
          ))}
        </div>
      </div>
      {selection && (
        <button
          className="text-button"
          onClick={() => {
            setStart(selection.startMs);
            setEnd(selection.endMs);
            setSource(selection.trackId);
          }}
        >
          {t('localUseSelection')}
        </button>
      )}
      {!hasStems && <p className="warning">{t('localSeparationStemsRequired')}</p>}
      <button
        className="button accent wide"
        disabled={!bridge.native || !ready || busy || !valid || !hasStems}
        onClick={() =>
          void run(async () => {
            await bridge.separateAudioRegion({
              sourceTrackId: selectedTrack!.id,
              startMs: start,
              endMs: end,
              device,
            });
            showJobs();
            return null;
          })
        }
      >
        {t('localSeparationPreview')}
      </button>
      <label className="field">
        <span>{t('localSeparationGuide')}</span>
        <select
          aria-label={t('localSeparationGuide')}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        >
          <option value="">{t('speakerWithoutGuide')}</option>
          {project.characters
            .filter((c) => c.references.length)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      {proposals
        .slice()
        .reverse()
        .map((p) => (
          <article key={p.id} className="local-separation-result">
            <strong>
              {formatTime(p.options.startMs)} → {formatTime(p.options.endMs)}
            </strong>
            <p className="panel-description">
              {t(
                p.applied
                  ? 'localSeparationApplied'
                  : p.stale
                    ? 'localSeparationStale'
                    : 'localSeparationReview',
              )}
            </p>
            {p.roles.map((role) => (
              <label className="field" key={role}>
                <span>{t(`stem.${role}`)}</span>
                {urls[`${p.id}:${role}`] && (
                  <audio
                    aria-label={t('localSeparationAudition', { role: t(`stem.${role}`) })}
                    controls
                    preload="none"
                    src={urls[`${p.id}:${role}`]}
                  />
                )}
              </label>
            ))}
            {!p.applied && (
              <button
                className="button accent"
                disabled={busy || p.stale}
                onClick={() => void run(() => bridge.applyLocalSeparation(p.id))}
              >
                {t('localSeparationApply')}
              </button>
            )}
            {p.applied && (
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  const track = tracks.find((track) => track.role === 'speech');
                  if (!track) {
                    onError('LOCAL_SEPARATION_STEMS_REQUIRED');
                    return;
                  }
                  void run(async () => {
                    await bridge.identifySpeakers(0.75, {
                      startMs: p.options.startMs,
                      endMs: p.options.endMs,
                      trackId: track.id,
                      ...(reference ? { referenceCharacterId: reference } : {}),
                    });
                    showJobs();
                    return null;
                  });
                }}
              >
                {t('localIdentifyAfter')}
              </button>
            )}
          </article>
        ))}
    </section>
  );
}
