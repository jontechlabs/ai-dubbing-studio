import { useRef, useState, useEffect, type RefObject } from 'react';
import { Volume2, VolumeX, Trash2, Save, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AudioRegion, AudioSelection, Dialogue, Project } from '../domain/types';
import { audioTracks, paintAudioRegion, setAudioRegions, setAllAudio } from '../domain/audio';
import { formatTime, parseTime } from '../domain/time';

export function AudioRegionsEditor({
  project,
  selection,
  selected,
  videoRef,
  onEdit,
  onExport,
}: {
  project: Project;
  selection: AudioSelection | null;
  selected?: Dialogue;
  videoRef: RefObject<HTMLVideoElement | null>;
  onEdit: (update: (p: Project) => Project) => void;
  onExport: (trackId: string) => void;
}) {
  const { t } = useTranslation(),
    container = useRef<HTMLDivElement>(null);
  const tracks = audioTracks(project);
  const [trackId, setTrackId] = useState(selection?.trackId ?? tracks[0].id);
  const track = tracks.find((track) => track.id === trackId) ?? tracks[0];
  const limit = track.durationMs ?? project.media!.durationMs;
  const initial =
    selection?.startMs ??
    selected?.startMs ??
    Math.min(Math.round((videoRef.current?.currentTime ?? 0) * 1000), Math.max(0, limit - 1000));
  const existing = track.regions?.find((region) => region.id === selection?.regionId);
  const [editingId, setEditingId] = useState<string | undefined>(existing?.id);
  const [start, setStart] = useState(formatTime(existing?.startMs ?? initial));
  const [end, setEnd] = useState(
    formatTime(
      existing?.endMs ?? selection?.endMs ?? selected?.endMs ?? Math.min(limit, initial + 3000),
    ),
  );
  const [gain, setGain] = useState(existing?.gain ?? 1),
    [mute, setMute] = useState(existing?.mute ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (selection) container.current?.scrollIntoView({ block: 'start' });
  }, [selection]);
  const choose = (region: AudioRegion) => {
    setEditingId(region.id);
    setStart(formatTime(region.startMs));
    setEnd(formatTime(region.endMs));
    setGain(region.gain);
    setMute(region.mute);
    setError(null);
    setSaved(false);
  };
  const range = () => {
    const startMs = parseTime(start),
      endMs = parseTime(end);
    if (startMs < 0 || endMs <= startMs || endMs > limit) throw new Error('INVALID_AUDIO_REGION');
    return { startMs, endMs, gain, mute };
  };
  const apply = (kind: 'save' | 'mute' | 'audible' | 'isolate') => {
    try {
      const values = range();
      if (kind === 'mute') values.mute = true;
      if (kind === 'audible' || kind === 'isolate') values.mute = false;
      onEdit((p) => {
        let next = p;
        if (kind === 'isolate')
          next = setAudioRegions(p, track.id, [
            { id: crypto.randomUUID(), startMs: 0, endMs: limit, gain: 1, mute: true },
          ]);
        next = paintAudioRegion(next, track.id, values, kind === 'isolate' ? undefined : editingId);
        return next;
      });
      setMute(values.mute);
      setEditingId(undefined);
      setError(null);
      setSaved(true);
    } catch (error) {
      setError(String(error).replace('Error: ', ''));
    }
  };
  return (
    <section className="settings-section audio-regions-editor" ref={container}>
      <h3>{t('audioRegionsTitle')}</h3>
      <p className="panel-description">{t('audioRegionsHint')}</p>
      <label className="field">
        <span>{t('regionTrack')}</span>
        <select
          value={track.id}
          onChange={(event) => {
            setTrackId(event.target.value);
            setEditingId(undefined);
            setError(null);
            setSaved(false);
            const next = tracks.find((track) => track.id === event.target.value)!;
            const max = next.durationMs ?? project.media!.durationMs;
            setStart(formatTime(Math.min(initial, Math.max(0, max - 1000))));
            setEnd(formatTime(Math.min(max, initial + 3000)));
          }}
        >
          {tracks.map((track) => (
            <option key={track.id} value={track.id}>
              {t(track.kind === 'original' ? 'originalTrack' : `stem.${track.role}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="audio-quick-controls">
        <button
          className="button subtle"
          onClick={() => onEdit((p) => setAllAudio(p, false, track.id))}
        >
          {t('wholeTrackSilent')}
        </button>
        <button
          className="button subtle"
          onClick={() => onEdit((p) => setAllAudio(p, true, track.id))}
        >
          {t('wholeTrackAudible')}
        </button>
      </div>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={track.regionsEnabled !== false}
          disabled={!track.regions?.length}
          onChange={(event) =>
            onEdit((p) => setAudioRegions(p, track.id, track.regions ?? [], event.target.checked))
          }
        />
        {t('applyTrackRegions')}
      </label>
      <div className="region-time-fields">
        <label className="field">
          <span>{t('regionStart')}</span>
          <input
            aria-label={t('regionStart')}
            value={start}
            onChange={(event) => {
              setStart(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="field">
          <span>{t('regionEnd')}</span>
          <input
            aria-label={t('regionEnd')}
            value={end}
            onChange={(event) => {
              setEnd(event.target.value);
              setSaved(false);
            }}
          />
        </label>
      </div>
      <button
        className="text-button"
        disabled={!selected}
        onClick={() => {
          if (selected) {
            setStart(formatTime(selected.startMs));
            setEnd(formatTime(Math.min(limit, selected.endMs)));
            setEditingId(undefined);
            setSaved(false);
          }
        }}
      >
        {t('regionFromDialogue')}
      </button>
      <label className="field">
        <span>
          {t('regionVolume')} · {Math.round(gain * 100)}%
        </span>
        <input
          aria-label={t('regionVolume')}
          type="range"
          min="0"
          max="2"
          step="0.05"
          value={gain}
          onChange={(event) => {
            setGain(Number(event.target.value));
            setSaved(false);
          }}
        />
      </label>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={mute}
          onChange={(event) => {
            setMute(event.target.checked);
            setSaved(false);
          }}
        />
        {t('regionMuted')}
      </label>
      <div className="region-actions">
        <button className="button subtle" onClick={() => apply('mute')}>
          <VolumeX size={14} />
          {t('makeRegionSilent')}
        </button>
        <button className="button subtle" onClick={() => apply('audible')}>
          <Volume2 size={14} />
          {t('makeRegionAudible')}
        </button>
        <button
          className="button subtle"
          title={t('isolateRegionHint')}
          onClick={() => apply('isolate')}
        >
          {t('isolateRegion')}
        </button>
        <button className="button accent" onClick={() => apply('save')}>
          <Save size={14} />
          {t('saveRegion')}
        </button>
      </div>
      {error && (
        <p className="warning" role="alert">
          {t(`errors.${error}`, { defaultValue: t('errors.INVALID_AUDIO_REGION') })}
        </p>
      )}
      {saved && (
        <p className="panel-description" role="status">
          {t('regionSaved')}
        </p>
      )}
      <div className="audio-region-list">
        {(track.regions ?? []).map((region, index) => (
          <div key={region.id} className={region.id === editingId ? 'selected' : ''}>
            <button
              className="text-button"
              aria-label={t('editRegion', { index: index + 1 })}
              onClick={() => choose(region)}
            >
              {region.mute || region.gain === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
              <span>
                {formatTime(region.startMs)} → {formatTime(region.endMs)} ·{' '}
                {region.mute ? t('regionMuted') : Math.round(region.gain * 100) + '%'}
              </span>
            </button>
            <button
              className="icon-button"
              aria-label={t('deleteRegion', { index: index + 1 })}
              onClick={() => {
                onEdit((p) =>
                  setAudioRegions(
                    p,
                    track.id,
                    (track.regions ?? []).filter((item) => item.id !== region.id),
                    track.regionsEnabled !== false,
                  ),
                );
                if (editingId === region.id) setEditingId(undefined);
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      {track.kind === 'audio' && (
        <button className="button subtle wide" onClick={() => onExport(track.id)}>
          <Download size={14} />
          {t('exportTrackRegions')}
        </button>
      )}
      <p className="panel-description">{t('regionGainHint')}</p>
    </section>
  );
}
