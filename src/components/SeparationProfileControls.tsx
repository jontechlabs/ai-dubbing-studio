import { useTranslation } from 'react-i18next';
import type { SeparationMemoryProfile } from '../domain/speakerDubbing';
export function SeparationProfileControls({
  counts,
  count,
  profile,
  disabled,
  onCount,
  onProfile,
}: {
  counts: number[];
  count: number;
  profile: SeparationMemoryProfile;
  disabled: boolean;
  onCount: (n: number) => void;
  onProfile: (p: SeparationMemoryProfile) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="separation-profile">
      {counts.length > 1 && (
        <label className="field">
          <span>{t('spectral.count')}</span>
          <select
            disabled={disabled}
            value={count}
            onChange={(e) => onCount(Number(e.target.value))}
          >
            {counts.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>{t('spectral.profile')}</span>
        <select
          disabled={disabled}
          value={profile}
          onChange={(e) => onProfile(e.target.value as SeparationMemoryProfile)}
        >
          <option value="gpu16">{t('spectral.gpu16')}</option>
          <option value="quality">{t('spectral.quality')}</option>
          <option value="manual">{t('spectral.manual')}</option>
        </select>
      </label>
      <small className="panel-description">{t('spectral.hint')}</small>
    </div>
  );
}
export function SeparationResultDetails({
  result,
}: {
  result: {
    windowMs?: number | null;
    attempts?: number | null;
    precision?: string | null;
    peakVramMb?: number | null;
  };
}) {
  const { t } = useTranslation();
  return typeof result.windowMs === 'number' ? (
    <small className="panel-description">
      {t('spectral.result', {
        seconds: result.windowMs / 1000,
        precision: result.precision ?? 'FP32',
        attempts: result.attempts ?? 1,
        vram: result.peakVramMb ?? 0,
      })}
    </small>
  ) : null;
}
