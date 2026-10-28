import { useEffect, useRef, useState } from 'react';
import { Check, Download, Mic2, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Generation, Job, Project, VoiceSettings } from '../domain/types';
import {
  defaultVoiceSettings,
  deleteGeneration,
  editVoiceSettings,
  reviewGeneration,
  selectGeneration,
  selectedGeneration,
  spokenText,
  staleGeneration,
  voiceGenerations,
} from '../domain/tts';
import * as bridge from '../services/bridge';
import { installedVoiceVariants, voiceVariant } from '../domain/voiceEngines';
import { audioTracks, trackLabel } from '../domain/audio';
import { ReferenceTranscription } from './ReferenceTranscription';
import { OutputGainControl } from './OutputGainControl';
import { CurrentJobProgress } from './CurrentJobProgress';
import { CurrentReferenceAudio } from './CurrentReferenceAudio';
import { DubbingPipelineControls } from './DubbingPipelineControls';
import { dialogueText, editDialogue } from '../domain/subtitles';
import { editCueText } from '../domain/timing';
import { accentSupported, voiceAccents } from '../domain/voiceAccents';
import { ReferenceFileImport } from './ReferenceFileImport';
import { BatchDubbingAction } from './BatchDubbingAction';
import { DubbingTimingControls } from './DubbingTimingControls';
import { VoiceCapture } from './VoiceCapture';
import { VoiceQualityControls } from './VoiceQualityControls';
import { libraryOf, libraryReference } from '../domain/voiceLibrary';
import { IntonationGuideControls } from './IntonationGuideControls';
import { CharacterSuggestion } from './CharacterSuggestion';
import { qualityPreset, resolvedQuality } from '../domain/voiceQuality';
import { ProsodyTransfer } from './ProsodyTransfer';
import { moodGroup, moodGroups, voiceMoods } from '../domain/voiceMoods';

