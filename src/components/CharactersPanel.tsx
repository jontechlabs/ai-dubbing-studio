import { useEffect, useState } from 'react';
import { Plus, Users, ScanLine, Download, Trash2, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AudioSelection, Dialogue, Job, Project, VoiceReference } from '../domain/types';
import {
  CharacterAvatar,
  CharacterGallery,
  CharacterMetadata,
  CharacterSamples,
} from './CharacterTools';
import { audioTracks, trackLabel } from '../domain/audio';
import { formatTime } from '../domain/time';
import {
  addCharacter,
  editCharacter,
  deleteCharacter,
  assignCharacter,
  applySpeakers,
  analysisCurrent,
} from '../domain/characters';
import * as bridge from '../services/bridge';
import { VoiceLibraryPanel } from './VoiceLibraryPanel';
import { ReferenceTranscription } from './ReferenceTranscription';
import { ReferenceFileImport } from './ReferenceFileImport';

export function CharactersPanel({
  project,
  jobs,
  selectedId,
  onEdit,
  run,
  showJobs,
  onModels,
  onError,
  selection,
  snapshot,
  applySnapshot,
  onNavigate,
  onAudition,
}: {
  selection: AudioSelection | null;
  snapshot: () => Promise<Project>;
  applySnapshot: (before: Project, after: Project) => Promise<void>;
  onNavigate: (line: Dialogue) => void;
  onAudition: () => void;
  project: Project;
  jobs: Job[];
  selectedId: string | null;
  onEdit: (update: (project: Project) => Project) => void;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  showJobs: () => void;
  onModels: () => void;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(''),
    [activeId, setActiveId] = useState(project.characters[0]?.id ?? '');
  const [runtime, setRuntime] = useState<{ installed: boolean } | null>(null),
    [working, setWorking] = useState(false);
  const [from, setFrom] = useState(1),
    [to, setTo] = useState(1),
    [threshold, setThreshold] = useState(0.75),
    [label, setLabel] = useState('Neutral');
  const character =
    project.characters.find((item) => item.id === activeId) ?? project.characters[0];
  const active = jobs.some((job) => ['running', 'queued', 'paused'].includes(job.status));
  const analysis = project.speakerAnalysis;
  const [scopeMode, setScopeMode] = useState(selection ? 'range' : 'all');
  const [rangeStart, setRangeStart] = useState(selection?.startMs ?? 0),
    [rangeEnd, setRangeEnd] = useState(selection?.endMs ?? project.media?.durationMs ?? 0);
  const [sourceTrack, setSourceTrack] = useState(selection?.trackId ?? 'auto'),
    [referenceCharacter, setReferenceCharacter] = useState(''),
    [replaceAssigned, setReplaceAssigned] = useState(false);
  const validRange =
    scopeMode === 'all' ||
    (Number.isSafeInteger(rangeStart) &&
      Number.isSafeInteger(rangeEnd) &&
      rangeStart >= 0 &&
      rangeEnd > rangeStart &&
      rangeEnd <= (project.media?.durationMs ?? 0));
  useEffect(() => {
    if (bridge.native)
      void bridge
        .speakerStatus()
        .then(setRuntime)
        .catch((error) => onError(String(error)));
  }, [onError]);
  return (
    <div
      className="panel-body characters-panel"
      onPlayCapture={(event) => {
        if (!(event.target instanceof HTMLAudioElement)) return;
        onAudition();
        const playing = event.target;
        event.currentTarget.querySelectorAll('audio').forEach((audio) => {
          if (audio !== playing) audio.pause();
        });
      }}
    >
      <p className="panel-description">{t('charactersHint')}</p>
      <div className="settings-section">
        <h3>
          <ScanLine size={16} />
          {t('speakerIdentify')}
        </h3>
        <p className="panel-description">{t('speakerHint')}</p>
        {!runtime?.installed ? (
          <button className="button accent wide" onClick={onModels}>
            <Download size={15} />
            {t('speakerInstallFromModels')}
          </button>
        ) : (
          <>
            <div className="speaker-scope-controls">
              <label className="field">
                <span>{t('speakerSourceTrack')}</span>
                <select
                  aria-label={t('speakerSourceTrack')}
                  value={sourceTrack}
                  onChange={(e) => setSourceTrack(e.target.value)}
                >
                  <option value="auto">{t('characterSampleAuto')}</option>
                  {audioTracks(project)
                    .filter((track) => track.kind !== 'dubbing')
                    .map((track) => (
                      <option value={track.id} key={track.id}>
                        {t(trackLabel(track))}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>{t('speakerScope')}</span>
                <select
                  aria-label={t('speakerScope')}
                  value={scopeMode}
                  onChange={(e) => setScopeMode(e.target.value)}
                >
                  <option value="all">{t('speakerScopeAll')}</option>
                  <option value="range">{t('speakerScopeRange')}</option>
                </select>
              </label>
              {scopeMode === 'range' && (
                <div className="character-crop-inputs">
                  <label>
                    {t('speakerRangeStart')}
                    <input
                      aria-label={t('speakerRangeStart')}
                      type="number"
                      min="0"
                      max={(project.media?.durationMs ?? 0) / 1000}
                      step="0.001"
                      value={rangeStart / 1000}
                      onChange={(e) => setRangeStart(Math.round(Number(e.target.value) * 1000))}
                    />
                  </label>
                  <label>
                    {t('speakerRangeEnd')}
                    <input
                      aria-label={t('speakerRangeEnd')}
                      type="number"
                      min="0"
                      max={(project.media?.durationMs ?? 0) / 1000}
                      step="0.001"
                      value={rangeEnd / 1000}
                      onChange={(e) => setRangeEnd(Math.round(Number(e.target.value) * 1000))}
                    />
                  </label>
                </div>
              )}
              <label className="field">
                <span>{t('speakerReferenceGuide')}</span>
                <select
                  aria-label={t('speakerReferenceGuide')}
                  value={referenceCharacter}
                  onChange={(e) => setReferenceCharacter(e.target.value)}
                >
                  <option value="">{t('speakerWithoutGuide')}</option>
                  {project.characters
                    .filter((c) => c.references.length > 0)
                    .map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
                <small>{t('speakerGuideHint')}</small>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={replaceAssigned}
                  onChange={(e) => setReplaceAssigned(e.target.checked)}
                />
                {t('speakerReplaceAssigned')}
              </label>
            </div>
            <details>
              <summary>{t('speakerGroupingSettings')}</summary>
              <label className="field">
                <span>{t('speakerThreshold')}</span>
                <input
                  aria-label={t('speakerThreshold')}
                  type="range"
                  min="0.45"
                  max="0.8"
                  step="0.05"
                  value={threshold}
                  onChange={(event) => setThreshold(Number(event.target.value))}
                />
                <small>{t('speakerThresholdHint')}</small>
              </label>
            </details>
            <button
              className="button accent wide"
              disabled={
                active || working || !project.media || !project.dialogues.length || !validRange
              }
              onClick={() =>
                void run(async () => {
                  await bridge.identifySpeakers(threshold, {
                    trackId: sourceTrack,
                    ...(scopeMode === 'range' ? { startMs: rangeStart, endMs: rangeEnd } : {}),
                    ...(referenceCharacter ? { referenceCharacterId: referenceCharacter } : {}),
                    replaceAssigned,
                  });
                  showJobs();
                  return null;
                })
              }
            >
              <ScanLine size={15} />
              {t('speakerIdentify')}
            </button>
          </>
        )}
        {analysis && (
          <div className="speaker-result" role="status">
            <strong>{t('speakerResult', { count: analysis.clusters.length })}</strong>
            <p>
              {t('speakerUnassigned', {
                count: analysis.assignments.filter((item) => item.speaker === null).length,
              })}
            </p>
            <p className="panel-description">{t('speakerApplyHint')}</p>
            {!analysis.clusters.length && <p className="warning">{t('speakerNoMatches')}</p>}
            {analysis.scope?.startMs !== undefined && analysis.scope.endMs !== undefined && (
              <p>
                {formatTime(analysis.scope.startMs)} → {formatTime(analysis.scope.endMs)}
              </p>
            )}
            <div className="speaker-proposal-list">
              {analysis.clusters.map((cluster) => (
                <div className="speaker-proposal" key={cluster.speaker}>
                  <CharacterAvatar project={project} portrait={cluster.portrait} />
                  <span>
                    {cluster.characterId
                      ? project.characters.find((c) => c.id === cluster.characterId)?.name
                      : `${t('characterTemporaryPrefix')} ${String(cluster.speaker + 1).padStart(2, '0')}`}
                    <small>
                      {t('characterAssignedCount', {
                        count: analysis.assignments.filter((a) => a.speaker === cluster.speaker)
                          .length,
                      })}
                    </small>
                  </span>
                  <AnalysisReference project={project} path={cluster.referencePath} />
                </div>
              ))}
            </div>
            {!analysisCurrent(project) && <p className="warning">{t('speakerStale')}</p>}
            <button
              className="button accent wide"
              disabled={!analysis.clusters.length || !analysisCurrent(project) || active}
              onClick={() =>
                onEdit((p) =>
                  applySpeakers(p, t('speakerReferenceLabel'), t('characterTemporaryPrefix')),
                )
              }
            >
              {t('speakerApply')}
            </button>
          </div>
        )}
      </div>
      <form
        className="character-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) {
            let created = '';
            onEdit((p) => {
              const next = addCharacter(p, name);
              created = next.characters.at(-1)!.id;
              return next;
            });
            if (created) setActiveId(created);
            setName('');
          }
        }}
      >
        <input
          aria-label={t('characterName')}
          placeholder={t('characterName')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button className="button accent" disabled={!name.trim()}>
          <Plus size={15} />
          {t('characterAdd')}
        </button>
      </form>
      <CharacterGallery
        project={project}
        activeId={character?.id ?? ''}
        onActive={setActiveId}
        busy={active || working}
        onEdit={onEdit}
        snapshot={snapshot}
        applySnapshot={applySnapshot}
        onError={onError}
      />
      {!project.characters.length ? (
        <p className="panel-description">{t('charactersEmpty')}</p>
      ) : (
        <>
          <label className="field">
            <span>{t('character')}</span>
            <select
              aria-label={t('character')}
              value={character?.id ?? ''}
              onChange={(event) => setActiveId(event.target.value)}
            >
              {project.characters.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {character && (
            <div className="character-details" key={character.id}>
              <CharacterMetadata
                project={project}
                character={character}
                selectedId={selectedId}
                busy={active || working}
                onEdit={onEdit}
                run={run}
                onError={onError}
              />
              <div className="character-name-row">
                <label className="field">
                  <span>{t('characterName')}</span>
                  <input
                    aria-label={t('characterRename')}
                    defaultValue={character.name}
                    onBlur={(event) => {
                      if (!event.target.value.trim()) event.target.value = character.name;
                    }}
                    onChange={(event) => {
                      if (event.target.value.trim())
                        onEdit((p) => editCharacter(p, character.id, { name: event.target.value }));
                    }}
                  />
                </label>
                <label className="field">
                  <span>{t('characterColor')}</span>
                  <input
                    aria-label={t('characterColor')}
                    type="color"
                    value={character.color}
                    onChange={(event) =>
                      onEdit((p) => editCharacter(p, character.id, { color: event.target.value }))
                    }
                  />
                </label>
              </div>
              <p>
                {t('characterAssignedCount', {
                  count: project.dialogues.filter((line) => line.characterId === character.id)
                    .length,
                })}
              </p>
              <VoiceLibraryPanel
                project={project}
                character={character}
                busy={active || working}
                onEdit={onEdit}
                run={run}
                snapshot={snapshot}
                onStarted={showJobs}
                onModels={onModels}
                onError={onError}
              />
              <CharacterSamples
                project={project}
                character={character}
                busy={active || working}
                onError={onError}
                onNavigate={onNavigate}
              />
              <button
                className="button subtle wide"
                disabled={!selectedId}
                onClick={() => onEdit((p) => assignCharacter(p, [selectedId!], character.id))}
              >
                {t('characterAssignSelected')}
              </button>
              <form
                className="character-range"
                onSubmit={(event) => {
                  event.preventDefault();
                  onEdit((p) =>
                    assignCharacter(
                      p,
                      p.dialogues.slice(from - 1, to).map((line) => line.id),
                      character.id,
                    ),
                  );
                }}
              >
                <label>
                  {t('characterRangeFrom')}
                  <input
                    aria-label={t('characterRangeFrom')}
                    type="number"
                    min="1"
                    max={project.dialogues.length || 1}
                    value={from}
                    onChange={(event) => setFrom(Number(event.target.value))}
                  />
                </label>
                <label>
                  {t('characterRangeTo')}
                  <input
                    aria-label={t('characterRangeTo')}
                    type="number"
                    min={from}
                    max={project.dialogues.length || 1}
                    value={to}
                    onChange={(event) => setTo(Number(event.target.value))}
                  />
                </label>
                <button className="button subtle" disabled={!project.dialogues.length || from > to}>
                  {t('characterAssignRange')}
                </button>
              </form>
              <h3>{t('voiceReferences')}</h3>
              <p className="panel-description">{t('voiceReferenceHint')}</p>
              <label className="field">
                <span>{t('referenceLabel')}</span>
                <input
                  aria-label={t('referenceLabel')}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <div className="reference-actions">
                <ReferenceFileImport
                  label="referenceImport"
                  busy={working || active}
                  onError={onError}
                  onImport={async (file) => {
                    let imported = false;
                    setWorking(true);
                    try {
                      await run(async () => {
                        const result = await bridge.importCharacterReferenceFile(
                          character.id,
                          label,
                          file,
                        );
                        imported = true;
                        return result;
                      });
                      return imported;
                    } finally {
                      setWorking(false);
                    }
                  }}
                />
                <button
                  className="button subtle"
                  disabled={!bridge.native || !selectedId || working || active}
                  onClick={() => {
                    setWorking(true);
                    void run(() =>
                      bridge.importVoiceReference(character.id, selectedId, label),
                    ).finally(() => setWorking(false));
                  }}
                >
                  {working ? <LoaderCircle className="spin" size={14} /> : <Users size={14} />}{' '}
                  {t('referenceExtract')}
                </button>
              </div>
              {character.references.map((reference) => (
                <Reference
                  key={reference.id}
                  reference={reference}
                  characterId={character.id}
                  onError={onError}
                  selected={character.defaultReferenceId === reference.id}
                  busy={active || working}
                  onTranscribe={(language) =>
                    run(async () => {
                      await bridge.transcribeVoiceReference(character.id, reference.id, language);
                      showJobs();
                      return null;
                    })
                  }
                  onDefault={() =>
                    onEdit((p) =>
                      editCharacter(p, character.id, { defaultReferenceId: reference.id }),
                    )
                  }
                  onTranscript={(transcript) =>
                    onEdit((p) =>
                      editCharacter(p, character.id, {
                        references: character.references.map((item) =>
                          item.id === reference.id ? { ...item, transcript } : item,
                        ),
                      }),
                    )
                  }
                  onLabel={(label) =>
                    onEdit((p) =>
                      editCharacter(p, character.id, {
                        references: p.characters
                          .find((item) => item.id === character.id)!
                          .references.map((item) =>
                            item.id === reference.id ? { ...item, label } : item,
                          ),
                      }),
                    )
                  }
                  onRemove={() =>
                    onEdit((p) =>
                      editCharacter(p, character.id, {
                        references: character.references.filter((item) => item.id !== reference.id),
                        defaultReferenceId:
                          character.defaultReferenceId === reference.id
                            ? (character.references.find((item) => item.id !== reference.id)?.id ??
                              null)
                            : character.defaultReferenceId,
                      }),
                    )
                  }
                />
              ))}
              <button
                className="text-button danger"
                onClick={() => onEdit((p) => deleteCharacter(p, character.id))}
              >
                <Trash2 size={14} />
                {t('characterDelete')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
function AnalysisReference({ project, path }: { project: Project; path: string }) {
  const { t } = useTranslation(),
    [url, setUrl] = useState('');
  useEffect(() => {
    let disposed = false;
    void bridge
      .characterAssetUrl(path)
      .then((value) => {
        if (!disposed) setUrl(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [project.id, path]);
  return (
    <audio
      controls
      preload="none"
      src={url || undefined}
      aria-label={t('speakerCandidateReference')}
    />
  );
}
function Reference({
  reference,
  characterId,
  selected,
  onDefault,
  onTranscript,
  onLabel,
  onRemove,
  onError,
  busy,
  onTranscribe,
}: {
  reference: VoiceReference;
  characterId: string;
  selected: boolean;
  onDefault: () => void;
  onTranscript: (value: string) => void;
  onLabel: (value: string) => void;
  onRemove: () => void;
  onError: (value: string) => void;
  busy: boolean;
  onTranscribe: (language: string) => Promise<void>;
}) {
  const { t } = useTranslation(),
    [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    if (bridge.native)
      void bridge
        .voiceReferenceUrl(characterId, reference.id)
        .then((url) => {
          if (!disposed) setUrl(url);
        })
        .catch((error) => {
          if (!disposed) onError(String(error));
        });
    return () => {
      disposed = true;
    };
  }, [characterId, reference.id, onError]);
  return (
    <div className="voice-reference">
      <div>
        <strong>{reference.label}</strong>
        <small>{(reference.durationMs / 1000).toFixed(1)} s</small>
      </div>
      {url && <audio controls preload="metadata" src={url} />}
      <ReferenceTranscription
        busy={busy || reference.durationMs < 1000}
        start={onTranscribe}
        onError={onError}
      />
      <label className="field">
        <span>{t('referenceLabel')}</span>
        <input
          aria-label={`${t('referenceLabel')} ${reference.id}`}
          value={reference.label}
          onChange={(event) => onLabel(event.target.value)}
        />
      </label>
      <label className="field">
        <span>{t('referenceTranscript')}</span>
        <textarea
          aria-label={`${t('referenceTranscript')} ${reference.label}`}
          value={reference.transcript}
          disabled={busy}
          onChange={(event) => onTranscript(event.target.value)}
        />
      </label>
      <p className="panel-description">{t('asrReviewHint')}</p>
      <div>
        <button className="text-button" aria-pressed={selected} onClick={onDefault}>
          {t(selected ? 'referenceDefault' : 'referenceUseDefault')}
        </button>
        <button className="text-button" onClick={onRemove}>
          {t('referenceRemove')}
        </button>
      </div>
    </div>
  );
}
