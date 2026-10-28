import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../domain/types';
import type { VoiceConversionOptions } from '../domain/voiceCapture';
import * as bridge from '../services/bridge';
export function DubbingPipelineControls({
  project,
  enabled,
  setEnabled,
  conversion,
  setConversion,
  strength,
  setStrength,
  busy,
  onModels,
  onReady,
}: {
  project: Project;
  enabled: boolean;
  setEnabled: (b: boolean) => void;
  conversion: VoiceConversionOptions;
  setConversion: (v: VoiceConversionOptions) => void;
  strength: number;
  setStrength: (v: number) => void;
  busy: boolean;
  onModels: () => void;
  onReady: (ready: boolean) => void;
}) {
  const { t } = useTranslation(),
    [status, setStatus] = useState<bridge.VoiceStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    if (enabled)
      void bridge
        .voiceStatus(true)
        .then((s) => {
          if (!disposed) {
            setStatus(s);
            onReady(s.variants.some((v) => v.id === 'chatterbox-vc' && v.installed));
          }
        })
        .catch(() => {
          if (!disposed) onReady(false);
        });
    return () => {
      disposed = true;
    };
  }, [enabled, onReady]);
  const refs = [
    ...project.characters.flatMap((c) =>
      [
        ...c.references,
        ...(project.characterProfiles?.[c.id]?.voiceLibrary?.samples
          .filter((s) => s.status === 'approved')
          .map((s) => s.reference) ?? []),
      ].map((r) => ({ id: r.id, owner: c.id, label: `${c.name} · ${r.label}` })),
    ),
    ...(project.voiceReferences ?? []).map((r) => ({ id: r.id, owner: null, label: r.label })),
  ];
  const value =
    conversion.referenceMode === 'current'
      ? 'current'
      : JSON.stringify({ id: conversion.referenceId, owner: conversion.characterId });
  return (
    <section className="pipeline-controls">
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {t('pipeline.enable')}
      </label>
      {enabled && (
        <>
          <p className="panel-description">{t('pipeline.hint')}</p>
          <label className="field">
            <span>{t('pipeline.target')}</span>
            <select
              aria-label={t('pipeline.target')}
              value={value}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value === 'current')
                  setConversion({
                    ...conversion,
                    referenceMode: 'current',
                    referenceId: '',
                    characterId: null,
                  });
                else {
                  const r = JSON.parse(e.target.value) as { id: string; owner: string | null };
                  setConversion({
                    ...conversion,
                    referenceMode: 'reference',
                    referenceId: r.id,
                    characterId: r.owner,
                  });
                }
              }}
            >
              <option value="current">{t('ttsReferenceCurrent')}</option>
              {refs.map((r) => (
                <option key={r.id} value={JSON.stringify({ id: r.id, owner: r.owner })}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('pipeline.device')}</span>
            <select
              aria-label={t('pipeline.device')}
              value={conversion.device}
              disabled={busy}
              onChange={(e) => setConversion({ ...conversion, device: e.target.value })}
            >
              <option value="auto">{t('auto')}</option>
              <option value="cpu">CPU</option>
              {status?.cudaDevices
                .filter((d) => d.id.startsWith('cuda:'))
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>
              {t('pipeline.guide')} · {Math.round(strength * 100)}%
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              aria-label={t('pipeline.guide')}
              value={Math.round(strength * 100)}
              disabled={busy}
              onChange={(e) => setStrength(Number(e.target.value) / 100)}
            />
          </label>
          <small>{t('pipeline.guideHint')}</small>
          {!status?.variants.some((v) => v.id === 'chatterbox-vc' && v.installed) && (
            <button className="button subtle wide" onClick={onModels}>
              {t('capture.install')}
            </button>
          )}
        </>
      )}
    </section>
  );
}
