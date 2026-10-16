import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import catalog from '../domain/dramaModels.json';
export function DramaModels() {
  const { t } = useTranslation(),
    [id, setId] = useState('drama3-comfy-fp8'),
    [copied, setCopied] = useState(false);
  const variant = catalog.variants.find((v) => v.id === id)!;
  return (
    <section className="model-card drama-models">
      <h3>{t('dramaTitle')}</h3>
      <span className="model-state">
        {t(id === 'drama3-comfy-fp8' ? 'dramaIntegrated' : 'dramaStatus')}
      </span>
      <p>{t(id === 'drama3-comfy-fp8' ? 'dramaGenerationHint' : 'dramaHint')}</p>
      <label className="field">
        <span>{t('dramaVariant')}</span>
        <select
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setCopied(false);
          }}
        >
          {catalog.variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      <p>{t(variant.detailKey)}</p>
      {variant.candidate16Gb && <p className="warning">{t('dramaCandidate')}</p>}
      <p>{t('dramaSize', { size: (variant.sizeBytes / 1024 ** 3).toFixed(2) })}</p>
      <small>
        {variant.engine} ·{' '}
        {t(variant.origin === 'official' ? 'variantOfficial' : 'variantCommunity')}
      </small>
      <p>{t('dramaLicense')}</p>
      <code>{variant.source}</code>
      <button
        className="text-button"
        onClick={() =>
          void navigator.clipboard.writeText(variant.source).then(() => setCopied(true))
        }
      >
        {t(copied ? 'copied' : 'variantCopySource')}
      </button>
      <p className="panel-description">{t('dramaNoGguf')}</p>
    </section>
  );
}
