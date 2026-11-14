import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AudioSelection, Job, Project } from '../domain/types';
import { audioTracks, trackLabel } from '../domain/audio';
import type { VolumeLevelingResult } from '../domain/volumeLeveling';
import { formatTime } from '../domain/time';
import { Modal } from './Modal';
import { CurrentJobProgress } from './CurrentJobProgress';
import * as bridge from '../services/bridge';
interface Row {
  id: string;
  result: VolumeLevelingResult;
  original: string;
  leveled: string;
  approved: boolean;
}
export function MultiVolumeLeveling({
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
  onSaved: (p: Project) => void;
  onClose: () => void;
  onListen: (a: HTMLAudioElement) => void;
}) {
  const { t } = useTranslation();
  const tracks = audioTracks(project),
    first = tracks.find((tr) => tr.id === selection.trackId);
  const [chosen, setChosen] = useState([selection.trackId]),
    [whole, setWhole] = useState(
      selection.startMs === 0 &&
        selection.endMs ===
          Math.min(first?.durationMs ?? project.media!.durationMs, project.media!.durationMs),
    ),
    [mode, setMode] = useState<'low' | 'high'>('low'),
    [rows, setRows] = useState<Record<string, Row>>({}),
    [current, setCurrent] = useState<string | null>(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState('');
  const owner = useRef({ token: 0, ids: new Set<string>() }),
    jobRef = useRef(jobs),
    container = useRef<HTMLDivElement>(null);
  jobRef.current = jobs;
  const stop = () => container.current?.querySelectorAll('audio').forEach((a) => a.pause());
  const clear = () => {
    owner.current.token++;
    stop();
    for (const id of owner.current.ids) void bridge.discardVolumeLeveling(id).catch(() => {});
    owner.current.ids.clear();
    setRows({});
    setCurrent(null);
  };
  useEffect(() => {
    const o = owner.current,
      element = container.current;
    return () => {
      o.token++;
      element?.querySelectorAll('audio').forEach((a) => a.pause());
      for (const id of o.ids) void bridge.discardVolumeLeveling(id).catch(() => {});
      o.ids.clear();
    };
  }, []);
  const prepare = async () => {
    clear();
    const token = owner.current.token;
    setWorking(true);
    setError('');
    try {
      const p = await snapshot();
      for (const trackId of chosen) {
        if (token !== owner.current.token) return;
        const track = tracks.find((tr) => tr.id === trackId)!;
        const end = Math.min(
          track.durationMs ?? p.media!.durationMs,
          p.media!.durationMs,
          whole ? p.media!.durationMs : selection.endMs,
        );
        const start = whole ? 0 : selection.startMs;
        if (end - start < 100) throw Error('VOLUME_LEVELING_OPTIONS');
        const id = await bridge.prepareVolumeLeveling(p, {
          mediaId: p.media!.id,
          trackId,
          startMs: start,
          endMs: end,
          mode,
        });
        if (token !== owner.current.token) {
          await bridge.discardVolumeLeveling(id);
          return;
        }
        owner.current.ids.add(id);
        setCurrent(id);
        for (;;) {
          if (token !== owner.current.token) return;
          const j = jobRef.current.find((j) => j.id === id);
          if (j && ['failed', 'cancelled', 'interrupted'].includes(j.status))
            throw Error(j.error ?? j.status);
          if (j?.status === 'succeeded') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const [result, original, leveled] = await Promise.all([
          bridge.volumeLevelingResult(id),
          bridge.volumeLevelingUrl(id, 'original'),
          bridge.volumeLevelingUrl(id, 'leveled'),
        ]);
        if (token !== owner.current.token) return;
        setRows((old) => ({
          ...old,
          [trackId]: { id, result, original, leveled, approved: false },
        }));
      }
    } catch (e) {
      if (token === owner.current.token) setError(String(e));
    } finally {
      if (token === owner.current.token) setWorking(false);
    }
  };
  const values = Object.values(rows),
    stale = values.some(
      (r) => r.result.projectId !== project.id || r.result.revision !== project.revision,
    );
  useEffect(() => {
    if (stale) container.current?.querySelectorAll('audio').forEach((a) => a.pause());
  }, [stale]);
  const apply = async () => {
    const token = owner.current.token;
    stop();
    setWorking(true);
    setError('');
    try {
      const p = await snapshot();
      const saved = await bridge.applyVolumeLevelingBatch(
        p,
        values.filter((r) => r.approved).map((r) => r.id),
      );
      if (token === owner.current.token) onSaved(saved);
    } catch (e) {
      if (token === owner.current.token) setError(String(e));
    } finally {
      if (token === owner.current.token) setWorking(false);
    }
  };
  return (
    <Modal
      title={t('leveling.batchTitle')}
      className="volume-leveling-modal multi-leveling-modal"
      onClose={onClose}
    >
      <div ref={container}>
        <p className="panel-description">{t('leveling.batchHint')}</p>
        <details open={!values.length}>
          <summary>
            {t('leveling.tracks')} · {chosen.length}
          </summary>
          <fieldset disabled={working || values.length > 0}>
            <legend>{t('leveling.tracks')}</legend>
            {tracks.map((tr) => (
              <label className="checkbox-field" key={tr.id}>
                <input
                  type="checkbox"
                  checked={chosen.includes(tr.id)}
                  onChange={(e) =>
                    setChosen((old) =>
                      e.target.checked ? [...old, tr.id] : old.filter((id) => id !== tr.id),
                    )
                  }
                />
                {t(trackLabel(tr))}
              </label>
            ))}
            <label className="checkbox-field">
              <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />
              {t('leveling.wholeTracks')}
            </label>
            <label className="field">
              <span>{t('leveling.target')}</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'low' | 'high')}>
                <option value="low">{t('leveling.low')}</option>
                <option value="high">{t('leveling.high')}</option>
              </select>
            </label>
          </fieldset>
        </details>
        <button
          className="button subtle"
          disabled={working || busy || chosen.length < 1 || chosen.length > 16}
          onClick={() => void prepare()}
        >
          {t('leveling.prepareAll')}
        </button>
        <CurrentJobProgress
          job={jobs.find((j) => j.id === current)}
          starting={working && !current}
          onError={setError}
        />
        {chosen.map((trackId) => {
          const row = rows[trackId];
          if (!row) return null;
          return (
            <section className="leveling-preview" key={trackId}>
              <h3>{t(trackLabel(tracks.find((tr) => tr.id === trackId)!))}</h3>
              <small>
                {formatTime(row.result.options.startMs)} → {formatTime(row.result.options.endMs)}
              </small>
              <p className="panel-description">
                {t('leveling.measurement', {
                  quiet: row.result.stats.quietDb.toFixed(1),
                  loud: row.result.stats.loudDb.toFixed(1),
                  target: row.result.stats.targetDb.toFixed(1),
                })}
              </p>
              {(row.result.stats.gainLimited || row.result.stats.safetyDb < -0.01) && (
                <p className="panel-description">{t('leveling.limited')}</p>
              )}
              {!stale &&
                (['original', 'leveled'] as const).map((role) => (
                  <label className="field" key={role}>
                    <span>{t(`leveling.${role}`)}</span>
                    <audio
                      controls
                      preload="metadata"
                      src={row[role]}
                      aria-label={`${t(trackLabel(tracks.find((tr) => tr.id === trackId)!))} · ${t(`leveling.${role}`)}`}
                      onPlay={(e) => onListen(e.currentTarget)}
                    />
                  </label>
                ))}
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  disabled={working || stale}
                  checked={row.approved}
                  onChange={(e) =>
                    setRows((old) => ({
                      ...old,
                      [trackId]: { ...row, approved: e.target.checked },
                    }))
                  }
                />
                {t('leveling.approveTrack')}
              </label>
            </section>
          );
        })}
        {stale && <p role="alert">{t('leveling.stale')}</p>}
        {error && (
          <p role="alert">
            {t(`errors.${error.replace(/^Error: /, '').split(':')[0]}`, { defaultValue: error })}
          </p>
        )}
        <div className="leveling-actions">
          <button
            className="button subtle"
            disabled={working}
            onClick={() => {
              clear();
              setError('');
            }}
          >
            {t('leveling.resetBatch')}
          </button>
          <button className="button subtle" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="button primary"
            disabled={working || busy || stale || !values.some((r) => r.approved)}
            onClick={() => void apply()}
          >
            {t('leveling.applyApproved', { count: values.filter((r) => r.approved).length })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
