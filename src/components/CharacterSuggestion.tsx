import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Job, Project } from '../domain/types';
import { libraryOf } from '../domain/voiceLibrary';
import { assignCharacter } from '../domain/characters';
import { audioTracks, trackLabel } from '../domain/audio';
import { CharacterAvatar } from './CharacterTools';
import * as bridge from '../services/bridge';

export function CharacterSuggestion({
  project,
  line,
  jobs,
  onEdit,
  run,
  snapshot,
  onModels,
}: {
  project: Project;
  line: Dialogue;
  jobs: Job[];
  onEdit: (update: (p: Project) => Project) => void;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  snapshot: () => Promise<Project>;
  onModels: () => void;
}) {
  const { t } = useTranslation();
  const [runtime, setRuntime] = useState<boolean | null>(null),
    [trackId, setTrackId] = useState('auto');
  const [pending, setPending] = useState<string | null>(null),
    [proposal, setProposal] = useState<bridge.CharacterSuggestion | null>(null);
  const [error, setError] = useState(''),
    [starting, setStarting] = useState(false);
  const [requestedKey, setRequestedKey] = useState('');
  const handled = useRef(''),
    alive = useRef(true),
    serial = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const busy = jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  const blocked = jobs.some(
    (j) => ['queued', 'running', 'paused'].includes(j.status) && j.kind !== 'characterMatch',
  );
  const available = project.characters.some(
    (c) => c.references.length || libraryOf(project, c.id)?.sources.length,
  );
  const key = useMemo(
    () =>
      JSON.stringify([
        project.id,
        project.media?.path,
        line.id,
        line.startMs,
        line.endMs,
        line.characterId,
        trackId,
        project.characters.map((c) => [
          c.id,
          c.defaultReferenceId,
          c.references,
          libraryOf(project, c.id)?.sources,
        ]),
        project.tracks,
        project.generations.filter((g) => g.kind === 'audioPatch' || g.kind === 'audioEffects'),
      ]),
    [project, line, trackId],
  );
  useEffect(() => {
    let disposed = false;
    if (bridge.native)
      void bridge
        .speakerStatus()
        .then((s) => {
          if (!disposed) setRuntime(s.installed);
        })
        .catch(() => {
          if (!disposed) setRuntime(false);
        });
    return () => {
      disposed = true;
    };
  }, []);
  async function suggest() {
    if (!bridge.native || !runtime || !available || busy || starting || pending) return;
    const request = ++serial.current;
    setRequestedKey(key);
    setStarting(true);
    setError('');
    setProposal(null);
    try {
      await snapshot();
      if (!alive.current || request !== serial.current) return;
      const id = await bridge.suggestDialogueCharacter({ lineId: line.id, trackId });
      if (alive.current && request === serial.current) setPending(id);
    } catch (e) {
      if (alive.current && request === serial.current) setError(String(e));
    } finally {
      if (alive.current && request === serial.current) setStarting(false);
    }
  }
  useEffect(() => {
    if (!pending) return;
    const job = jobs.find((j) => j.id === pending);
    if (!job || ['running', 'queued', 'paused'].includes(job.status) || handled.current === pending)
      return;
    handled.current = pending;
    const request = serial.current;
    if (job.status === 'succeeded')
      void bridge
        .characterSuggestionResult(pending)
        .then((result) => {
          if (alive.current && request === serial.current) {
            setProposal(result);
            setPending(null);
          }
        })
        .catch((e) => {
          if (alive.current && request === serial.current) {
            setError(String(e));
            setPending(null);
          }
        });
    else {
      setError(job.error ?? 'SPEAKER_ANALYSIS_FAILED');
      setPending(null);
    }
  }, [pending, jobs]);
  const current =
    proposal?.lineId === line.id
      ? { ...proposal, stale: proposal.stale || requestedKey !== key }
      : null;
  return (
    <section
      className="settings-section character-suggestion"
      aria-label={t('speakerSuggest.title')}
    >
      <h4>{t('speakerSuggest.title')}</h4>
      <button
        className="button subtle"
        disabled={!bridge.native || !runtime || !available || busy || starting || !!pending}
        onClick={() => void suggest()}
      >
        <RefreshCw size={13} />
        {t(current ? 'speakerSuggest.refresh' : 'speakerSuggest.request')}
      </button>
      <details>
        <summary>{t('speakerSuggest.settings')}</summary>
        <label className="field">
          <span>{t('character')}</span>
          <select
            aria-label={t('speakerSuggest.manual')}
            value={line.characterId ?? ''}
            disabled={blocked}
            onChange={(e) => onEdit((p) => assignCharacter(p, [line.id], e.target.value || null))}
          >
            <option value="">{t('speakerSuggest.unassigned')}</option>
            {project.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {!runtime && runtime !== null ? (
          <button className="text-button" onClick={onModels}>
            {t('speakerSuggest.install')}
          </button>
        ) : !available ? (
          <p className="panel-description">{t('speakerSuggest.noReferences')}</p>
        ) : (
          <>
            <label className="field">
              <span>{t('speakerSuggest.track')}</span>
              <select
                value={trackId}
                disabled={busy || starting}
                onChange={(e) => {
                  setTrackId(e.target.value);
                  setProposal(null);
                }}
              >
                <option value="auto">{t('referenceTrackDefault')}</option>
                {audioTracks(project)
                  .filter((r) => r.kind !== 'dubbing')
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {t(trackLabel(r))}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
      </details>
      {(starting || pending) && (
        <p className="panel-description" role="status">
          <LoaderCircle size={13} className="spin" />
          {t('speakerSuggest.analyzing')}
        </p>
      )}
      {error && (
        <p className="warning" role="status">
          {t(`errors.${error.replace(/^Error: /, '')}`, {
            defaultValue: t('speakerSuggest.failed'),
          })}
        </p>
      )}
      {current && (
        <>
          <p className={current.stale || !current.reliable ? 'warning' : 'panel-description'}>
            {t(
              current.stale
                ? 'speakerSuggest.stale'
                : current.reason === 'tooShortOrNoSpeech'
                  ? 'speakerSuggest.tooShort'
                  : current.reliable
                    ? 'speakerSuggest.proposed'
                    : 'speakerSuggest.uncertain',
            )}
          </p>
          {current.candidates.map((candidate) => {
            const character = project.characters.find((c) => c.id === candidate.characterId);
            return (
              character && (
                <div className="speaker-candidate" key={character.id}>
                  <CharacterAvatar
                    project={project}
                    portrait={project.characterProfiles?.[character.id]?.portrait}
                    name={character.name}
                    small
                  />
                  <span>
                    {character.name}
                    <small>
                      {t('speakerSuggest.score', { score: candidate.score.toFixed(2) })}
                    </small>
                  </span>
                  <button
                    className="button subtle"
                    disabled={busy || current.stale || line.characterId === character.id}
                    onClick={() => {
                      void run(() => bridge.acceptCharacterSuggestion(current.id, character.id));
                    }}
                  >
                    <Check size={13} />
                    {t(
                      line.characterId === character.id
                        ? 'speakerSuggest.alreadyAssigned'
                        : 'speakerSuggest.accept',
                    )}
                  </button>
                </div>
              )
            );
          })}
        </>
      )}
      <small className="panel-description">{t('speakerSuggest.hint')}</small>
    </section>
  );
}
