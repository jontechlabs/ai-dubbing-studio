import { useTranslation } from 'react-i18next';
import {
  qualityPreset,
  qualitySpec,
  resolvedQuality,
  type QualityParameter,
  type VoiceQuality,
} from '../domain/voiceQuality';

export function VoiceQualityControls({
  variant,
  value,
  disabled,
  onChange,
}: {
  variant: string;
  value?: VoiceQuality;
  disabled: boolean;
  onChange: (quality?: VoiceQuality) => void;
}) {
  const { t } = useTranslation();
  const spec = qualitySpec(variant);
  if (!spec) return null;
  const resolved = resolvedQuality(variant, value);
  return (
    <section className="settings-section voice-quality" aria-label={t('quality.title')}>
      <label className="field">
        <span>{t('quality.title')}</span>
        <select
          aria-label={t('quality.title')}
          value={qualityPreset(variant, value)}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === 'standard') onChange(undefined);
            else if (e.target.value !== 'custom') onChange({ ...spec.presets[e.target.value] });
          }}
        >
          <option value="standard">{t('quality.presets.standard')}</option>
          {Object.keys(spec.presets).map((id) => (
            <option key={id} value={id}>
              {t(`quality.presets.${id}`)}
            </option>
          ))}
          <option value="custom" disabled>
            {t('quality.presets.custom')}
          </option>
        </select>
      </label>
      <p className="panel-description">
        {t(
          variant.startsWith('voxcpm')
            ? 'quality.voxHint'
            : variant === 'cosy3-official'
              ? 'quality.stepsHint'
              : 'quality.samplingHint',
        )}
      </p>
      {variant.startsWith('chatterbox') && (
        <p className="panel-description">{t('quality.chatterHint')}</p>
      )}
      <details>
        <summary>{t('quality.advanced')}</summary>
        {Object.entries(spec.parameters).map(([key, bounds]) => (
          <label className="field" key={key}>
            <span>
              {t(`quality.params.${key}`)} · {resolved[key as QualityParameter]}
            </span>
            <input
              type="range"
              aria-label={t(`quality.params.${key}`)}
              min={bounds.min}
              max={bounds.max}
              step={bounds.step}
              value={resolved[key as QualityParameter]}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, [key]: Number(e.target.value) })}
            />
            <small className="panel-description">{t(`quality.hints.${key}`)}</small>
          </label>
        ))}
      </details>
      <p className="panel-description">{t('quality.referenceHint')}</p>
    </section>
  );
}
