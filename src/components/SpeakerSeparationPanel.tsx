import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Job, Project } from '../domain/types';
import type { AudioToolboxStatus } from '../domain/audioToolbox';
import type { SpeakerDubbingAssignment, SpeakerSeparationResult } from '../domain/speakerDubbing';
import { isolatedVoice, setSpeakerDubbingGroup } from '../domain/speakerDubbing';
import { audioTracks, trackLabel } from '../domain/audio';
import * as bridge from '../services/bridge';

export function SpeakerSeparationPanel({
  project,
  line,
  jobs,
  busy,
  startTask,
  snapshot,
  run,
  onEdit,
  onChoose,
  onError,
  onAudition,
}: {
  project: Project;
  line: Dialogue;
  jobs: Job[];
  busy: boolean;
  startTask: (operation: () => Promise<string>) => Promise<string>;
  snapshot: () => Promise<Project>;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  onEdit: (edit: (p: Project) => Project) => void;
  onChoose: (line: Dialogue) => void;
  onError: (error: string) => void;
  onAudition: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState<AudioToolboxStatus | null>(null);
  const [modelId, setModel] = useState('mossformer2-16k'),
    [device, setDevice] = useState('cpu'),
    [source, setSource] = useState('auto');
  const [jobId, setJob] = useState(''),
    [result, setResult] = useState<SpeakerSeparationResult | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({}),
    [voices, setVoices] = useState<SpeakerDubbingAssignment[]>([]);
  const [destinations, setDestinations] = useState<Record<string, string>>({}),
    [mode, setMode] = useState<'replace' | 'add'>('replace'),
    [mute, setMute] = useState(false),
    [working, setWorking] = useState(false);
  const child = isolatedVoice(project, line.id),
    parentId = child?.group.parentId ?? line.id;
  const groups = (project.speakerDubbings ?? []).filter((g) => g.parentId === parentId);
  const active = groups.find((g) => g.active),
    job = jobs.find((j) => j.id === jobId);
  const completion = jobs
    .filter((j) => j.kind === 'speakerSeparationInstall')
    .map((j) => j.id + j.status)
    .join('|');
  useEffect(() => {
    let disposed = false;
    if (open && bridge.native)
      void bridge
        .speakerSeparationStatus()
        .then((v) => {
          if (!disposed) setStatus(v);
        })
        .catch((e) => {
          if (!disposed) onError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [open, completion, onError]);
  useEffect(() => {
    let disposed = false;
    if (job?.status === 'succeeded' && job.kind === 'speakerSeparation')
      void bridge
        .speakerSeparationResult(job.id)
        .then(async (v) => {
          const rows = await Promise.all(
            v.outputs.map(async (id) => [id, await bridge.speakerSeparationUrl(v.id, id)] as const),
          );
          if (!disposed) {
            setResult(v);
            setUrls(Object.fromEntries(rows));
            setVoices(
              v.outputs.map((id, i) => ({
                outputId: id,
                label: t('overlap.voice', { number: i + 1 }),
                characterId: null,
                sourceText: '',
                targetText: '',
              })),
            );
          }
        })
        .catch((e) => {
          if (!disposed) onError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [job?.id, job?.kind, job?.status, onError, t]);
  const model = status?.models.find((m) => m.id === modelId),
    tracks = audioTracks(project).filter((t) => t.kind !== 'dubbing');
  const noSpace =
    !!model &&
    status?.availableBytes !== null &&
    status?.availableBytes !== undefined &&
    !model.installed &&
    status.availableBytes < model.requiredBytes;
  const disabled = busy || working;
  const begin = (operation: () => Promise<string>) => {
    setWorking(true);
    void startTask(operation)
      .then(setJob)
      .catch((e) => onError(String(e)))
      .finally(() => setWorking(false));
  };
  return (
    <details
      className="speaker-separation"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{t('overlap.title')}</summary>
      <p className="panel-description">{t('overlap.hint')}</p>
      {!!groups.length && (
        <>
          <label className="field">
            <span>{t('overlap.variant')}</span>
            <select
              disabled={disabled}
              value={active?.id ?? ''}
              onChange={(e) =>
                onEdit((p) => setSpeakerDubbingGroup(p, parentId, e.target.value || null))
              }
            >
              <option value="">{t('overlap.parentTake')}</option>
              {groups.map((g, i) => (
                <option key={g.id} value={g.id}>
                  {t('overlap.group', { number: i + 1 })} · {g.voices.length} · {g.modelId}
                </option>
              ))}
            </select>
          </label>
          <div className="reference-actions">
            <button
              className="button subtle"
              onClick={() => {
                const l = project.dialogues.find((l) => l.id === parentId);
                if (l) onChoose(l);
              }}
            >
              {t('overlap.parent')}
            </button>
            {(child?.group ?? active)?.voices.map((v) => (
              <button
                className="button subtle"
                key={v.lineId}
                onClick={() => {
                  const l = project.dialogues.find((l) => l.id === v.lineId);
                  if (l) onChoose(l);
                }}
              >
                {v.label}
              </button>
            ))}
          </div>
          <small>{t('overlap.preserved')}</small>
        </>
      )}
      {!child && (
        <>
          <label className="field">
            <span>{t('overlap.model')}</span>
            <select disabled={disabled} value={modelId} onChange={(e) => setModel(e.target.value)}>
              {(
                status?.models ?? [{ id: 'mossformer2-16k', name: 'MossFormer2 · 2 voix · 16 kHz' }]
              ).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('overlap.source')}</span>
            <select disabled={disabled} value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="auto">{t('overlap.defaultSource')}</option>
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name ?? t(trackLabel(track))}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('ttsDevice')}</span>
            <select disabled={disabled} value={device} onChange={(e) => setDevice(e.target.value)}>
              {(status?.devices ?? [{ id: 'cpu', name: 'CPU' }]).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          {model && (
            <small>
              {t('overlap.disk', {
                required: (model.requiredBytes / 1024 ** 3).toFixed(1),
                available:
                  status?.availableBytes == null
                    ? '?'
                    : (status.availableBytes / 1024 ** 3).toFixed(1),
              })}
            </small>
          )}
          <button
            className="button accent wide"
            disabled={
              !bridge.native ||
              disabled ||
              !model ||
              noSpace ||
              (model.installed &&
                (line.endMs - line.startMs < 100 || line.endMs - line.startMs > 60000))
            }
            onClick={() =>
              begin(async () => {
                await snapshot();
                if (!model?.installed) return bridge.installSpeakerSeparationModel(modelId);
                setResult(null);
                setUrls({});
                return bridge.separateDialogueSpeakers({
                  lineId: line.id,
                  modelId,
                  sourceTrackId: source,
                  startMs: line.startMs,
                  endMs: line.endMs,
                  device,
                  prompt: '',
                  windowSeconds: 2,
                });
              })
            }
          >
            {t(model?.installed ? 'overlap.separate' : 'overlap.install')}
          </button>
          {noSpace && <p className="panel-description">{t('overlap.noSpace')}</p>}
        </>
      )}
      {result && (
        <div className="speaker-separation-results">
          <p className="panel-description">{t('overlap.review')}</p>
          {voices.map((voice, index) => (
            <fieldset key={voice.outputId} disabled={disabled}>
              <legend>{voice.label}</legend>
              <audio
                controls
                src={urls[voice.outputId]}
                preload="metadata"
                aria-label={voice.label}
                onPlay={(e) => {
                  document.querySelectorAll('audio').forEach((a) => {
                    if (a !== e.currentTarget) a.pause();
                  });
                  onAudition();
                }}
              />
              <label className="field">
                <span>{t('overlap.label')}</span>
                <input
                  value={voice.label}
                  maxLength={200}
                  onChange={(e) =>
                    setVoices((rows) =>
                      rows.map((v, i) => (i === index ? { ...v, label: e.target.value } : v)),
                    )
                  }
                />
              </label>
              <label className="field">
                <span>{t('character')}</span>
                <select
                  value={voice.characterId ?? ''}
                  onChange={(e) =>
                    setVoices((rows) =>
                      rows.map((v, i) =>
                        i === index ? { ...v, characterId: e.target.value || null } : v,
                      ),
                    )
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
              <label className="field">
                <span>{t('original')}</span>
                <textarea
                  rows={2}
                  value={voice.sourceText}
                  onChange={(e) =>
                    setVoices((rows) =>
                      rows.map((v, i) => (i === index ? { ...v, sourceText: e.target.value } : v)),
                    )
                  }
                />
              </label>
              <label className="field">
                <span>{t('overlap.translation')}</span>
                <textarea
                  rows={2}
                  value={voice.targetText}
                  onChange={(e) =>
                    setVoices((rows) =>
                      rows.map((v, i) => (i === index ? { ...v, targetText: e.target.value } : v)),
                    )
                  }
                />
              </label>
              <label className="field">
                <span>{t('overlap.destination')}</span>
                <select
                  value={destinations[voice.outputId] ?? ''}
                  onChange={(e) =>
                    setDestinations({ ...destinations, [voice.outputId]: e.target.value })
                  }
                >
                  <option value="">{t('overlap.skipTrack')}</option>
                  {tracks
                    .filter((t) => t.kind === 'audio')
                    .map((track) => (
                      <option key={track.id} value={track.id}>
                        {track.name ?? t(trackLabel(track))}
                      </option>
                    ))}
                  {['speech', 'music', 'sfx'].map((role) => (
                    <option key={role} value={'role:' + role}>
                      {t('overlap.role.' + role)}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          ))}
          <label className="field">
            <span>{t('overlap.routing')}</span>
            <select
              disabled={disabled}
              value={mode}
              onChange={(e) => setMode(e.target.value as 'replace' | 'add')}
            >
              <option value="replace">{t('overlap.replace')}</option>
              <option value="add">{t('overlap.add')}</option>
            </select>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              disabled={disabled}
              checked={mute}
              onChange={(e) => setMute(e.target.checked)}
            />
            {t('overlap.muteSource')}
          </label>
          <button
            className="button subtle wide"
            disabled={disabled || !Object.values(destinations).some(Boolean)}
            onClick={() => {
              void run(async () => {
                await snapshot();
                return bridge.applySpeakerSeparationResult(
                  result.id,
                  voices
                    .filter((v) => destinations[v.outputId])
                    .map((v) => {
                      const value = destinations[v.outputId];
                      return {
                        outputId: v.outputId,
                        trackId: value.startsWith('role:') ? null : value,
                        role: value.startsWith('role:')
                          ? (value.slice(5) as 'speech' | 'music' | 'sfx')
                          : null,
                        mode,
                      };
                    }),
                  mute,
                );
              }).catch((e) => onError(String(e)));
            }}
          >
            {t('overlap.applyTracks')}
          </button>
          <button
            className="button accent wide"
            disabled={disabled}
            onClick={() => {
              setWorking(true);
              void run(async () => {
                await snapshot();
                const p = await bridge.createSpeakerDubbings(result.id, voices);
                return p;
              })
                .then(() => setResult(null))
                .catch((e) => onError(String(e)))
                .finally(() => setWorking(false));
            }}
          >
            {t('overlap.createDubs')}
          </button>
        </div>
      )}
    </details>
  );
}
