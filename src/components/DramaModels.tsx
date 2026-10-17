import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import catalog from '../domain/dramaModels.json';
import type { VoiceInstallSpace } from '../services/bridge';
export function DramaModels({
  installed,
  installButton,
  space,
  checking,
  spaceError,
  onCheckSpace,
}: {
  installed?: boolean;
  installButton: ReactNode;
  space: VoiceInstallSpace | null;
  checking: boolean;
  spaceError: boolean;
  onCheckSpace: () => void;
}) {
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
      {id === 'drama3-comfy-fp8' && (
        <div className="drama-install">
          <div className="drama-space" aria-busy={checking}>
            <strong>{t('dramaSpaceTitle')}</strong>
            {space && (
              <>
                <code className="storage-path">{space.path}</code>
                <p>
                  {t('dramaSpaceValues', {
                    available: (space.availableBytes / 1024 ** 3).toFixed(2),
                    required: (space.requiredBytes / 1024 ** 3).toFixed(2),
                  })}
                </p>
                <p className={space.enough ? 'model-state' : 'warning'} role="status">
                  {t(space.enough ? 'dramaSpaceEnough' : 'dramaSpaceMissing', {
                    missing: (
                      Math.max(0, space.requiredBytes - space.availableBytes) /
                      1024 ** 3
                    ).toFixed(2),
                  })}
                </p>
                <small>
                  {t('dramaSpaceDetails', {
                    models: (space.modelBytes / 1024 ** 3).toFixed(2),
                    downloads: (space.downloadBytes / 1024 ** 3).toFixed(2),
                    runtime: (space.runtimeBytes / 1024 ** 3).toFixed(2),
                    margin: (space.marginBytes / 1024 ** 3).toFixed(2),
                  })}
                </small>
              </>
            )}
            {spaceError && (
              <p className="warning" role="status">
                {t('dramaSpaceError')}
              </p>
            )}
            <button className="text-button" disabled={checking} onClick={onCheckSpace}>
              {t(checking ? 'dramaSpaceChecking' : 'dramaSpaceRefresh')}
            </button>
            <p className="panel-description">{t('dramaSpaceHint')}</p>
          </div>
          <p>
            {t(
              installed === undefined
                ? 'phase6Checking'
                : installed
                  ? 'modelInstalled'
                  : 'ttsNotInstalled',
            )}
          </p>
          {installButton}
          <p className="panel-description">{t('dramaInstallHelp')}</p>
        </div>
      )}
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
      <div className="model-source">
        <code>{variant.source}</code>
        <button
          className="text-button"
          onClick={() =>
            void navigator.clipboard.writeText(variant.source).then(() => setCopied(true))
          }
        >
          {t(copied ? 'copied' : 'variantCopySource')}
        </button>
      </div>
      <p className="panel-description">{t('dramaNoGguf')}</p>
    </section>
  );
}
