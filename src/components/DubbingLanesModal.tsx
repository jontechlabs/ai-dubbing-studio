import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import type { Project, Dialogue } from '../domain/types';
import {
  dubbingLanes,
  dubbingLaneId,
  addDubbingLane,
  assignDubbingLane,
  editDubbingLane,
  removeDubbingLane,
} from '../domain/dubbingLanes';
import { Modal } from './Modal';
import { IconButton } from './IconButton';
import { audioTracks, editTrack } from '../domain/audio';
import { TrackVolume } from './TrackVolume';
import { voiceGenerations } from '../domain/tts';

export function DubbingLanesModal({
  project,
  selected,
  busy,
  onEdit,
  onClose,
}: {
  project: Project;
  selected?: Dialogue;
  busy: boolean;
  onEdit: (f: (p: Project) => Project) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(),
    lanes = dubbingLanes(project),
    master = audioTracks(project).find((t) => t.kind === 'dubbing');
  const texts = new Map(voiceGenerations(project).map((g) => [g.dialogueId, g.text]));
  const [lineId, setLineId] = useState(selected?.id ?? project.dialogues[0]?.id ?? '');
  return (
    <Modal title={t('dubLanes.title')} onClose={onClose} className="dubbing-lanes-modal">
      <p>{t('dubLanes.hint')}</p>
      {master && (
        <div className="dubbing-lanes-master">
          <strong>{t('dubLanes.master')}</strong>
          <TrackVolume track={master} onEdit={onEdit} busy={busy} />
          <button
            disabled={busy}
            aria-pressed={!master.mute}
            onClick={() => onEdit((p) => editTrack(p, master.id, { mute: !master.mute }))}
          >
            {t(master.mute ? 'dubLanes.enableMaster' : 'dubLanes.muteMaster')}
          </button>
        </div>
      )}
      <div className="dubbing-lanes-list">
        {lanes.map((lane, i) => (
          <div className="dubbing-lane-settings" key={lane.id}>
            <input
              key={lane.id + lane.name}
              aria-label={t('dubLanes.name', { number: i + 1 })}
              defaultValue={lane.name}
              maxLength={80}
              disabled={busy}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value && value !== lane.name)
                  onEdit((p) => editDubbingLane(p, lane.id, { name: value }));
                else e.target.value = lane.name;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
            <label>
              <span>{t('dubLanes.volume')}</span>
              <input
                aria-label={t('dubLanes.volumeName', { number: i + 1 })}
                type="range"
                min={0}
                max={300}
                step={1}
                value={Math.round(lane.gain * 100)}
                disabled={busy}
                onChange={(e) =>
                  onEdit((p) => editDubbingLane(p, lane.id, { gain: Number(e.target.value) / 100 }))
                }
              />
              <output>{Math.round(lane.gain * 100)}%</output>
            </label>
            <div className="button-row">
              <button
                disabled={busy}
                aria-pressed={lane.mute}
                onClick={() => onEdit((p) => editDubbingLane(p, lane.id, { mute: !lane.mute }))}
              >
                {t('dubLanes.mute')}
              </button>
              <button
                disabled={busy}
                aria-pressed={lane.solo}
                onClick={() => onEdit((p) => editDubbingLane(p, lane.id, { solo: !lane.solo }))}
              >
                {t('dubLanes.solo')}
              </button>
              <IconButton
                label={t('dubLanes.remove', { name: lane.name })}
                disabled={busy || i === 0}
                onClick={() => onEdit((p) => removeDubbingLane(p, lane.id))}
              >
                <Trash2 size={15} />
              </IconButton>
            </div>
            <small>
              {t('dubLanes.count', {
                count: project.dialogues.filter((l) => dubbingLaneId(project, l.id) === lane.id)
                  .length,
              })}
            </small>
          </div>
        ))}
      </div>
      <button
        disabled={busy || lanes.length >= 32}
        onClick={() =>
          onEdit((p) => addDubbingLane(p, t('dubLanes.defaultName', { number: lanes.length + 1 })))
        }
      >
        <Plus size={15} />
        {t('dubLanes.add')}
      </button>
      <fieldset disabled={busy || !lineId}>
        <legend>{t('dubLanes.assign')}</legend>
        <label className="field">
          <span>{t('dubLanes.dialogue')}</span>
          <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
            {project.dialogues.map((l, i) => (
              <option key={l.id} value={l.id}>
                #{i + 1} · {(l.ttsText || texts.get(l.id) || '').slice(0, 60)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('dubLanes.destination')}</span>
          <select
            value={dubbingLaneId(project, lineId)}
            onChange={(e) => onEdit((p) => assignDubbingLane(p, [lineId], e.target.value))}
          >
            {lanes.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <p className="panel-description">{t('dubLanes.removeHint')}</p>
    </Modal>
  );
}
