import { isolatedVoice } from '../domain/speakerDubbing';
import { useTranslation } from 'react-i18next';
import type { Project, VoiceSettings } from '../domain/types';
import { audioTracks, trackLabel } from '../domain/audio';

export function IntonationGuideControls({
  project,
  settings,
  busy,
  onChange,
  lineId,
}: {
  project: Project;
  lineId?: string;
  settings: VoiceSettings;
  busy: boolean;
  onChange: (changes: Partial<VoiceSettings>) => void;
}) {
  const { t } = useTranslation();
  if (settings.variantId !== 'voxcpm2-bf16') return null;
  const guide = settings.intonationGuide;
  return (
    <section className="settings-section intonation-guide">
      <label className="field">
        <span>{t('library.guideTitle')}</span>
        <select
          aria-label={t('library.guideTitle')}
          value={guide?.mode ?? 'off'}
          disabled={busy || settings.referenceMode === 'current'}
          onChange={(e) => {
            const mode = e.target.value;
            if (mode === 'off') onChange({ intonationGuide: undefined });
            else
              onChange({
                intonationGuide: {
                  mode: mode as 'style' | 'hybrid',
                  trackId: guide?.trackId ?? 'auto',
                },
                mode: 'crossLingual',
                ...(mode === 'hybrid' ? { accent: 'auto', mood: 'default' } : {}),
              });
          }}
        >
          <option value="off">{t('library.guideOff')}</option>
          <option value="style">{t('library.guideStyle')}</option>
          <option value="hybrid">{t('library.guideHybrid')}</option>
        </select>
      </label>
      <p className="panel-description">
        {t(settings.referenceMode === 'current' ? 'library.guideNeedsVoice' : 'library.guideHint')}
      </p>
      {guide && (
        <>
          {lineId && isolatedVoice(project, lineId) ? (
            <p className="panel-description">{t('overlap.isolatedGuide')}</p>
          ) : (
            <label className="field">
              <span>{t('library.guideTrack')}</span>
              <select
                aria-label={t('library.guideTrack')}
                disabled={busy}
                value={guide.trackId ?? 'auto'}
                onChange={(e) =>
                  onChange({ intonationGuide: { ...guide, trackId: e.target.value } })
                }
              >
                <option value="auto">{t('referenceTrackDefault')}</option>
                {audioTracks(project)
                  .filter((r) => r.kind !== 'dubbing')
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {t(trackLabel(r))}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <p className={guide.mode === 'hybrid' ? 'warning' : 'panel-description'}>
            {t(guide.mode === 'hybrid' ? 'library.guideHybridHint' : 'library.guideStyleHint')}
          </p>
        </>
      )}
    </section>
  );
}
