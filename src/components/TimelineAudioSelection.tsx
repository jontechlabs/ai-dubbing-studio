import { useState } from 'react';
import { Volume2, VolumeX, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AudioSelection, Project } from '../domain/types';
import { audioTracks, paintAudioRegion, trackLabel } from '../domain/audio';
import { formatTime } from '../domain/time';
import { IconButton } from './IconButton';

export function TimelineAudioSelection({
  project,
  selection,
  busy,
  onEdit,
  onSelection,
  onAdvanced,
}: {
  project: Project;
  selection: AudioSelection;
  busy: boolean;
  onEdit: (update: (p: Project) => Project) => void;
  onSelection: (selection: AudioSelection | null) => void;
  onAdvanced: () => void;
}) {
  const { t } = useTranslation();
  const [newId] = useState(() => crypto.randomUUID());
  const track = audioTracks(project).find((track) => track.id === selection.trackId);
  if (
    !track ||
    project.media?.id !== selection.mediaId ||
    selection.endMs > (track.durationMs ?? project.media.durationMs)
  )
    return null;
  const exact = track.regions?.find(
    (r) => r.startMs === selection.startMs && r.endMs === selection.endMs,
  );
  const containing = track.regions?.find(
    (r) => r.startMs <= selection.startMs && r.endMs >= selection.endMs,
  );
  // Reading from the project keeps undo/redo and edits from the Audio panel in sync.
  const region = exact ?? containing;
  const gain = region?.gain ?? 1;
  const silent = !!region?.mute || gain === 0;
  const change = (gain: number, mute: boolean) => {
    const id = exact?.id ?? newId;
    onEdit((p) => {
      if (p.id !== project.id || p.media?.id !== selection.mediaId)
        throw new Error('STALE_REVISION');
      return paintAudioRegion(
        p,
        track.id,
        { startMs: selection.startMs, endMs: selection.endMs, gain, mute },
        id,
      );
    });
    onSelection({ ...selection, regionId: id });
  };
  return (
    <div
      className="timeline-audio-selection"
      role="group"
      aria-label={t('timelineSelectionControls')}
    >
      <strong>{t(trackLabel(track))}</strong>
      <span className="selection-timecodes">
        {formatTime(selection.startMs)} → {formatTime(selection.endMs)}
      </span>
      <label>
        <span>{t('regionVolume')}</span>
        <input
          type="range"
          min="0"
          max="2"
          step="0.05"
          value={gain}
          aria-label={t('timelineSelectionVolume')}
          aria-valuetext={`${Math.round(gain * 100)}%`}
          disabled={busy}
          onChange={(e) => change(Number(e.target.value), false)}
        />
        <output>{Math.round(gain * 100)}%</output>
      </label>
      <button
        className="button subtle"
        disabled={busy}
        aria-pressed={silent}
        onClick={() => change(gain || 1, !silent)}
      >
        {silent ? <Volume2 size={14} /> : <VolumeX size={14} />}
        {t(silent ? 'makeRegionAudible' : 'makeRegionSilent')}
      </button>
      <button className="text-button" disabled={busy} onClick={() => change(1, false)}>
        {t('timelineSelectionNormal')}
      </button>
      <button className="text-button" onClick={onAdvanced}>
        {t('timelineSelectionAdvanced')}
      </button>
      {track.mute && <small>{t('timelineSelectionTrackMuted')}</small>}
      <IconButton label={t('timelineSelectionClear')} onClick={() => onSelection(null)}>
        <X size={14} />
      </IconButton>
    </div>
  );
}
