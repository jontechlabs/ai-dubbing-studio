import { useEffect, useState } from 'react';
import { Check, Download, Mic2, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Generation, Job, Project } from '../domain/types';
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
import {
  dubbingOffset,
  moveDubbing,
  dubbingClips,
  dubbingDuration,
  resizeDubbing,
} from '../domain/mix';

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

export function DubPanel({
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
  onPlay,
  activeGenerationId,
}: {
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
  onPlay: (generation: Generation) => void;
  activeGenerationId: string | null;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<bridge.TtsStatus | null>(null),
    [working, setWorking] = useState(false);
  const [engines, setEngines] = useState<bridge.VoiceStatus | null>(null);
  const variantId =
    line?.voiceSettings?.variantId ??
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
          : bridge.voiceStatus(variantId === 'fish-s2-fp8').then((s) => {
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
  const settings = {
    ...(line.voiceSettings ?? defaultVoiceSettings),
    variantId: line.voiceSettings?.variantId ?? preferred?.id ?? 'cosy3-official',
  };
  const variant = voiceVariant(settings.variantId)!;
  const mood = settings.mood ?? 'default';
  const instructedMood = variant.providerId === 'cosyvoice3' && mood !== 'default';
  const mode =
    variant.providerId === 'fish-s2' ? 'zeroShot' : instructedMood ? 'crossLingual' : settings.mode;
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
        : engines?.cudaDevices.filter((d) => d.id.startsWith('cuda:'));
  const character = project.characters.find((c) => c.id === line.characterId);
  const reference = character?.references.find(
    (r) =>
      r.id ===
      (settings.referenceMode === 'custom' ? settings.referenceId : character.defaultReferenceId),
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
  const shortReference =
    settings.referenceMode === 'current'
      ? line.endMs - line.startMs < 1000
      : !!reference && reference.durationMs < 1000;
  const edit = (change: Partial<typeof settings>) =>
    onEdit((p) => editVoiceSettings(p, line.id, { ...settings, mode, ...change }));
  return (
    <div className="panel-body dub-panel">
      <h3>{variant.name}</h3>
      {chosen && project.media && (
        <div className="settings-section">
          <button className="button accent wide" onClick={onLips} disabled={busy}>
            {t('lipsAnalyze')}
          </button>
          <button className="button subtle wide" onClick={onInpaint} disabled={busy}>
            {t('inpaintOpen')}
          </button>
          <label className="field">
            <span>{t('dubbingOffset')}</span>
            <input
              type="number"
              step="10"
              min={-line.startMs}
              max={project.media.durationMs - 1 - line.startMs}
              value={dubbingOffset(project, line.id)}
              disabled={busy}
              onChange={(event) => {
                if (event.target.value !== '')
                  onEdit((p) => moveDubbing(p, line.id, Number(event.target.value)));
              }}
            />
          </label>
          <button
            className="text-button"
            disabled={busy || dubbingOffset(project, line.id) === 0}
            onClick={() => onEdit((p) => moveDubbing(p, line.id, 0))}
          >
            {t('dubbingResetOffset')}
          </button>
          <p className="panel-description">{t('dubbingOffsetHint')}</p>
          <label className="field">
            <span>{t('dubbingDuration')}</span>
            <input
              type="number"
              min="1"
              max="120000"
              step="10"
              disabled={busy}
              value={
                dubbingDuration(project, line.id) ??
                (() => {
                  const clip = dubbingClips(project).find((c) => c.line.id === line.id);
                  return clip ? clip.endMs - clip.startMs : undefined;
                })() ??
                chosen.durationMs
              }
              onChange={(event) => {
                const value = Number(event.target.value);
                if (value >= 1 && value <= 120000) onEdit((p) => resizeDubbing(p, line.id, value));
              }}
            />
          </label>
          <button
            className="text-button"
            disabled={busy || dubbingDuration(project, line.id) === undefined}
            onClick={() => onEdit((p) => resizeDubbing(p, line.id, null))}
          >
            {t('dubbingAutoDuration')}
          </button>
          <p className="panel-description">{t('dubbingDurationHint')}</p>
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
              device: 'auto',
              mood: next.providerId === 'qwen3-tts' ? 'default' : mood,
              mode: next.providerId === 'fish-s2' ? 'zeroShot' : settings.mode,
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
            variant.backend === 'vulkan'
              ? 'phase6Gguf'
              : variant.id === 'fish-s2-fp8'
                ? 'phase6Fp8'
                : 'ttsLocalHint',
          )}
        </p>
      )}
      <p className="panel-description">{t('ttsLocalHint')}</p>
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
          {variant.id !== 'fish-s2-fp8' && !devices?.some((d) => d.id === 'cpu') && (
            <option value="cpu">CPU</option>
          )}
        </select>
      </label>
      <label className="field">
        <span>{t('ttsReferenceMode')}</span>
        <select
          value={settings.referenceMode}
          disabled={busy}
          onChange={(e) => edit({ referenceMode: e.target.value as typeof settings.referenceMode })}
        >
          <option value="character">{t('ttsReferenceDefault')}</option>
          <option value="current">{t('ttsReferenceCurrent')}</option>
          <option value="custom">{t('ttsReferenceCustom')}</option>
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
      {settings.referenceMode === 'custom' && (
        <label className="field">
          <span>{t('ttsReferenceChoice')}</span>
          <select
            value={settings.referenceId ?? ''}
            disabled={busy}
            onChange={(e) => edit({ referenceId: e.target.value || null })}
          >
            <option value="">{t('ttsChooseReference')}</option>
            {character?.references.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} · {(r.durationMs / 1000).toFixed(1)} s
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="panel-description">
        {settings.referenceMode === 'current'
          ? t('ttsCurrentReferenceHint')
          : reference
            ? `${character?.name} · ${reference.label} · ${(reference.durationMs / 1000).toFixed(1)} s`
            : t('ttsReferenceMissing')}
      </p>
      <button className="text-button" onClick={onCharacters}>
        {t('ttsManageReferences')}
      </button>
      {settings.referenceMode !== 'current' && character && reference && (
        <>
          <ReferenceTranscription
            busy={busy || shortReference}
            onError={onError}
            start={async (language) => {
              await snapshot();
              await bridge.transcribeVoiceReference(character.id, reference.id, language);
              onStarted();
            }}
          />
          <label className="field">
            <span>{t('referenceTranscript')}</span>
            <textarea value={reference.transcript} readOnly rows={3} />
          </label>
          <p className="panel-description">{t('asrDubReviewHint')}</p>
        </>
      )}
      {settings.referenceMode === 'current' && transcriptMissing && (
        <p className="panel-description">{t('asrCurrentHint')}</p>
      )}
      <label className="field">
        <span>{t('ttsCloneMode')}</span>
        <select
          value={mode}
          disabled={busy || instructedMood}
          onChange={(e) => edit({ mode: e.target.value as typeof settings.mode })}
        >
          <option value="crossLingual" disabled={variant.providerId === 'fish-s2'}>
            {t('ttsCrossLingual')}
          </option>
          <option value="zeroShot">{t('ttsZeroShot')}</option>
        </select>
      </label>
      <p className="panel-description">
        {t(
          instructedMood
            ? 'ttsCosyMoodHint'
            : variant.providerId === 'fish-s2'
              ? 'ttsFishHint'
              : mode === 'crossLingual'
                ? 'ttsCrossHint'
                : 'ttsZeroHint',
        )}
      </p>
      <label className="field">
        <span>{t('ttsMood')}</span>
        <select
          value={variant.providerId === 'qwen3-tts' ? 'default' : mood}
          disabled={busy || variant.providerId === 'qwen3-tts'}
          onChange={(event) => edit({ mood: event.target.value as typeof settings.mood })}
        >
          {(['default', 'angry', 'happy', 'sad', 'calm', 'surprised', 'whisper'] as const).map(
            (value) => (
              <option key={value} value={value}>
                {t(`moods.${value}`)}
              </option>
            ),
          )}
        </select>
      </label>
      <p className="panel-description">
        {t(variant.providerId === 'qwen3-tts' ? 'ttsMoodUnsupported' : 'ttsMoodHint')}
      </p>
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
      <label className="field">
        <span>{t('ttsResolvedText')}</span>
        <textarea value={inputText} readOnly rows={3} />
      </label>
      <p className="panel-description">{t('ttsEditPronunciationHint')}</p>
      {(referenceMissing || transcriptMissing || shortReference || !inputText) && (
        <p className="warning" role="status">
          {t(
            referenceMissing
              ? 'errors.TTS_REFERENCE_REQUIRED'
              : transcriptMissing
                ? 'errors.TTS_TRANSCRIPT_REQUIRED'
                : shortReference
                  ? 'ttsReferenceTooShort'
                  : 'errors.TTS_TEXT_REQUIRED',
          )}
        </p>
      )}
      <button
        className="button accent wide"
        disabled={
          !bridge.native ||
          busy ||
          !ready ||
          referenceMissing ||
          transcriptMissing ||
          shortReference ||
          !inputText ||
          inputText.length > 1000
        }
        onClick={() => {
          setWorking(true);
          onEdit((p) => ({
            ...editVoiceSettings(p, line.id, { ...settings, mode }),
            modelPreferences: {
              ...p.modelPreferences,
              ttsProviderId: variant.providerId,
              voiceVariantId: variant.id,
            },
          }));
          void snapshot()
            .then(() =>
              bridge.generateLine(line.id, {
                ...settings,
                mode,
              }),
            )
            .then(onStarted)
            .catch((e) => onError(String(e)))
            .finally(() => setWorking(false));
        }}
      >
        <Mic2 size={15} />
        {t('ttsGenerateNew')}
      </button>
      <div className="generation-heading">
        <h3>{t('ttsGenerations', { count: generations.length })}</h3>
        <button className="text-button" onClick={() => onOriginal(line)} disabled={!project.media}>
          <Play size={13} />
          {t('original')}
        </button>
      </div>
      {generations.length > 1 && (
        <div className="generation-compare">
          <strong>{t('ttsCompare')}</strong>
          {(['A', 'B'] as const).map((letter, index) => {
            const id = (letter === 'A' ? compareA : compareB) || generations.at(-(index + 1))!.id;
            const selected = generations.find((g) => g.id === id) ?? generations.at(-(index + 1))!;
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
          <article className={`generation-card ${active ? 'selected' : ''}`} key={generation.id}>
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
            </small>
            {generation.peakVramMb > 0 && (
              <small>{t('ttsPeakVram', { mb: generation.peakVramMb })}</small>
            )}
            {generation.compatibilityMode && <small>{t('ttsCompatibleTake')}</small>}
            {(stale || long) && <p className="warning">{t(stale ? 'ttsStale' : 'ttsTooLong')}</p>}
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
                  void bridge.exportGeneration(generation.id).catch((e) => onError(String(e)))
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
    </div>
  );
}
