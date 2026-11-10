import { useEffect, useState } from 'react';
import { AudioLines, Play, Scissors, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AudioSelection, Dialogue, Project } from '../domain/types';
import { audioTracks, trackLabel } from '../domain/audio';
import { validAudioSelection } from '../domain/audioAudition';
import { formatTime } from '../domain/time';
import { IconButton } from './IconButton';
import { Modal } from './Modal';

export function DialogueTrackAudition({
  project,
  line,
  ready,
  busy,
  audition,
  onPlay,
  onStop,
  onIsolate,
  onClose,
}: {
  project: Project;
  line: Dialogue;
  ready: boolean;
  busy: boolean;
  audition: { projectId: string; selection: AudioSelection } | null;
  onPlay: (selection: AudioSelection, beforeLevels?: boolean) => void;
  onStop: () => void;
  onIsolate: (trackId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [beforeLevels, setBeforeLevels] = useState(false);
  useEffect(
    () => () => onStop(),
    [onStop, project.id, project.media?.id, line.id, line.startMs, line.endMs],
  );
  const duration = line.endMs - line.startMs;
  return (
    <Modal title={t('dialogueAudio.title')} onClose={onClose} className="dialogue-audio-modal">
      <p className="dialogue-audio-heading">
        {t('batchLine', { number: project.dialogues.findIndex((l) => l.id === line.id) + 1 })}
        {' · '}
        {formatTime(line.startMs)} → {formatTime(line.endMs)}
      </p>
      <p className="panel-description">{t('dialogueAudio.hint')}</p>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={beforeLevels}
          onChange={(e) => {
            onStop();
            setBeforeLevels(e.target.checked);
          }}
        />
        {t('timelineSelectionBeforeLevels')}
      </label>
      <div className="dialogue-audio-tracks">
        {audioTracks(project).map((track) => {
          const range: AudioSelection = {
            mediaId: project.media?.id ?? '',
            trackId: track.id,
            startMs: line.startMs,
            endMs: line.endMs,
          };
          const valid = validAudioSelection(project, range);
          const active =
            audition?.projectId === project.id &&
            audition.selection.mediaId === range.mediaId &&
            audition.selection.trackId === track.id &&
            audition.selection.startMs === range.startMs &&
            audition.selection.endMs === range.endMs;
          const name = track.name ?? t(trackLabel(track));
          const canIsolate =
            valid && track.kind !== 'dubbing' && duration >= 100 && duration <= 60000;
          return (
            <article
              className={`dialogue-audio-track${active ? ' active' : ''}`}
              key={track.id}
              aria-label={name}
            >
              <AudioLines size={16} aria-hidden="true" />
              <div className="dialogue-audio-name">
                <strong>{name}</strong>
                {!valid && <small>{t('dialogueAudio.unavailable')}</small>}
              </div>
              <IconButton
                label={t(active ? 'dialogueAudio.stop' : 'dialogueAudio.play', { name })}
                active={active}
                disabled={!active && (busy || !ready || !valid)}
                onClick={() => (active ? onStop() : onPlay(range, beforeLevels))}
              >
                {active ? <Square size={16} /> : <Play size={16} />}
              </IconButton>
              <IconButton
                label={t('dialogueAudio.isolate', { name })}
                disabled={busy || !canIsolate}
                onClick={() => onIsolate(track.id)}
              >
                <Scissors size={16} />
              </IconButton>
            </article>
          );
        })}
      </div>
      <small className="panel-description">{t('dialogueAudio.isolationHint')}</small>
    </Modal>
  );
}
