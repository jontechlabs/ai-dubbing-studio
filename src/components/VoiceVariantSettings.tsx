import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import type { Project } from '../domain/types';
import { variantsFor } from '../domain/modelVariants';

export function VoiceVariantSettings({
  project,
  onEdit,
}: {
  project: Project;
  onEdit: (update: (project: Project) => Project) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const variants = variantsFor(project.modelPreferences?.ttsProviderId);
  const selected = variants.find(
    (variant) => variant.id === project.modelPreferences?.voiceVariantId,
  );
  if (!variants.length) return null;
  return (
    <div className="voice-variant-settings">
      <label className="field">
        <span>{t('voiceVariantPreference')}</span>
        <select
          value={selected?.id ?? ''}
          onChange={(event) =>
            onEdit((p) => ({
              ...p,
              formatVersion: 3,
              modelPreferences: {
                ...p.modelPreferences!,
                voiceVariantId: event.target.value || null,
              },
            }))
          }
        >
          <option value="">{t('modelNoPreference')}</option>
          {variants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variant.name}
              {variant.suggested16Gb ? ` · ${t('variantCandidate16Gb')}` : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="panel-description">{t('voiceVariantsHint')}</p>
      <p className="panel-description">{t('voiceVariants16Gb')}</p>
      {selected && (
        <div className="voice-variant-detail" role="status">
          <strong>
            {selected.format} ·{' '}
            {t(selected.origin === 'official' ? 'variantOfficial' : 'variantCommunity')}
          </strong>
          <p>{t(`variantDetails.${selected.detailKey}`)}</p>
          <small>
            {t('variantEngine')}: {selected.engine}
          </small>
          <p className="panel-description">{t('variantNotIntegrated')}</p>
          {selected.reportedVramGb && (
            <p className={selected.reportedVramGb > 16 ? 'warning' : 'panel-description'}>
              {t('variantReportedVram', { gb: selected.reportedVramGb })}
              {selected.reportedVramGb > 16 && ` ${t('variantExceeds16Gb')}`}
            </p>
          )}
          <code>{selected.source}</code>
          <button
            className="text-button"
            onClick={() =>
              void navigator.clipboard.writeText(selected.source).then(() => setCopied(selected.id))
            }
          >
            {t(copied === selected.id ? 'copied' : 'variantCopySource')}
          </button>
        </div>
      )}
    </div>
  );
}
