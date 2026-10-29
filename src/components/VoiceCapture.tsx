import { useEffect, useState, useSyncExternalStore } from 'react';
import { Mic, Square, AudioLines } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Generation, Job, Project } from '../domain/types';
import { defaultVoiceSettings } from '../domain/tts';
import {
  discardMicrophone,
  readMicrophone,
  saveMicrophone,
  startMicrophone,
  stopMicrophone,
  subscribeMicrophone,
} from '../services/microphone';
import * as bridge from '../services/bridge';
import { ReferenceFileImport } from './ReferenceFileImport';

export function MicrophoneIndicator({ onOpen }: { onOpen: () => void }) {
  const state = useSyncExternalStore(subscribeMicrophone, readMicrophone);
  const { t } = useTranslation();
  if (state.phase === 'idle') return null;
  return (
    <aside className="microphone-indicator" role="status">
      <Mic size={16} />
      <button className="text-button" onClick={onOpen}>
        {t('capture.' + state.phase)} · {(state.durationMs / 1000).toFixed(1)} s
      </button>
      {state.phase === 'recording' && (
        <button className="button subtle" onClick={() => void stopMicrophone()}>
          {t('capture.stop')}
        </button>
      )}
      <button
        className="button subtle"
        disabled={state.phase === 'saving'}
        onClick={discardMicrophone}
      >
        {t('capture.discard')}
      </button>
    </aside>
  );
}
export function VoiceCapture({
  project,
  line,
  takes,
  chosen,
  jobs,
  snapshot,
  run,
  startTask,
  onError,
  onModels,
}: {
  project: Project;
  line: Dialogue;
  takes: Generation[];
  chosen: Generation | undefined;
  jobs: Job[];
  snapshot: () => Promise<Project>;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  startTask: (operation: () => Promise<string>) => Promise<string>;
  onError: (error: string) => void;
  onModels: () => void;
}) {
  const { t } = useTranslation();
  const mic = useSyncExternalStore(subscribeMicrophone, readMicrophone);
  const [micOpen, setMicOpen] = useState(false),
    [vcOpen, setVcOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [device, setDevice] = useState('');
  const [working, setWorking] = useState(false),
    [sourceId, setSourceId] = useState(chosen?.id ?? takes.at(-1)?.id ?? '');
  const character = project.characters.find((c) => c.id === line.characterId);
  const [referenceValue, setReferenceValue] = useState(
    character?.defaultReferenceId
      ? `character:${character.id}:${character.defaultReferenceId}`
      : '',
  );
  const [gpu, setGpu] = useState('auto'),
    [status, setStatus] = useState<bridge.VoiceStatus | null>(null),
    [preview, setPreview] = useState('');
  const [pending, setPending] = useState(false);
  const completion = jobs
    .filter((j) => j.kind === 'ttsInstall' || j.kind === 'modelMove')
    .map((j) => j.id + j.status)
    .join('|');
  const busy = working || jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  const owns = mic.projectId === project.id && mic.lineId === line.id;
  const source = takes.find((g) => g.id === sourceId) ?? chosen ?? takes.at(-1);
  const refs = [
    ...(project.voiceReferences ?? []).map((r) => ({
      ...r,
      owner: null as string | null,
      value: `file:${r.id}`,
    })),
    ...project.characters.flatMap((c) =>
      c.references.map((r) => ({
        ...r,
        owner: c.id,
        value: `character:${c.id}:${r.id}`,
        label: `${c.name} · ${r.label}`,
      })),
    ),
  ];
  const reference = refs.find((r) => r.value === referenceValue);
  const refreshDevices = () =>
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((ds) => setDevices(ds.filter((d) => d.kind === 'audioinput')))
      .catch(() => {});
  useEffect(() => {
    void refreshDevices();
  }, [mic.phase]);
  useEffect(() => {
    let disposed = false;
    if (bridge.native && vcOpen)
      void bridge
        .voiceStatus(true)
        .then((s) => {
          if (!disposed) setStatus(s);
        })
        .catch((e) => {
          if (!disposed) onError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [completion, onError, vcOpen]);
  const refId = reference?.id,
    refOwner = reference?.owner;
  useEffect(() => {
    let disposed = false;
    setPreview('');
    if (refId && bridge.native)
      void bridge
        .voiceReferenceUrl(refOwner ?? null, refId)
        .then((url) => {
          if (!disposed) setPreview(url);
        })
        .catch((e) => {
          if (!disposed) onError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [refId, refOwner, onError]);
  const perform = async (action: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await action();
    } catch (e) {
      onError(String(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="voice-capture">
      <details
        className="microphone-panel"
        open={micOpen || owns}
        onToggle={(e) => setMicOpen(e.currentTarget.open)}
      >
        <summary>
          <Mic size={15} />
          {t('capture.title')}
        </summary>
        {(micOpen || owns) && (
          <>
            <p className="panel-description">{t('capture.hint')}</p>
            <label className="field">
              <span>{t('capture.device')}</span>
              <select
                aria-label={t('capture.device')}
                value={device}
                disabled={mic.phase !== 'idle' || busy}
                onChange={(e) => setDevice(e.target.value)}
              >
                <option value="">{t('capture.defaultDevice')}</option>
                {devices.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `${t('capture.device')} ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="text-button"
              disabled={mic.phase !== 'idle'}
              onClick={() => void refreshDevices()}
            >
              {t('refreshDevices')}
            </button>
            {owns && (
              <>
                <p role="status">
                  {t('capture.' + mic.phase)} · {(mic.durationMs / 1000).toFixed(2)} / 120 s
                </p>
                <meter aria-label={t('capture.level')} min="0" max="1" value={mic.level} />
                {mic.clipped && <p className="warning">{t('capture.clipping')}</p>}
              </>
            )}
            {mic.error && <p className="warning">{t('errors.' + mic.error)}</p>}
            {mic.phase === 'idle' && (
              <button
                className="button accent wide"
                disabled={busy || !bridge.native}
                onClick={() =>
                  void perform(async () => {
                    const p = await snapshot(),
                      l = p.dialogues.find((l) => l.id === line.id);
                    if (!l) throw Error('NO_DIALOGUES');
                    document
                      .querySelectorAll<HTMLMediaElement>('video,audio')
                      .forEach((element) => element.pause());
                    // A permission prompt may stay open indefinitely. Keep
                    // discard and the rest of the UI responsive while it waits.
                    void startMicrophone(p, l, device).catch((e) => onError(String(e)));
                  })
                }
              >
                <Mic size={15} />
                {t('capture.start')}
              </button>
            )}
            {owns && mic.phase === 'recording' && (
              <button className="button accent wide" onClick={() => void stopMicrophone()}>
                <Square size={15} />
                {t('capture.stop')}
              </button>
            )}
            {owns && mic.phase === 'ready' && (
              <>
                <audio controls src={mic.url} aria-label={t('capture.preview')} />
                <button
                  className="button accent wide"
                  disabled={busy}
                  onClick={() =>
                    void perform(() =>
                      run(async () => {
                        const p = await snapshot(),
                          l = p.dialogues.find((l) => l.id === line.id);
                        if (!l) throw Error('NO_DIALOGUES');
                        return saveMicrophone(p, l, (bytes) =>
                          bridge.storeMicrophoneTake(p.id, p.revision, l.id, bytes),
                        );
                      }),
                    )
                  }
                >
                  {t('capture.save')}
                </button>
              </>
            )}
            {mic.phase !== 'idle' && (
              <button
                className="button subtle wide"
                disabled={mic.phase === 'saving'}
                onClick={discardMicrophone}
              >
                {t('capture.discard')}
              </button>
            )}
          </>
        )}
      </details>
      <details
        className="conversion-panel"
        open={vcOpen}
        onToggle={(e) => setVcOpen(e.currentTarget.open)}
      >
        <summary>
          <AudioLines size={15} />
          {t('capture.vcTitle')}
        </summary>
        {vcOpen && (
          <>
            <p className="panel-description">{t('capture.vcHint')}</p>
            <label className="field">
              <span>{t('capture.source')}</span>
              <select
                aria-label={t('capture.source')}
                value={source?.id ?? ''}
                disabled={busy}
                onChange={(e) => setSourceId(e.target.value)}
              >
                {!takes.length && <option value="">{t('ttsNoGeneration')}</option>}
                {takes.map((g, i) => (
                  <option key={g.id} value={g.id}>
                    {t('ttsGenerationNumber', { number: i + 1 })} ·{' '}
                    {(g.durationMs / 1000).toFixed(2)} s · {g.modelId}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('capture.reference')}</span>
              <select
                aria-label={t('capture.reference')}
                value={reference?.value ?? ''}
                disabled={busy || pending}
                onChange={(e) => setReferenceValue(e.target.value)}
              >
                <option value="">{t('capture.chooseReference')}</option>
                {refs.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            {preview && <audio controls src={preview} aria-label={t('ttsListenReference')} />}
            <ReferenceFileImport
              busy={busy}
              onError={onError}
              onPending={setPending}
              onImport={async (file) => {
                let imported = false;
                await perform(() =>
                  run(async () => {
                    const p = await bridge.importDubbingReference(null, defaultVoiceSettings, file);
                    const ref = p?.voiceReferences?.at(-1);
                    if (ref) {
                      setReferenceValue(`file:${ref.id}`);
                      imported = true;
                    }
                    return p;
                  }),
                );
                return imported;
              }}
            />
            <label className="field">
              <span>{t('ttsDevice')}</span>
              <select
                aria-label={t('capture.vcDevice')}
                value={gpu}
                disabled={busy}
                onChange={(e) => setGpu(e.target.value)}
              >
                <option value="auto">{t('auto')}</option>
                <option value="cpu">CPU</option>
                {status?.cudaDevices
                  .filter((d) => d.id.startsWith('cuda:'))
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </label>
            <p className="panel-description">{t('capture.vcLimits')}</p>
            {!status?.variants.some((v) => v.id === 'chatterbox-vc' && v.installed) && (
              <button className="button subtle wide" onClick={onModels}>
                {t('capture.install')}
              </button>
            )}
            <button
              className="button accent wide"
              disabled={
                !bridge.native ||
                busy ||
                mic.phase !== 'idle' ||
                !source ||
                !reference ||
                reference.durationMs < 1000 ||
                pending ||
                !status?.variants.some((v) => v.id === 'chatterbox-vc' && v.installed)
              }
              onClick={() =>
                void perform(async () => {
                  if (!source || !reference) return;
                  await startTask(async () => {
                    await snapshot();
                    return bridge.convertVoiceTimbre({
                      generationId: source.id,
                      referenceId: reference.id,
                      characterId: reference.owner,
                      device: gpu,
                    });
                  });
                })
              }
            >
              {t('capture.convert')}
            </button>
          </>
        )}
      </details>
    </section>
  );
}
