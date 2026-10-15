import { Volume2, VolumeX, ListRestart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../domain/types';
import { audioTracks, enableAudioRegions, setAllAudio } from '../domain/audio';
export function AudioQuickControls({
  project,
  onEdit,
  compact = false,
}: {
  project: Project;
  onEdit: (update: (p: Project) => Project) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="audio-quick-controls">
      <button
        className="button subtle"
        title={t('allAudioSilent')}
        aria-label={t('allAudioSilent')}
        onClick={() => onEdit((p) => setAllAudio(p, false))}
      >
        <VolumeX size={14} />
        {!compact && t('allAudioSilent')}
      </button>
      <button
        className="button subtle"
        title={t('allAudioAudible')}
        aria-label={t('allAudioAudible')}
        onClick={() => onEdit((p) => setAllAudio(p, true))}
      >
        <Volume2 size={14} />
        {!compact && t('allAudioAudible')}
      </button>
      {audioTracks(project).some(
        (track) => track.regions?.length && track.regionsEnabled === false,
      ) && (
        <button
          className="button subtle"
          title={t('restoreAudioRegions')}
          aria-label={t('restoreAudioRegions')}
          onClick={() => onEdit((p) => enableAudioRegions(p))}
        >
          <ListRestart size={14} />
          {!compact && t('restoreAudioRegions')}
        </button>
      )}
    </div>
  );
}
