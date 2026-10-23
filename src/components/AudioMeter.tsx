import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioLevels } from '../hooks/useAudioLevels';
import { METER_FLOOR, MIX_METER } from '../services/audioLevels';

const displayDb = (db: number) =>
  db <= METER_FLOOR ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
const percent = (db: number) => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
export function AudioMeter({
  id = MIX_METER,
  name,
  compact = false,
}: {
  id?: string;
  name: string;
  compact?: boolean;
}) {
  const store = useAudioLevels();
  const level = useSyncExternalStore(store.subscribe, () => store.getSnapshot().tracks[id]);
  const status = useSyncExternalStore(store.subscribe, () => store.getSnapshot().status);
  const { t } = useTranslation();
  const peak = Math.max(METER_FLOOR, ...(level?.channels.map((c) => c.peakDb) ?? []));
  const max = Math.max(METER_FLOOR, ...(level?.channels.map((c) => c.maxDb) ?? []));
  return (
    <div
      className={`audio-meter ${compact ? 'compact' : ''} ${level?.clipped ? 'clipped' : ''}`}
      role="group"
      aria-label={t('meterLabel', { name })}
      data-meter-id={id}
      data-peak-db={peak}
      data-clipped={!!level?.clipped}
      data-meter-status={status}
      title={status === 'unavailable' ? t('meterUnavailable') : undefined}
    >
      {!compact && <strong>{name}</strong>}
      <div
        className="audio-meter-bars"
        title={t('meterPeak', { peak: displayDb(peak), max: displayDb(max) })}
      >
        {[0, 1].map((channel) => {
          const value = level?.channels[channel];
          return (
            <div
              className="audio-meter-channel"
              key={channel}
              role="meter"
              aria-label={t(channel === 0 ? 'meterLeft' : 'meterRight', { name })}
              aria-valuemin={-96}
              aria-valuemax={24}
              aria-valuenow={Math.min(24, value?.peakDb ?? METER_FLOOR)}
              aria-valuetext={`${displayDb(value?.peakDb ?? METER_FLOOR)} dBFS`}
            >
              <span
                className="audio-meter-fill"
                style={{
                  clipPath: `inset(0 calc(100% - ${percent(value?.rmsDb ?? METER_FLOOR)}) 0 0)`,
                }}
              />
              <span
                className="audio-meter-peak"
                style={{
                  left: percent(value?.peakDb ?? METER_FLOOR),
                  opacity: (value?.peakDb ?? METER_FLOOR) > -60 ? 1 : 0,
                }}
              />
            </div>
          );
        })}
        {!compact && (
          <span className="audio-meter-scale">
            <span>−60</span>
            <span>−24</span>
            <span>−12</span>
            <span>0 dBFS</span>
          </span>
        )}
      </div>
      <output className="audio-meter-value" aria-label={t('meterPeakValue', { name })}>
        {status === 'unavailable' ? '—' : displayDb(peak)}
      </output>
      <button
        className="audio-meter-clip"
        aria-label={t('meterReset', { name })}
        aria-pressed={!!level?.clipped}
        title={
          status === 'unavailable'
            ? t('meterUnavailable')
            : t('meterResetHint', { max: displayDb(max) })
        }
        onClick={() => store.reset(id)}
      >
        {level?.clipped ? t('meterClip') : '●'}
      </button>
    </div>
  );
}
