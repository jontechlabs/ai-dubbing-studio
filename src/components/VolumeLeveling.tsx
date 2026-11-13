import { useEffect, useRef, useState } from 'react';
import { Check, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AudioSelection, Job, Project } from '../domain/types';
import type { VolumeLevelingResult } from '../domain/volumeLeveling';
import { audioTracks, trackLabel } from '../domain/audio';
import { formatTime } from '../domain/time';
import * as bridge from '../services/bridge';
import { Modal } from './Modal';
import { CurrentJobProgress } from './CurrentJobProgress';

export function VolumeLeveling({
  project,
  selection,
  jobs,
  busy,
  snapshot,
  onSaved,
  onClose,
  onListen,
}: {
  project: Project;
  selection: AudioSelection;
  jobs: Job[];
  busy: boolean;
  snapshot: () => Promise<Project>;
  onSaved: (project: Project) => void;
  onClose: () => void;
  onListen: (element: HTMLAudioElement) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'low' | 'high'>('low');
  const [id, setId] = useState<string | null>(null);
  const [result, setResult] = useState<VolumeLevelingResult | null>(null);
  const [urls, setUrls] = useState<{ original: string; leveled: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const owner = useRef({ token: 0 }),
    preview = useRef<string | null>(null),
    container = useRef<HTMLDivElement>(null);
  const stop = () => container.current?.querySelectorAll('audio').forEach((a) => a.pause());
  const clear = () => {
    ++owner.current.token;
    stop();
    const old = preview.current;
    preview.current = null;
    setId(null);
    setResult(null);
    setUrls(null);
    setError('');
    if (old) void bridge.discardVolumeLeveling(old).catch(() => {});
  };
  useEffect(() => {
    const element = container.current;
    const lifetime = owner.current;
    return () => {
      ++lifetime.token;
      element?.querySelectorAll('audio').forEach((a) => a.pause());
      if (preview.current) void bridge.discardVolumeLeveling(preview.current).catch(() => {});
      preview.current = null;
    };
  }, []);
  const job = jobs.find((j) => j.id === id);
  useEffect(() => {
    if (!id || job?.status !== 'succeeded') return;
    let disposed = false;
    void Promise.all([
      bridge.volumeLevelingResult(id),
      bridge.volumeLevelingUrl(id, 'original'),
      bridge.volumeLevelingUrl(id, 'leveled'),
    ])
      .then(([value, original, leveled]) => {
        if (!disposed) {
          setResult(value);
          setUrls({ original, leveled });
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [id, job?.status]);
  const launch = async () => {
    clear();
    const token = owner.current.token;
    setWorking(true);
    try {
      const p = await snapshot();
      if (token !== owner.current.token) return;
      const key = await bridge.prepareVolumeLeveling(p, {
        mediaId: selection.mediaId,
        trackId: selection.trackId,
        startMs: selection.startMs,
        endMs: selection.endMs,
        mode,
      });
      if (token !== owner.current.token) {
        await bridge.discardVolumeLeveling(key);
        return;
      }
      preview.current = key;
      setId(key);
    } catch (e) {
      if (token === owner.current.token) setError(String(e));
    } finally {
      if (token === owner.current.token) setWorking(false);
    }
  };
  const apply = async () => {
    if (!result || !id) return;
    const token = owner.current.token;
    stop();
    setWorking(true);
    setError('');
    try {
      const p = await snapshot();
      const saved = await bridge.applyVolumeLeveling(p, id);
      preview.current = null;
      if (token === owner.current.token) onSaved(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };
  const active = working || (!!job && ['queued', 'running', 'paused'].includes(job.status));
  const stale =
    !!result && (result.projectId !== project.id || result.revision !== project.revision);
  useEffect(() => {
    const elements = [...(container.current?.querySelectorAll('audio') ?? [])];
    return () => elements.forEach((a) => a.pause());
  }, [urls, stale]);
  const track = audioTracks(project).find((tr) => tr.id === selection.trackId);
  return (
    <Modal title={t('leveling.title')} className="volume-leveling-modal" onClose={onClose}>
      <div ref={container}>
        <p className="dialogue-audio-heading">
          {track ? t(trackLabel(track)) : ''} · {formatTime(selection.startMs)} →{' '}
          {formatTime(selection.endMs)}
        </p>
        <p className="panel-description">{t('leveling.hint')}</p>
        <label className="field">
          <span>{t('leveling.target')}</span>
          <select
            aria-label={t('leveling.target')}
            value={mode}
            disabled={active}
            onChange={(e) => {
              clear();
              setMode(e.target.value as 'low' | 'high');
            }}
          >
            <option value="low">{t('leveling.low')}</option>
            <option value="high">{t('leveling.high')}</option>
          </select>
        </label>
        <p className="panel-description">
          {t(mode === 'low' ? 'leveling.lowHint' : 'leveling.highHint')}
        </p>
        <button className="button subtle" disabled={active || busy} onClick={() => void launch()}>
          <SlidersHorizontal size={15} />
          {t('leveling.prepare')}
        </button>
        <CurrentJobProgress job={job} starting={working && !job} onError={setError} />
        {result && urls && !stale && (
          <section className="leveling-preview" aria-label={t('leveling.preview')}>
            <p>
              {t('leveling.measurement', {
                quiet: result.stats.quietDb.toFixed(1),
                loud: result.stats.loudDb.toFixed(1),
                target: result.stats.targetDb.toFixed(1),
              })}
            </p>
            {(result.stats.gainLimited || result.stats.safetyDb < -0.01) && (
              <p className="panel-description">{t('leveling.limited')}</p>
            )}
            {(['original', 'leveled'] as const).map((role) => (
              <label className="field" key={role}>
                <span>{t(`leveling.${role}`)}</span>
                <audio
                  controls
                  preload="metadata"
                  src={urls[role]}
                  aria-label={t(`leveling.${role}`)}
                  onPlay={(e) => onListen(e.currentTarget)}
                />
              </label>
            ))}
          </section>
        )}
        {stale && <p role="alert">{t('leveling.stale')}</p>}
        {error && (
          <p role="alert">
            {t(`errors.${error.replace(/^Error: /, '').split(':')[0]}`, { defaultValue: error })}
          </p>
        )}
        <p className="panel-description">{t('leveling.beforeLevels')}</p>
        <div className="leveling-actions">
          <button className="button subtle" onClick={onClose} disabled={working && !!result}>
            {t('cancel')}
          </button>
          <button
            className="button primary"
            disabled={busy || active || stale || !result || !urls}
            onClick={() => void apply()}
          >
            <Check size={15} />
            {t('leveling.apply')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
