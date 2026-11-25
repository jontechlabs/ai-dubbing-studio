import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Plus, Check, FileText, Mic2 } from 'lucide-react';
import type { Dialogue, Generation, Job, Project, VoiceSettings } from '../domain/types';
import { defaultVoiceSettings, selectGeneration, voiceGenerations } from '../domain/tts';
import {
  parseSpeakerScript,
  scriptSlots,
  type ScriptSlot,
  type ScriptSpeaker,
  type ScriptTurn,
} from '../domain/scriptedDubbing';
import { formatTime, parseTime } from '../domain/time';
import { installedVoiceVariants, voiceVariant } from '../domain/voiceEngines';
import { libraryOf } from '../domain/voiceLibrary';
import * as bridge from '../services/bridge';
import { useDubbingTask } from '../hooks/useDubbingTask';
import { useModelRevision } from '../hooks/useModelRevision';
import { CurrentJobProgress } from './CurrentJobProgress';
import { ReferenceFileImport } from './ReferenceFileImport';
import { ReferenceTranscription } from './ReferenceTranscription';
import { VoiceQualityControls } from './VoiceQualityControls';
import { VoiceAccentControl } from './VoiceAccentControl';
import { OutputGainControl } from './OutputGainControl';
import { BatchRecovery } from './BatchRecovery';
import { TakeDate } from './TakeDate';
import { IconButton } from './IconButton';

