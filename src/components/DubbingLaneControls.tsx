import { useTranslation } from 'react-i18next';
import { Volume2, VolumeX } from 'lucide-react';
import type { Project } from '../domain/types';
import { dubbingLanes, editDubbingLane } from '../domain/dubbingLanes';
export function DubbingLaneControls({
  project,
  id,
  busy,
  onEdit,
}: {
  project: Project;
  id: string;
  busy: boolean;
  onEdit: (f: (p: Project) => Project) => void;
}) {
  const { t } = useTranslation(),
    lane = dubbingLanes(project).find((l) => l.id === id);
  if (!lane) return null;
  return (
    <div className="timeline-track-controls dubbing-lane-controls">
      <label title={t('dubLanes.volume')}>
        <input
          aria-label={t('dubLanes.percent', { name: lane.name })}
          type="number"
          min={0}
          max={300}
          step={5}
          value={Math.round(lane.gain * 100)}
          disabled={busy}
          onChange={(e) => {
            if (e.target.value !== '')
              onEdit((p) =>
                editDubbingLane(p, id, {
                  gain: Math.max(0, Math.min(300, Number(e.target.value))) / 100,
                }),
              );
          }}
        />
        %
      </label>
      <button
        title={t(lane.mute ? 'enableTrack' : 'muteTrack', { name: lane.name })}
        aria-label={t(lane.mute ? 'enableTrack' : 'muteTrack', { name: lane.name })}
        aria-pressed={!lane.mute}
        disabled={busy}
        onClick={() => onEdit((p) => editDubbingLane(p, id, { mute: !lane.mute }))}
      >
        {lane.mute ? <VolumeX size={12} /> : <Volume2 size={12} />}
      </button>
      <button
        title={t('soloTrack', { name: lane.name })}
        aria-label={t('soloTrack', { name: lane.name })}
        aria-pressed={lane.solo}
        disabled={busy}
        onClick={() => onEdit((p) => editDubbingLane(p, id, { solo: !lane.solo }))}
      >
        S
      </button>
    </div>
  );
}