export function CosyModel({
  jobs,
  onError,
  onStarted,
}: {
  jobs: Job[];
  onError: (error: string) => void;
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<bridge.TtsStatus | null>(null),
    [cuda, setCuda] = useState(true),
    [working, setWorking] = useState(false),
    [revision, setRevision] = useState(0);
  const completion = jobs
    .filter(
      (j) =>
        ['ttsInstall', 'modelMove'].includes(j.kind) &&
        ['succeeded', 'failed', 'cancelled'].includes(j.status),
    )
    .map((j) => j.id + j.status)
    .join('|');
  const busy = jobs.some((j) => ['running', 'queued', 'paused'].includes(j.status));
  useEffect(() => {
    let disposed = false;
    if (bridge.native)
      void bridge
        .ttsStatus()
        .then((s) => {
          if (!disposed) setStatus(s);
        })
        .catch((e) => {
          if (!disposed) onError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [completion, revision, onError]);
  return (
    <div className="model-card cosy-model">
      <h3>
        <Mic2 size={16} />
        CosyVoice3 0.5B RL
      </h3>
      <span className="model-state">
        {t(status?.installed ? 'modelInstalled' : 'modelNotInstalled')}
      </span>
      <p>{t('ttsModelHint')}</p>
      <small>
        {status ? `${(status.sizeBytes / 1024 ** 3).toFixed(2)} GiB` : t('ttsModelSize')} ·{' '}
        {t('ttsDependenciesExtra')}
      </small>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={cuda}
          disabled={busy || working}
          onChange={(e) => setCuda(e.target.checked)}
        />
        {t('ttsInstallCuda')}
      </label>
      <button
        className="button accent wide"
        disabled={!bridge.native || busy || working}
        onClick={() => {
          setWorking(true);
          void bridge
            .installTtsRuntime(cuda)
            .then(onStarted)
            .catch((e) => onError(String(e)))
            .finally(() => setWorking(false));
        }}
      >
        <Download size={14} />
        {t(status?.installed ? 'ttsRepair' : 'ttsInstall')}
      </button>
      {status?.installed && (
        <>
          <button
            className="text-button"
            disabled={busy || working}
            onClick={() => setRevision((n) => n + 1)}
          >
            <RefreshCw size={13} />
            {t('refreshDevices')}
          </button>
          <small>
            {status.inventory.devices.map((d) => d.name).join(' · ') || t('ttsDevicesPending')}
          </small>
          {status.inventory.warning && <p className="warning">{t('errors.DEVICE_PROBE_FAILED')}</p>}
        </>
      )}
    </div>
  );
}

function ReferenceAudio({
  owner,
  referenceId,
  onError,
  library = false,
  onPlay,
}: {
  library?: boolean;
  onPlay: () => void;
  owner: string | null;
  referenceId: string;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState('');
  useEffect(() => {
    let disposed = false;
    void (
      library
        ? bridge.voiceLibraryAudioUrl(owner!, referenceId)
        : bridge.voiceReferenceUrl(owner, referenceId)
    )
      .then((url) => {
        if (!disposed) setSource(url);
      })
      .catch((error) => {
        if (!disposed) onError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [owner, referenceId, onError, library]);
  return (
    <audio
      key={referenceId}
      controls
      onPlay={onPlay}
      preload="metadata"
      src={source || undefined}
      aria-label={t('ttsListenReference')}
      style={{ width: '100%' }}
    />
  );
}

export function DubPanel({
  batch,
  run,
  project,
  line,
  jobs,
  onEdit,
  snapshot,
  onStarted,
  onError,
  onModels,
  onCharacters,
  onLips,
  onInpaint,
  onOriginal,
  onReferencePlay,
  onPlay,
  activeGenerationId,
}: {
  batch?: { selectedIds: string[] };
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  project: Project;
  line: Dialogue | undefined;
  jobs: Job[];
  onEdit: (update: (p: Project) => Project) => void;
  snapshot: () => Promise<Project>;
  onStarted: () => void;
  onError: (error: string) => void;
  onModels: () => void;
  onCharacters: () => void;
  onLips: () => void;
  onInpaint: () => void;
  onOriginal: (line: Dialogue) => void;
  onReferencePlay: () => void;
  onPlay: (generation: Generation) => void;
  activeGenerationId: string | null;
}) {
  const { t } = useTranslation();
  const [batchSettings, setBatchSettings] = useState<VoiceSettings>(() => {
    const value = {
      ...(line?.voiceSettings ?? defaultVoiceSettings),
      variantId:
        line?.voiceSettings?.variantId ??
        project.modelPreferences?.voiceVariantId ??
        'cosy3-official',
    };
    return {
      ...value,
      referenceMode:
        value.referenceMode === 'custom' ? ('character' as const) : value.referenceMode,
      referenceId: value.referenceMode === 'library' ? null : value.referenceId,
    };
  });
  const [referencePending, setReferencePending] = useState(false);
  const [pipeline, setPipeline] = useState(false),
    [pipelineReady, setPipelineReady] = useState(false),
    [guideStrength, setGuideStrength] = useState(0);
  const [conversion, setConversion] = useState<
    import('../domain/voiceCapture').VoiceConversionOptions
  >({
    generationId: 'pipeline',
    referenceId: '',
    characterId: null,
    device: 'auto',
    referenceMode: 'current',
    referenceTrackId: 'auto',
  });
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const newestTake = useRef<HTMLElement | null>(null),
    previousTakes = useRef(project.generations.length);
  useEffect(() => {
    setCurrentJobId(null);
  }, [line?.id]);
  useEffect(() => {
    if (project.generations.length > previousTakes.current && currentJobId)
      requestAnimationFrame(() =>
        newestTake.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      );
    previousTakes.current = project.generations.length;
  }, [project.generations.length, currentJobId]);
  const [status, setStatus] = useState<bridge.TtsStatus | null>(null),
    [working, setWorking] = useState(false);
  const [engines, setEngines] = useState<bridge.VoiceStatus | null>(null);
  const variantId =
    (batch ? batchSettings.variantId : line?.voiceSettings?.variantId) ??
    voiceVariant(project.modelPreferences?.voiceVariantId)?.id ??
    'cosy3-official';
  const [compareA, setCompareA] = useState(''),
    [compareB, setCompareB] = useState('');
  const completion = jobs
    .filter(
      (j) =>
        ['ttsInstall', 'modelMove'].includes(j.kind) &&
        ['succeeded', 'failed', 'cancelled'].includes(j.status),
    )
    .map((j) => j.id + j.status)
    .join('|');
  useEffect(() => {
    let disposed = false;
    if (bridge.native)
      void (
        variantId === 'cosy3-official'
          ? bridge.ttsStatus().then((s) => {
              if (!disposed) setStatus(s);
            })
          : bridge
              .voiceStatus(
                [
                  'fish-s2-fp8',
                  'drama3-comfy-fp8',
                  'voxcpm2-bf16',
                  'chatterbox-multilingual-v3',
                ].includes(variantId),
              )
              .then((s) => {
                if (!disposed) setEngines(s);
              })
      ).catch((e) => {
        if (!disposed) onError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [completion, onError, variantId]);
  if (!line) return <div className="panel-body">{t('selectLine')}</div>;
  const preferred = voiceVariant(project.modelPreferences?.voiceVariantId);
  const rawSettings = batch
    ? batchSettings
    : {
        ...(line.voiceSettings ?? defaultVoiceSettings),
        variantId: line.voiceSettings?.variantId ?? preferred?.id ?? 'cosy3-official',
      };
  const voxContinuation =
    rawSettings.variantId === 'voxcpm2-bf16' && rawSettings.mode === 'zeroShot';
  const settings = voxContinuation
    ? { ...rawSettings, accent: 'auto' as const, mood: 'default' as const }
    : rawSettings;
  const variant = voiceVariant(settings.variantId)!;
  const chatterbox = variant.providerId === 'chatterbox';
  const multilingual = chatterbox || variant.providerId === 'voxcpm2';
  const mood = settings.mood ?? 'default';
  const accent = accentSupported(variant.id, project.languages.target)
    ? (settings.accent ?? 'auto')
    : 'auto';
  const instructedMood =
    variant.providerId === 'cosyvoice3' && (mood !== 'default' || accent !== 'auto');
  const mode = variant.providerId.startsWith('fish')
    ? 'zeroShot'
    : instructedMood || chatterbox
      ? 'crossLingual'
      : settings.mode;
  const ready =
    variant.id === 'cosy3-official'
      ? status?.installed
      : engines?.variants.some((v) => v.id === variant.id && v.installed);
  const checking = variant.id === 'cosy3-official' ? status === null : engines === null;
  const devices =
    variant.id === 'cosy3-official'
      ? status?.inventory.devices
      : variant.backend === 'vulkan'
        ? engines?.devices
        : engines?.cudaDevices.filter(
            (d) => d.id.startsWith('cuda:') || (multilingual && d.id === 'cpu'),
          );
  const character = project.characters.find((c) => c.id === line.characterId);
  const fileReference = settings.referenceMode === 'file';
  const libraryMode = settings.referenceMode === 'library';
  const library = libraryOf(project, line.characterId);
  const reference = libraryMode
    ? libraryReference(project, line.characterId, settings.referenceId)
    : fileReference
      ? project.voiceReferences?.find((r) => r.id === settings.referenceId)
      : character?.references.find(
          (r) =>
            r.id ===
            (settings.referenceMode === 'custom'
              ? settings.referenceId
              : character.defaultReferenceId),
        );
  const generations = voiceGenerations(project).filter(
    (g) => g.dialogueId === line.id && g.language === project.languages.target,
  );
  const chosen = selectedGeneration(project, line),
    busy = working || jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  const inputText = spokenText(project, line);
  const referenceMissing = settings.referenceMode !== 'current' && !reference;
  const transcriptMissing =
    mode === 'zeroShot' &&
    (settings.referenceMode === 'current'
      ? !project.sourceCues.some((c) => line.sourceCueIds.includes(c.id) && c.text.trim())
      : !reference?.transcript.trim());
  const guideIssue =
    !!settings.intonationGuide &&
    (line.endMs - line.startMs < 1000 ||
      (settings.intonationGuide.mode === 'hybrid' &&
        !project.sourceCues.some((c) => line.sourceCueIds.includes(c.id) && c.text.trim())));
  const shortReference =
    settings.referenceMode === 'current'
      ? line.endMs - line.startMs < 1000
      : !!reference && reference.durationMs < 1000;
  const edit = (change: Partial<typeof settings>) => {
    if (change.referenceMode === 'current') change.intonationGuide = undefined;
    if (batch) setBatchSettings({ ...settings, mode, ...change });
    else onEdit((p) => editVoiceSettings(p, line.id, { ...settings, mode, ...change }));
  };
  return (
    <div className="panel-body dub-panel">
      <h3>{variant.name}</h3>
      {!batch && (
        <CharacterSuggestion
          key={'character:' + project.id + line.id}
          project={project}
          line={line}
          jobs={jobs}
          onEdit={onEdit}
          run={run}
          snapshot={snapshot}
          onModels={onModels}
        />
      )}
      {!batch && (
        <VoiceCapture
          key={project.id + line.id}
          project={project}
          line={line}
          takes={generations}
          chosen={chosen}
          jobs={jobs}
          snapshot={snapshot}
          run={run}
          onStarted={onStarted}
          onError={onError}
          onModels={onModels}
        />
      )}
      {!batch && chosen && project.media && (
        <div className="settings-section">
          <button className="button accent wide" onClick={onLips} disabled={busy}>
            {t('lipsAnalyze')}
          </button>
          <button className="button subtle wide" onClick={onInpaint} disabled={busy}>
            {t('inpaintOpen')}
          </button>
          <DubbingTimingControls
            key={project.id + line.id + project.languages.target}
            project={project}
            line={line}
            busy={busy}
            onEdit={onEdit}
          />
        </div>
      )}
      <label className="field">
        <span>{t('phase6Engine')}</span>
        <select
          aria-label={t('phase6Engine')}
          value={variant.id}
          disabled={busy}
          onChange={(e) => {
            const next = voiceVariant(e.target.value)!;
            edit({
              variantId: next.id,
              intonationGuide: undefined,
              quality: undefined,
              device: 'auto',
              mood: ['qwen3-tts', 'chatterbox'].includes(next.providerId) ? 'default' : mood,
              accent: accentSupported(next.id, project.languages.target) ? accent : 'auto',
              mode: next.providerId.startsWith('fish')
                ? 'zeroShot'
                : next.providerId === 'chatterbox'
                  ? 'crossLingual'
                  : settings.mode,
            });
          }}
        >
          {installedVoiceVariants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      {variant.id !== 'cosy3-official' && (
        <p className="panel-description">
          {t(
            variant.id === 'drama3-comfy-fp8'
              ? 'dramaGenerationHint'
              : multilingual
                ? chatterbox
                  ? 'chatterboxGenerationHint'
                  : 'voxcpmGenerationHint'
                : variant.backend === 'vulkan'
                  ? 'phase6Gguf'
                  : variant.id === 'fish-s2-fp8'
                    ? 'phase6Fp8'
                    : 'ttsLocalHint',
          )}
        </p>
      )}
      <p className="panel-description">{t(batch ? 'ttsBatchLocalHint' : 'ttsLocalHint')}</p>
      {!ready && (
        <div className="tts-not-ready">
          <p>{t(checking ? 'phase6Checking' : 'ttsNeedsInstallation')}</p>
          <button className="button accent" onClick={onModels}>
            {t('models')}
          </button>
        </div>
      )}
      <label className="field">
        <span>{t('ttsDevice')}</span>
        <select
          value={settings.device}
          disabled={busy}
          onChange={(e) => edit({ device: e.target.value })}
        >
          <option value="auto">{t('ttsDeviceAuto')}</option>
          {(devices ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          {(variant.backend !== 'cuda' || multilingual) &&
            !devices?.some((d) => d.id === 'cpu') && <option value="cpu">CPU</option>}
        </select>
      </label>
      <label className="field">
        <span>{t('ttsReferenceMode')}</span>
        <select
          value={settings.referenceMode}
          disabled={busy}
          onChange={(e) =>
            edit({
              referenceMode: e.target.value as typeof settings.referenceMode,
              referenceId:
                e.target.value === 'file' ? (project.voiceReferences?.[0]?.id ?? null) : null,
            })
          }
        >
          <option value="character">{t('ttsReferenceDefault')}</option>
          <option value="current">{t('ttsReferenceCurrent')}</option>
          {!batch && <option value="custom">{t('ttsReferenceCustom')}</option>}
          <option value="file">{t('ttsReferenceFile')}</option>
          <option value="library">{t('library.referenceMode')}</option>
        </select>
      </label>
      {settings.referenceMode === 'current' && (
        <label className="field">
          <span>{t('referenceTrack')}</span>
          <select
            value={settings.referenceTrackId ?? 'auto'}
            disabled={busy}
            onChange={(e) => edit({ referenceTrackId: e.target.value })}
          >
            <option value="auto">{t('referenceTrackProject')}</option>
            {audioTracks(project)
              .filter((t) => t.kind !== 'dubbing')
              .map((track) => (
                <option key={track.id} value={track.id}>
                  {t(trackLabel(track))}
                </option>
              ))}
          </select>
        </label>
      )}
      {(settings.referenceMode === 'custom' || fileReference || (libraryMode && !batch)) && (
        <label className="field">
          <span>{t('ttsReferenceChoice')}</span>
          <select
            value={settings.referenceId ?? ''}
            disabled={busy}
            onChange={(e) => edit({ referenceId: e.target.value || null })}
          >
            <option value="">
              {t(libraryMode ? 'library.characterDefault' : 'ttsChooseReference')}
            </option>
            {(libraryMode
              ? library?.samples.filter((s) => s.status === 'approved').map((s) => s.reference)
              : fileReference
                ? project.voiceReferences
                : character?.references
            )?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} · {(r.durationMs / 1000).toFixed(1)} s
              </option>
            ))}
          </select>
        </label>
      )}
      {settings.referenceMode === 'current' && !batch && (
        <CurrentReferenceAudio
          key={JSON.stringify([
            line.id,
            line.startMs,
            line.endMs,
            settings.referenceTrackId ?? 'auto',
            project.media?.id,
            project.media?.audioStreamIndex,
            project.tracks,
            project.generations.filter((g) => g.kind === 'audioPatch'),
          ])}
          lineId={line.id}
          trackId={settings.referenceTrackId}
          snapshot={snapshot}
          onError={onError}
          onPlay={onReferencePlay}
          disabled={busy || !project.media}
        />
      )}
      <p className="panel-description">
        {settings.referenceMode === 'current'
          ? t('ttsCurrentReferenceHint')
          : reference
            ? `${fileReference ? '' : `${character?.name} · `}${reference.label} · ${(reference.durationMs / 1000).toFixed(1)} s`
            : t('ttsReferenceMissing')}
      </p>
      <ReferenceFileImport
        busy={busy}
        onError={onError}
        onPending={setReferencePending}
        onImport={async (file) => {
          let imported = false;
          setWorking(true);
          try {
            await run(async () => {
              const result = await bridge.importDubbingReference(
                batch ? null : line.id,
                { ...settings, mode, accent },
                file,
              );
              imported = !!result;
              if (result && batch)
                setBatchSettings({
                  ...settings,
                  mode,
                  accent,
                  referenceMode: 'file',
                  referenceId: result.voiceReferences?.at(-1)?.id ?? null,
                });
              return result;
            });
            return imported;
          } finally {
            setWorking(false);
          }
        }}
      />
      <p className="panel-description">{t('ttsImportReferenceHint')}</p>
      <button className="text-button" onClick={onCharacters}>
        {t('ttsManageReferences')}
      </button>
      {libraryMode && <p className="panel-description">{t('library.onlyApproved')}</p>}
      {settings.referenceMode !== 'current' && reference && (
        <>
          <ReferenceAudio
            onPlay={onReferencePlay}
            key={reference.id}
            library={libraryMode}
            owner={fileReference ? null : character!.id}
            referenceId={reference.id}
            onError={onError}
          />
          {!libraryMode && (
            <ReferenceTranscription
              busy={busy || shortReference}
              onError={onError}
              start={async (language) => {
                await snapshot();
                await bridge.transcribeVoiceReference(
                  fileReference ? null : character!.id,
                  reference.id,
                  language,
                );
                onStarted();
              }}
            />
          )}
          <label className="field">
            <span>{t('referenceTranscript')}</span>
            <textarea
              value={reference.transcript}
              disabled={busy || libraryMode}
              rows={3}
              onChange={(event) => {
                const text = event.target.value;
                onEdit((p) => ({
                  ...p,
                  ...(fileReference
                    ? {
                        voiceReferences: p.voiceReferences?.map((r) =>
                          r.id === reference.id ? { ...r, transcript: text } : r,
                        ),
                      }
                    : {
                        characters: p.characters.map((c) =>
                          c.id === character!.id
                            ? {
                                ...c,
                                references: c.references.map((r) =>
                                  r.id === reference.id ? { ...r, transcript: text } : r,
                                ),
                              }
                            : c,
                        ),
                      }),
                }));
              }}
            />
          </label>
          <p className="panel-description">{t('asrDubReviewHint')}</p>
        </>
      )}
      {settings.referenceMode === 'current' && transcriptMissing && (
        <p className="panel-description">{t('asrCurrentHint')}</p>
      )}
      {variant.id === 'voxcpm2-bf16' &&
        project.languages.target === 'fr' &&
        reference &&
        settings.referenceMode !== 'current' && (
          <div className="settings-section">
            <button
              className="button subtle wide"
              disabled={
                busy ||
                !reference.transcript.trim() ||
                (voxContinuation && !settings.intonationGuide)
              }
              onClick={() =>
                edit({
                  mode: 'zeroShot',
                  accent: 'auto',
                  mood: 'default',
                  intonationGuide: undefined,
                })
              }
            >
              {t('library.frenchFidelity')}
            </button>
            <p className="panel-description">{t('library.frenchFidelityHint')}</p>
          </div>
        )}
      {voxContinuation && <p className="panel-description">{t('library.voxContinuationHint')}</p>}
      {variant.id === 'voxcpm2-bf16' &&
        inputText.trim().length < 12 &&
        (settings.referenceMode === 'current'
          ? line.endMs - line.startMs
          : (reference?.durationMs ?? 20000)) < 5000 && (
          <p className="warning">{t('library.shortContext')}</p>
        )}
      <IntonationGuideControls project={project} settings={settings} busy={busy} onChange={edit} />
      <label className="field">
        <span>{t('ttsCloneMode')}</span>
        <select
          value={
            variant.id === 'voxcpm2-bf16' && settings.intonationGuide?.mode === 'hybrid'
              ? 'hybrid'
              : mode
          }
          disabled={
            busy ||
            instructedMood ||
            chatterbox ||
            (variant.id !== 'voxcpm2-bf16' && !!settings.intonationGuide)
          }
          onChange={(e) =>
            e.target.value !== 'hybrid' &&
            edit(
              e.target.value === 'zeroShot' && variant.id === 'voxcpm2-bf16'
                ? { mode: 'zeroShot', accent: 'auto', mood: 'default', intonationGuide: undefined }
                : {
                    mode: e.target.value as typeof settings.mode,
                    ...(variant.id === 'voxcpm2-bf16' && settings.intonationGuide?.mode === 'hybrid'
                      ? { intonationGuide: undefined }
                      : {}),
                  },
            )
          }
        >
          <option value="crossLingual" disabled={variant.providerId.startsWith('fish')}>
            {t(variant.id === 'voxcpm2-bf16' ? 'library.voxStandardOption' : 'ttsCrossLingual')}
          </option>
          <option value="zeroShot">
            {t(variant.id === 'voxcpm2-bf16' ? 'library.voxHiFiOption' : 'ttsZeroShot')}
          </option>
          {variant.id === 'voxcpm2-bf16' && settings.intonationGuide?.mode === 'hybrid' && (
            <option value="hybrid" disabled>
              {t('library.voxHybridOption')}
            </option>
          )}
        </select>
      </label>
      <p className="panel-description">
        {t(
          variant.id === 'voxcpm2-bf16'
            ? settings.intonationGuide?.mode === 'hybrid'
              ? 'library.voxHybridHint'
              : mode === 'zeroShot'
                ? 'library.voxHiFiHint'
                : 'library.voxStandardHint'
            : chatterbox
              ? 'chatterboxCloneHint'
              : instructedMood
                ? 'ttsCosyMoodHint'
                : variant.providerId.startsWith('fish')
                  ? 'ttsFishHint'
                  : mode === 'crossLingual'
                    ? 'ttsCrossHint'
                    : 'ttsZeroHint',
        )}
      </p>
      <label className="field">
        <span>{t('ttsMood')}</span>
        <select
          value={variant.providerId === 'qwen3-tts' || chatterbox ? 'default' : mood}
          disabled={
            busy ||
            variant.providerId === 'qwen3-tts' ||
            chatterbox ||
            voxContinuation ||
            settings.intonationGuide?.mode === 'hybrid'
          }
          onChange={(event) => edit({ mood: event.target.value as typeof settings.mood })}
        >
          <option value="default">{t('moods.default')}</option>
          {moodGroups.map((group) => (
            <optgroup key={group} label={t(`moodGroups.${group}`)}>
              {voiceMoods
                .filter((id) => moodGroup(id) === group)
                .map((id) => (
                  <option key={id} value={id}>
                    {t(`moods.${id}`)}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="panel-description">
        {t(
          chatterbox
            ? 'chatterboxMoodHint'
            : variant.providerId === 'qwen3-tts'
              ? 'ttsMoodUnsupported'
              : 'ttsMoodHint',
        )}
      </p>
      {variant.providerId === 'cosyvoice3' && (
        <p className="panel-description">{t('ttsCosyReferenceActingHint')}</p>
      )}
      <label className="field">
        <span>{t('ttsAccent')}</span>
        <select
          value={accent}
          disabled={
            busy ||
            !accentSupported(variant.id, project.languages.target) ||
            voxContinuation ||
            settings.intonationGuide?.mode === 'hybrid'
          }
          onChange={(event) => edit({ accent: event.target.value as typeof settings.accent })}
        >
          <option value="auto">{t('accents.auto')}</option>
          {voiceAccents
            .filter((a) => a.language === project.languages.target)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {t(`accents.${a.labelKey}`)}
              </option>
            ))}
        </select>
      </label>
      <p className="panel-description">
        {t(
          accentSupported(variant.id, project.languages.target)
            ? 'ttsAccentHint'
            : 'ttsAccentUnsupported',
        )}
      </p>
      <OutputGainControl
        value={settings.outputGain ?? 1}
        disabled={busy}
        onChange={(gain) => edit({ outputGain: gain === 1 ? undefined : gain })}
      />
      <VoiceQualityControls
        variant={variant.id}
        value={settings.quality}
        disabled={busy}
        onChange={(quality) => edit({ quality })}
      />
      <label className="field">
        <span>
          {t('ttsSpeed')} · {settings.speed.toFixed(2)}×
        </span>
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.05"
          value={settings.speed}
          disabled={busy}
          onChange={(e) => edit({ speed: Number(e.target.value) })}
        />
      </label>
      <label className="field">
        <span>{t('ttsSeed')}</span>
        <input
          type="number"
          min="0"
          max="4294967295"
          value={settings.seed}
          disabled={busy}
          onChange={(e) =>
            edit({ seed: Math.min(4294967295, Math.max(0, Math.trunc(Number(e.target.value)))) })
          }
        />
      </label>
      {batch ? (
        <BatchDubbingAction
          project={project}
          selectedIds={batch.selectedIds}
          settings={{ ...settings, mode, accent }}
          busy={busy || referencePending}
          ready={!!ready}
          snapshot={snapshot}
          onStarted={onStarted}
          onError={onError}
        />
      ) : (
        <>
          <label className="field">
            <span>{t('ttsResolvedText')}</span>
            <textarea
              aria-label={t('ttsResolvedText')}
              value={line.ttsText ?? dialogueText(project, line, 'target')}
              disabled={busy}
              rows={3}
              onChange={(e) => onEdit((p) => editDialogue(p, line.id, 'tts', e.target.value))}
            />
          </label>
          <p className="panel-description">{t('workbench.sharedVoiceText')}</p>
          {inputText !== (line.ttsText ?? dialogueText(project, line, 'target')) && (
            <p className="pronunciation-preview">
              {t('workbench.resolvedPronunciation')}: {inputText}
            </p>
          )}
          <details className="dub-original-text" open>
            <summary>{t('workbench.originalText')}</summary>
            {(line.sourceCueIds.length
              ? line.sourceCueIds.map((id) => project.sourceCues.find((c) => c.id === id)!)
              : [{ id: '', text: '' }]
            ).map((cue, index, cues) => (
              <label className="field" key={cue.id || 'missing'}>
                <span>
                  {t('original')}
                  {cues.length > 1 ? ` ${index + 1}` : ''}
                </span>
                <textarea
                  aria-label={
                    t('workbench.originalText') + (cues.length > 1 ? ` ${index + 1}` : '')
                  }
                  value={cue.text}
                  disabled={busy}
                  rows={2}
                  onChange={(e) =>
                    onEdit((p) =>
                      cue.id
                        ? editCueText(p, 'source', cue.id, e.target.value)
                        : editDialogue(p, line.id, 'source', e.target.value),
                    )
                  }
                />
              </label>
            ))}
          </details>
          {(referenceMissing ||
            transcriptMissing ||
            shortReference ||
            guideIssue ||
            !inputText) && (
            <p className="warning" role="status">
              {t(
                referenceMissing
                  ? libraryMode
                    ? 'errors.VOICE_LIBRARY_REFERENCE_REQUIRED'
                    : 'errors.TTS_REFERENCE_REQUIRED'
                  : transcriptMissing
                    ? 'errors.TTS_TRANSCRIPT_REQUIRED'
                    : shortReference
                      ? 'ttsReferenceTooShort'
                      : guideIssue
                        ? 'library.guideInputMissing'
                        : 'errors.TTS_TEXT_REQUIRED',
              )}
            </p>
          )}
          <DubbingPipelineControls
            project={project}
            enabled={pipeline}
            setEnabled={setPipeline}
            conversion={conversion}
            setConversion={setConversion}
            strength={guideStrength}
            setStrength={setGuideStrength}
            busy={busy}
            onModels={onModels}
            onReady={setPipelineReady}
          />
          <button
            className="button accent wide"
            disabled={
              !bridge.native ||
              (pipeline && !pipelineReady) ||
              busy ||
              referencePending ||
              !ready ||
              referenceMissing ||
              guideIssue ||
              transcriptMissing ||
              shortReference ||
              !inputText ||
              inputText.length > 1000
            }
            onClick={() => {
              setWorking(true);
              onEdit((p) => ({
                ...editVoiceSettings(p, line.id, { ...settings, mode, accent }),
                modelPreferences: {
                  ...p.modelPreferences,
                  ttsProviderId: variant.providerId,
                  voiceVariantId: variant.id,
                },
              }));
              void snapshot()
                .then(() =>
                  pipeline
                    ? bridge.generateDubbingPipeline({
                        lineId: line.id,
                        tts: { ...settings, mode, accent },
                        conversion,
                        guideStrength,
                      })
                    : bridge.generateLine(line.id, {
                        ...settings,
                        mode,
                        accent,
                      }),
                )
                .then(setCurrentJobId)
                .catch((e) => onError(String(e)))
                .finally(() => setWorking(false));
            }}
          >
            <Mic2 size={15} />
            {t('ttsGenerateNew')}
          </button>
          <CurrentJobProgress job={jobs.find((j) => j.id === currentJobId)} onError={onError} />
          <div className="generation-heading">
            <h3>{t('ttsGenerations', { count: generations.length })}</h3>
            <button
              className="text-button"
              onClick={() => onOriginal(line)}
              disabled={!project.media}
            >
              <Play size={13} />
              {t('original')}
            </button>
          </div>
          <ProsodyTransfer
            key={line.id}
            project={project}
            line={line}
            takes={generations}
            chosen={chosen}
            jobs={jobs}
            snapshot={snapshot}
            onStarted={onStarted}
            onError={onError}
          />
          {generations.length > 1 && (
            <div className="generation-compare">
              <strong>{t('ttsCompare')}</strong>
              {(['A', 'B'] as const).map((letter, index) => {
                const id =
                  (letter === 'A' ? compareA : compareB) || generations.at(-(index + 1))!.id;
                const selected =
                  generations.find((g) => g.id === id) ?? generations.at(-(index + 1))!;
                return (
                  <div key={letter}>
                    <select
                      aria-label={t('ttsCompareTake', { letter })}
                      value={selected.id}
                      onChange={(e) =>
                        letter === 'A' ? setCompareA(e.target.value) : setCompareB(e.target.value)
                      }
                    >
                      {generations.map((g, i) => (
                        <option value={g.id} key={g.id}>
                          {t('ttsGenerationNumber', { number: i + 1 })}
                        </option>
                      ))}
                    </select>
                    <button className="button subtle" onClick={() => onPlay(selected)}>
                      <Play size={12} />
                      {letter}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {!generations.length && <p className="panel-description">{t('ttsNoGeneration')}</p>}
          {[...generations].reverse().map((generation, index) => {
            const active = chosen?.id === generation.id,
              stale = staleGeneration(project, line, generation),
              long = generation.durationMs > line.endMs - line.startMs;
            return (
              <article
                ref={index === 0 ? newestTake : undefined}
                className={`generation-card ${active ? 'selected' : ''}`}
                key={generation.id}
              >
                <strong>
                  {t('ttsGenerationNumber', { number: generations.length - index })} ·{' '}
                  {(generation.durationMs / 1000).toFixed(2)} s {active && <Check size={13} />}
                </strong>
                <small>
                  {voiceVariant(generation.options.variantId)?.name ?? generation.modelId} ·{' '}
                  {generation.deviceName} · {generation.options.speed.toFixed(2)}× · {t('ttsSeed')}{' '}
                  {generation.options.seed}
                  {generation.options.mood && generation.options.mood !== 'default'
                    ? ` · ${t(`moods.${generation.options.mood}`)}`
                    : ''}
                  {generation.options.accent && generation.options.accent !== 'auto'
                    ? ` · ${t(`accents.${voiceAccents.find((a) => a.id === generation.options.accent)?.labelKey}`)}`
                    : ''}
                </small>
                {!generation.takeOrigin && (
                  <details className="generation-quality">
                    <summary>
                      {t('quality.title')} ·{' '}
                      {t(
                        `quality.presets.${qualityPreset(generation.options.variantId ?? 'cosy3-official', generation.options.quality)}`,
                      )}
                    </summary>
                    {Object.entries(
                      resolvedQuality(
                        generation.options.variantId ?? 'cosy3-official',
                        generation.options.quality,
                      ),
                    ).map(([key, number]) => (
                      <small key={key}>
                        {t(`quality.params.${key}`)} : {number}
                      </small>
                    ))}
                  </details>
                )}
                {generation.peakVramMb > 0 && (
                  <small>{t('ttsPeakVram', { mb: generation.peakVramMb })}</small>
                )}
                {generation.compatibilityMode && <small>{t('ttsCompatibleTake')}</small>}
                {generation.qwenRecovery && (
                  <small className="warning">
                    {t('ttsQwenRecovered', {
                      device: generation.qwenRecovery.device,
                      seed: generation.qwenRecovery.effectiveSeed,
                    })}
                  </small>
                )}
                {generation.takeOrigin && (
                  <small className="model-state">
                    {t(
                      generation.takeOrigin.type === 'microphone'
                        ? 'capture.recordedTake'
                        : 'capture.convertedTake',
                    )}
                  </small>
                )}
                {generation.prosodyTransfer && (
                  <small>
                    {t('prosody.take', {
                      percent: Math.round(generation.prosodyTransfer.options.strength * 100),
                    })}
                  </small>
                )}
                {(stale || long) && (
                  <p className="warning">{t(stale ? 'ttsStale' : 'ttsTooLong')}</p>
                )}
                {active && (
                  <OutputGainControl
                    take
                    value={project.voiceEdits?.[generation.id]?.outputGain ?? 1}
                    disabled={busy}
                    commit={(gain) => run(() => bridge.setVoiceOutputGain(generation.id, gain))}
                  />
                )}
                <div className="generation-actions">
                  <button className="button subtle" onClick={() => onPlay(generation)}>
                    <Play size={13} />
                    {t(activeGenerationId === generation.id ? 'ttsStopListening' : 'listen')}
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || active}
                    onClick={() => onEdit((p) => selectGeneration(p, generation.id))}
                  >
                    {t('ttsSelect')}
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void bridge
                        .exportGeneration(generation.id, project.voiceEdits?.[generation.id])
                        .catch((e) => onError(String(e)))
                    }
                  >
                    <Download size={13} />
                    WAV
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    aria-label={t('ttsDeleteGeneration', { number: generations.length - index })}
                    onClick={() => onEdit((p) => deleteGeneration(p, generation.id))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </article>
            );
          })}
          {chosen && (
            <div className="generation-review">
              <span>{t(line.status)}</span>
              <button
                className="button accent"
                disabled={busy || staleGeneration(project, line, chosen)}
                onClick={() => onEdit((p) => reviewGeneration(p, line.id, true))}
              >
                <Check size={14} />
                {t('ttsValidate')}
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => onEdit((p) => reviewGeneration(p, line.id, false))}
              >
                {t('ttsReview')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
