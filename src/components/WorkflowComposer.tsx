import { useEffect, useMemo, useState } from 'react';
import { ListOrdered, ListPlus, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../domain/types';
import type { AudioToolboxStatus } from '../domain/audioToolbox';
import { audioTracks, trackLabel } from '../domain/audio';
import { workflowLines } from '../domain/workflowSelection';
import * as bridge from '../services/bridge';
export function WorkflowComposer({
  project,
  selectionKey,
  ready,
  snapshot,
  onQueue,
}: {
  project: Project;
  selectionKey: string;
  ready: boolean;
  snapshot: () => Promise<Project>;
  onQueue: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState('dub'),
    [name, setName] = useState(''),
    [source, setSource] = useState('original'),
    [model, setModel] = useState('mel-band-roformer-kim'),
    [device, setDevice] = useState('auto'),
    [windowSeconds, setWindow] = useState(4),
    [vocals, setVocals] = useState(true),
    [music, setMusic] = useState(false),
    [mute, setMute] = useState(false),
    [proceed, setProceed] = useState(true),
    [status, setStatus] = useState<AudioToolboxStatus | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false),
    [added, setAdded] = useState(false);
  const selection: bridge.DubbingBatchSelection = useMemo(
    () => JSON.parse(selectionKey),
    [selectionKey],
  );
  const lines = useMemo(() => workflowLines(project, selection), [project, selection]);
  const separate = mode !== 'dub',
    dubbing = mode !== 'separate',
    tracks = audioTracks(project).filter((t) => t.kind !== 'dubbing');
  const rangeError =
    separate &&
    lines.some(
      (l) =>
        l.endMs - l.startMs < 100 ||
        l.endMs - l.startMs > 60000 ||
        l.endMs > project.media!.durationMs,
    );
  useEffect(() => {
    if (!separate || !bridge.native) return;
    let disposed = false;
    setLoading(true);
    setError('');
    void bridge
      .audioToolboxStatus()
      .then((s) => {
        if (!disposed) setStatus(s);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [separate]);
  const installed = status?.models.find((m) => m.id === model)?.installed;
  return (
    <details className="workflow-composer" open>
      <summary>
        <ListOrdered size={14} /> {t('workflow.composer')}
      </summary>
      <label className="field">
        <span>{t('workflow.actions')}</span>
        <select
          value={mode}
          disabled={working}
          onChange={(e) => {
            setMode(e.target.value);
            setAdded(false);
          }}
        >
          <option value="dub">{t('workflow.dub')}</option>
          <option value="separate">{t('workflow.separate')}</option>
          <option value="separateDub">{t('workflow.separateDub')}</option>
        </select>
      </label>
      <label className="field">
        <span>{t('workflow.name')}</span>
        <input
          maxLength={120}
          value={name}
          placeholder={t('workflow.' + mode)}
          disabled={working}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {separate && (
        <fieldset disabled={working}>
          <legend>{t('workflow.separationSettings')}</legend>
          {loading && (
            <p role="status">
              <LoaderCircle size={14} className="spin" /> {t('workflow.loadingModels')}
            </p>
          )}
          <label className="field">
            <span>{t('workflow.model')}</span>
            <select value={model} disabled={loading} onChange={(e) => setModel(e.target.value)}>
              {(
                status?.models ?? [
                  { id: 'mel-band-roformer-kim', name: 'Mel-Band RoFormer · Kim Vocals' },
                  { id: 'bs-roformer-viperx-1297', name: 'BS-RoFormer · Viperx 1297' },
                ]
              )
                .filter((m) => ['mel-band-roformer-kim', 'bs-roformer-viperx-1297'].includes(m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </label>
          {!loading && !installed && <p className="warning">{t('workflow.installFirst')}</p>}
          <label className="field">
            <span>{t('workflow.source')}</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {tracks.map((tr) => (
                <option value={tr.id} key={tr.id}>
                  {t(trackLabel(tr))}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('ttsDevice')}</span>
            <select value={device} onChange={(e) => setDevice(e.target.value)}>
              {[
                { id: 'auto', name: t('workflow.auto') },
                ...(status?.devices ?? [{ id: 'cpu', name: 'CPU' }]),
              ]
                .filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i)
                .map((d) => (
                  <option value={d.id} key={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>{t('workflow.window')}</span>
            <select value={windowSeconds} onChange={(e) => setWindow(Number(e.target.value))}>
              {[2, 4, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n} s
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={dubbing || vocals}
              disabled={dubbing}
              onChange={(e) => setVocals(e.target.checked)}
            />
            {t('workflow.routeVocals')}
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={music} onChange={(e) => setMusic(e.target.checked)} />
            {t('workflow.routeMusic')}
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} />
            {t('workflow.muteSource')}
          </label>
          <p className="panel-description">{t('workflow.routingHint')}</p>
        </fieldset>
      )}
      {separate && dubbing && <p className="panel-description">{t('workflow.referenceHint')}</p>}
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={proceed}
          disabled={working}
          onChange={(e) => setProceed(e.target.checked)}
        />
        {t('workflow.continue')}
      </label>
      <p role="status">{t('workflow.frozenCount', { count: lines.length })}</p>
      {rangeError && (
        <p role="alert" className="warning">
          {t('errors.QUEUE_RANGE')}
        </p>
      )}
      {error && (
        <p role="alert" className="warning">
          {t('errors.' + error.replace(/^Error: /, ''), { defaultValue: error })}
        </p>
      )}
      {added && <p role="status">{t('workflow.added')}</p>}
      <div className="compact-toolbar">
        <button
          className="button accent"
          disabled={
            !bridge.native ||
            working ||
            !lines.length ||
            !!rangeError ||
            (dubbing && !ready) ||
            (separate && (loading || !installed || (!dubbing && !vocals && !music)))
          }
          onClick={() => {
            setWorking(true);
            setError('');
            setAdded(false);
            void snapshot()
              .then((p) =>
                bridge.enqueueWorkflow(p, {
                  name: name.trim() || t('workflow.' + mode),
                  selection,
                  separation: separate
                    ? {
                        modelId: model,
                        sourceTrackId: source,
                        device,
                        windowSeconds,
                        vocals: dubbing || vocals,
                        music,
                        muteSource: mute,
                      }
                    : null,
                  dubbing,
                  continueOnError: proceed,
                }),
              )
              .then(() => setAdded(true))
              .catch((e) => setError(String(e)))
              .finally(() => setWorking(false));
          }}
        >
          <ListPlus size={14} /> {t('workflow.add')}
        </button>
        <button className="button subtle" onClick={onQueue}>
          <ListOrdered size={14} /> {t('queue')}
        </button>
      </div>
    </details>
  );
}