function ReferencePreview({ speaker, onPlay }: { speaker: ScriptSpeaker; onPlay: () => void }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    setUrl('');
    if (speaker.referenceId)
      void (
        speaker.referenceMode === 'library'
          ? bridge.voiceLibraryAudioUrl(speaker.characterId!, speaker.referenceId)
          : bridge.voiceReferenceUrl(
              speaker.referenceMode === 'file' ? null : speaker.characterId,
              speaker.referenceId,
            )
      )
        .then((value) => {
          if (active) setUrl(value);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [speaker.characterId, speaker.referenceId, speaker.referenceMode]);
  return url ? (
    <audio controls src={url} preload="metadata" onPlay={onPlay} aria-label={speaker.name} />
  ) : null;
}

export function ScriptedDubbingPanel({
  project,
  line,
  time,
  jobs,
  queueActive,
  snapshot,
  run,
  onEdit,
  onModels,
  onError,
  onPlay,
  onReferencePlay,
  onChooseLine,
  activeGenerationId,
}: {
  project: Project;
  line?: Dialogue;
  time: number;
  jobs: Job[];
  queueActive: boolean;
  snapshot: () => Promise<Project>;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  onEdit: (update: (p: Project) => Project) => void;
  onModels: () => void;
  onError: (error: string) => void;
  onPlay: (g: Generation) => void;
  onReferencePlay: () => void;
  onChooseLine: (line: Dialogue) => void;
  activeGenerationId: string | null;
}) {
  const { t } = useTranslation();
  const [script, setScript] = useState(''),
    [turns, setTurns] = useState<ScriptTurn[]>([]),
    [speakers, setSpeakers] = useState<ScriptSpeaker[]>([]),
    [slots, setSlots] = useState<ScriptSlot[]>([]),
    [start, setStart] = useState(formatTime(line?.startMs ?? time)),
    [duration, setDuration] = useState(3),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false),
    [lineIds, setLineIds] = useState<string[]>([]),
    [checked, setChecked] = useState(''),
    [takeCount, setTakeCount] = useState<1 | 2 | 3 | 4>(1);
  const [settings, setSettings] = useState<VoiceSettings>(() => ({
    ...defaultVoiceSettings,
    variantId: voiceVariant(project.modelPreferences?.voiceVariantId)?.id ?? 'zonos3-mini-gguf',
  }));
  const variant = voiceVariant(settings.variantId)!;
  const mode =
    variant.providerId.startsWith('fish') || variant.providerId === 'audio8-tts'
      ? 'zeroShot'
      : settings.mode;
  const options = {
    script,
    startMs: 0,
    durationMs: 3000,
    slots,
    speakers,
    options: { ...settings, mode },
  };
  const key = JSON.stringify(options) + ':' + project.revision;
  const [status, setStatus] = useState<bridge.VoiceStatus | null>(null),
    [cosy, setCosy] = useState<bridge.TtsStatus | null>(null);
  const modelRevision = useModelRevision();
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setCosy(null);
    if (bridge.native)
      void (
        variant.id === 'cosy3-official'
          ? bridge.ttsStatus().then((s) => {
              if (alive) setCosy(s);
            })
          : bridge.voiceStatus(variant.backend !== 'vulkan').then((s) => {
              if (alive) setStatus(s);
            })
      ).catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [variant.id, variant.backend, modelRevision]);
  const task = useDubbingTask(project, undefined, true, jobs, run);
  const takeNodes = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (!task.focusId) return;
    const card = takeNodes.current.get(task.focusId);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [task.focusId, task.focusKey]);
  const busy =
    working ||
    task.pending ||
    queueActive ||
    jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  const frozen = busy || !!lineIds.length;
  const exists =
    lineIds.length > 0 && lineIds.every((id) => project.dialogues.some((l) => l.id === id));
  const ready =
    variant.id === 'cosy3-official'
      ? cosy?.installed
      : status?.variants.some((v) => v.id === variant.id && v.installed);
  const checking = variant.id === 'cosy3-official' ? !cosy : !status;
  const devices =
    variant.id === 'cosy3-official'
      ? cosy?.inventory.devices
      : variant.backend === 'vulkan'
        ? status?.devices
        : status?.cudaDevices;
  const changeSpeaker = (number: number, patch: Partial<ScriptSpeaker>) =>
    setSpeakers((rows) => rows.map((s) => (s.speaker === number ? { ...s, ...patch } : s)));
  const references = [
    ...(project.voiceReferences ?? []).map((r) => ({
      key: 'file:' + r.id,
      label: r.label,
      mode: 'file' as const,
      owner: null,
      id: r.id,
      reference: r,
    })),
    ...project.characters.flatMap((c) =>
      c.references.map((r) => ({
        key: 'custom:' + c.id + ':' + r.id,
        label: c.name + ' · ' + r.label,
        mode: 'custom' as const,
        owner: c.id,
        id: r.id,
        reference: r,
      })),
    ),
    ...project.characters.flatMap((c) =>
      (libraryOf(project, c.id)?.samples ?? [])
        .filter((s) => s.status === 'approved' && s.reference)
        .map((s) => ({
          key: 'library:' + c.id + ':' + s.id,
          label: c.name + ' · ' + s.reference!.label,
          mode: 'library' as const,
          owner: c.id,
          id: s.id,
          reference: s.reference!,
        })),
    ),
  ];
  const issue = (e: unknown) => setError(String(e).replace(/^Error: /, ''));
  const prepare = () => {
    try {
      const parsed = parseSpeakerScript(script),
        anchor = parseTime(start),
        length = Math.round(duration * 1000);
      if (!Number.isSafeInteger(length) || length < 100 || length > 120_000)
        throw Error('SCRIPT_TIMING_INVALID');
      setTurns(parsed);
      setSlots(scriptSlots(parsed, anchor, length));
      const unique = [...new Set(parsed.map((r) => r.speaker))];
      setSpeakers(
        unique.map(
          (speaker) =>
            speakers.find((s) => s.speaker === speaker) ?? {
              speaker,
              name: parsed.find((r) => r.speaker === speaker)!.label || 'Speaker ' + speaker,
              characterId: null,
              referenceMode: 'file',
              referenceId: '',
            },
        ),
      );
      setError('');
      setChecked('');
    } catch (e) {
      issue(e);
    }
  };
  const editScript = (value: string) => {
    setScript(value);
    setTurns([]);
    setSlots([]);
    setChecked('');
    setError('');
  };
  const imports = lineIds
    .map((id) => project.dialogues.find((l) => l.id === id))
    .filter((l): l is Dialogue => !!l);
  return (
    <div className="panel-body dub-panel scripted-dubbing">
      <p className="panel-description">{t('scriptDubbing.hint')}</p>
      <CurrentJobProgress
        job={task.job}
        starting={task.pending}
        error={task.error}
        onError={onError}
        onDismiss={task.canDismiss ? task.dismiss : undefined}
      />
      {!lineIds.length && (
        <>
          <label className="field">
            <span>{t('scriptDubbing.text')}</span>
            <textarea
              value={script}
              disabled={frozen}
              rows={5}
              placeholder={
                '[Speaker 1: Femme adulte] Mademoiselle Natsuki Kodama.\n[Speaker 2: Jeune fille] Oui !'
              }
              onChange={(e) => editScript(e.target.value)}
            />
          </label>
          <div className="script-timing-row">
            <label className="field">
              <span>{t('scriptDubbing.start')}</span>
              <input value={start} disabled={frozen} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('scriptDubbing.duration')}</span>
              <input
                type="number"
                min={0.1}
                max={120}
                step={0.1}
                value={duration}
                disabled={frozen}
                onChange={(e) => setDuration(e.target.valueAsNumber)}
              />
            </label>
          </div>
          <button
            className="button subtle wide"
            disabled={frozen || !script.trim()}
            onClick={prepare}
          >
            <FileText size={14} />
            {t('scriptDubbing.prepare')}
          </button>
          {!!turns.length && (
            <>
              <details className="settings-section" open>
                <summary>{t('scriptDubbing.engine')}</summary>
                <label className="field">
                  <span>{t('scriptDubbing.model')}</span>
                  <select
                    value={variant.id}
                    disabled={frozen}
                    onChange={(e) => {
                      const next = voiceVariant(e.target.value)!;
                      setSettings({
                        ...defaultVoiceSettings,
                        variantId: next.id,
                        mode:
                          next.providerId.startsWith('fish') || next.providerId === 'audio8-tts'
                            ? 'zeroShot'
                            : 'crossLingual',
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
                {!ready && (
                  <p role="status">
                    {t(checking ? 'phase6Checking' : 'ttsNeedsInstallation')}{' '}
                    <button className="text-button" onClick={onModels}>
                      {t('models')}
                    </button>
                  </p>
                )}
                <label className="field">
                  <span>{t('ttsDevice')}</span>
                  <select
                    value={settings.device}
                    disabled={frozen}
                    onChange={(e) => setSettings({ ...settings, device: e.target.value })}
                  >
                    <option value="auto">{t('ttsDeviceAuto')}</option>
                    {devices
                      ?.filter((d) => d.id !== 'auto')
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </select>
                </label>
                {!variant.providerId.startsWith('fish') &&
                  !['audio8-tts', 'zonos3', 'moss-tts-local', 'chatterbox'].includes(
                    variant.providerId,
                  ) && (
                    <label className="field">
                      <span>{t('ttsCloneMode')}</span>
                      <select
                        value={mode}
                        disabled={frozen}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            mode: e.target.value as VoiceSettings['mode'],
                          })
                        }
                      >
                        <option value="crossLingual">{t('ttsCrossLingual')}</option>
                        <option value="zeroShot">{t('ttsZeroShot')}</option>
                      </select>
                    </label>
                  )}
                <VoiceAccentControl
                  settings={{ ...settings, mode }}
                  language={project.languages.target}
                  busy={frozen}
                  onChange={(patch) => setSettings({ ...settings, ...patch })}
                />
                <VoiceQualityControls
                  variant={variant.id}
                  value={settings.quality}
                  disabled={frozen}
                  onChange={(quality) => setSettings({ ...settings, quality })}
                />
                <OutputGainControl
                  value={settings.outputGain ?? 1}
                  disabled={frozen}
                  onChange={(outputGain) => setSettings({ ...settings, outputGain })}
                />
                <div className="script-timing-row">
                  <label className="field">
                    <span>{t('ttsSpeed')}</span>
                    <input
                      type="number"
                      min={0.5}
                      max={2}
                      step={0.05}
                      value={settings.speed}
                      disabled={frozen}
                      onChange={(e) => setSettings({ ...settings, speed: e.target.valueAsNumber })}
                    />
                  </label>
                  <label className="field">
                    <span>{t('ttsSeed')}</span>
                    <input
                      type="number"
                      min={0}
                      max={4294967295}
                      step={1}
                      value={settings.seed}
                      disabled={frozen}
                      onChange={(e) => setSettings({ ...settings, seed: e.target.valueAsNumber })}
                    />
                  </label>
                </div>
              </details>
              {speakers.map((s) => {
                const chosen = references.find(
                  (r) =>
                    r.id === s.referenceId &&
                    r.mode === s.referenceMode &&
                    (r.mode === 'file' || r.owner === s.characterId),
                );
                return (
                  <fieldset
                    className="settings-section script-speaker"
                    key={s.speaker}
                    disabled={frozen}
                  >
                    <legend>Speaker {s.speaker}</legend>
                    <label className="field">
                      <span>{t('scriptDubbing.name')}</span>
                      <input
                        value={s.name}
                        maxLength={80}
                        onChange={(e) => changeSpeaker(s.speaker, { name: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>{t('ttsReferenceMode')}</span>
                      <select
                        value={chosen?.key ?? ''}
                        onChange={(e) => {
                          const r = references.find((r) => r.key === e.target.value);
                          changeSpeaker(
                            s.speaker,
                            r
                              ? {
                                  referenceMode: r.mode,
                                  referenceId: r.id,
                                  characterId: r.owner ?? s.characterId,
                                }
                              : { referenceId: '' },
                          );
                        }}
                      >
                        <option value="">{t('scriptDubbing.chooseReference')}</option>
                        {references.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{t('character')}</span>
                      <select
                        value={s.characterId ?? ''}
                        disabled={s.referenceMode !== 'file' && !!s.referenceId}
                        onChange={(e) =>
                          changeSpeaker(s.speaker, { characterId: e.target.value || null })
                        }
                      >
                        <option value="">{t('unassigned')}</option>
                        {project.characters.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <ReferencePreview speaker={s} onPlay={onReferencePlay} />
                    <ReferenceFileImport
                      busy={frozen}
                      onError={issue}
                      onImport={async (file) => {
                        let success = false;
                        setWorking(true);
                        try {
                          await run(async () => {
                            await snapshot();
                            const next = await bridge.importDubbingReference(
                              null,
                              { ...settings, mode },
                              file,
                            );
                            const r = next?.voiceReferences?.at(-1);
                            if (r) {
                              changeSpeaker(s.speaker, {
                                referenceMode: 'file',
                                referenceId: r.id,
                              });
                              success = true;
                            }
                            return next;
                          });
                          return success;
                        } finally {
                          setWorking(false);
                        }
                      }}
                    />
                    {chosen && mode === 'zeroShot' && !chosen.reference.transcript.trim() && (
                      <p className="warning">{t('scriptDubbing.transcript')}</p>
                    )}
                    {chosen && chosen.mode !== 'library' && (
                      <details>
                        <summary>{t('asrTranscribe')}</summary>
                        <ReferenceTranscription
                          busy={frozen}
                          onError={issue}
                          start={async (language) => {
                            await task.start(async () => {
                              await snapshot();
                              return bridge.transcribeVoiceReference(
                                chosen.owner,
                                chosen.id,
                                language,
                              );
                            });
                          }}
                        />
                      </details>
                    )}
                  </fieldset>
                );
              })}
              <section className="settings-section script-turns">
                <h3>{t('scriptDubbing.slots')}</h3>
                <p className="panel-description">{t('scriptDubbing.overlap')}</p>
                {turns.map((turn, index) => (
                  <fieldset key={index} disabled={frozen}>
                    <legend>
                      {index + 1} · {speakers.find((s) => s.speaker === turn.speaker)?.name}
                    </legend>
                    <p>{turn.text}</p>
                    <div className="script-timing-row">
                      {(['startMs', 'endMs'] as const).map((edge) => (
                        <label className="field" key={edge}>
                          <span>
                            {t(
                              edge === 'startMs'
                                ? 'scriptDubbing.turnStart'
                                : 'scriptDubbing.turnEnd',
                            )}
                          </span>
                          <input
                            type="number"
                            min={0}
                            max={(project.media?.durationMs ?? 0) / 1000}
                            step={0.001}
                            value={slots[index][edge] / 1000}
                            onChange={(e) =>
                              setSlots((rows) =>
                                rows.map((slot, i) =>
                                  i === index
                                    ? { ...slot, [edge]: Math.round(e.target.valueAsNumber * 1000) }
                                    : slot,
                                ),
                              )
                            }
                          />
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </section>
              <p className="panel-description">{t('scriptDubbing.preserve')}</p>
              <button
                className="button subtle wide"
                disabled={frozen || !bridge.native}
                onClick={() => {
                  setWorking(true);
                  setError('');
                  setChecked('');
                  void (async () => {
                    const saved = await snapshot();
                    await bridge.previewScriptedDubbing(options);
                    setChecked(JSON.stringify(options) + ':' + saved.revision);
                  })()
                    .catch(issue)
                    .finally(() => setWorking(false));
                }}
              >
                <Check size={14} />
                {t('scriptDubbing.check')}
              </button>
              {checked === key && (
                <p role="status">
                  {t('scriptDubbing.valid', { count: turns.length, speakers: speakers.length })}
                </p>
              )}
              <button
                className="button accent wide"
                disabled={frozen || !bridge.native || checked !== key}
                onClick={() => {
                  setWorking(true);
                  setError('');
                  void run(async () => {
                    const saved = await snapshot();
                    const created = await bridge.createScriptedDubbing(saved, options);
                    setLineIds(created.lineIds);
                    return created.project;
                  }).finally(() => setWorking(false));
                }}
              >
                <Plus size={14} />
                {t('scriptDubbing.create')}
              </button>
            </>
          )}
        </>
      )}
      {!!lineIds.length && (
        <>
          <p role="status">
            {t(exists ? 'scriptDubbing.created' : 'scriptDubbing.removed', {
              count: lineIds.length,
            })}
          </p>
          <label className="field">
            <span>{t('batchTakes.count')}</span>
            <select
              value={takeCount}
              disabled={busy}
              onChange={(e) => setTakeCount(Number(e.target.value) as 1 | 2 | 3 | 4)}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {!ready && (
            <button className="button subtle" onClick={onModels}>
              {t('models')}
            </button>
          )}
          <button
            className="button accent wide"
            disabled={busy || !exists || !ready || !bridge.native}
            onClick={() => {
              setError('');
              void task
                .start(async () =>
                  bridge.generateScriptedDubbing(await snapshot(), { lineIds, takeCount }),
                )
                .catch(issue);
            }}
          >
            <Mic2 size={14} />
            {t('scriptDubbing.generate', { count: lineIds.length * takeCount })}
          </button>
          {task.batchReportId && (
            <BatchRecovery
              project={project}
              reportId={task.batchReportId}
              job={task.job}
              starting={task.pending}
              onDismiss={task.dismiss}
              busy={busy}
              snapshot={snapshot}
              startTask={task.start}
              onError={issue}
              onChooseLine={(id) => {
                const l = project.dialogues.find((l) => l.id === id);
                if (l) onChooseLine(l);
              }}
            />
          )}
          {imports.map((l) => (
            <section className="settings-section" key={l.id}>
              <button className="text-button" onClick={() => onChooseLine(l)}>
                {
                  project.dubbingLanes?.lanes.find(
                    (lane) => lane.id === project.dubbingLanes?.assignments[l.id],
                  )?.name
                }{' '}
                · {formatTime(l.startMs)} → {formatTime(l.endMs)}
              </button>
              {voiceGenerations(project)
                .filter((g) => g.dialogueId === l.id && g.language === project.languages.target)
                .map((g, index) => (
                  <div
                    className="script-take"
                    key={g.id}
                    tabIndex={-1}
                    ref={(node) => {
                      if (node) takeNodes.current.set(g.id, node);
                      else takeNodes.current.delete(g.id);
                    }}
                  >
                    <IconButton
                      label={t('ttsListenDub')}
                      onClick={() => onPlay(g)}
                      aria-pressed={activeGenerationId === g.id}
                    >
                      <Play size={14} />
                    </IconButton>
                    <span>
                      {t('ttsGenerationNumber', { number: index + 1 })}
                      <TakeDate value={g.createdAt} />
                    </span>
                    <IconButton
                      label={t('ttsSelect')}
                      disabled={busy}
                      aria-pressed={l.selectedGenerationIds[project.languages.target] === g.id}
                      onClick={() => onEdit((p) => selectGeneration(p, g.id))}
                    >
                      <Check size={14} />
                    </IconButton>
                  </div>
                ))}
            </section>
          ))}
          <button
            className="button subtle wide"
            disabled={busy}
            onClick={() => {
              task.dismiss();
              setLineIds([]);
              setScript('');
              setTurns([]);
              setSlots([]);
              setChecked('');
              setError('');
            }}
          >
            {t('scriptDubbing.new')}
          </button>
        </>
      )}
      {error && <p role="alert">{t(`errors.${error}`, { defaultValue: error })}</p>}
    </div>
  );
}
