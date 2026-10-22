import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  audioEffectsCatalog as catalog,
  defaultEffect,
  type AudioEffect,
  type EffectKind,
} from '../domain/audioEffects';

export function EffectsChainEditor({
  initial = [],
  disabled,
  onApply,
  onPreview,
  applyLabel,
  allowEmpty = false,
}: {
  initial?: AudioEffect[];
  disabled: boolean;
  onApply: (effects: AudioEffect[]) => void;
  onPreview?: (effects: AudioEffect[]) => void;
  applyLabel: string;
  allowEmpty?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('fr') ? 'fr' : 'en';
  const [chain, setChain] = useState<AudioEffect[]>(() => structuredClone(initial));
  const [kind, setKind] = useState<EffectKind>('equalizer');
  const replace = (index: number, update: Partial<AudioEffect>) =>
    setChain((items) => items.map((e, i) => (i === index ? { ...e, ...update } : e)));
  const move = (index: number, delta: number) =>
    setChain((items) => {
      const next = [...items];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
  return (
    <div className="effects-chain">
      <label className="field">
        <span>{t('fxPreset')}</span>
        <select
          aria-label={t('fxPreset')}
          defaultValue=""
          disabled={disabled}
          onChange={(e) => {
            const preset = catalog.presets.find((p) => p.id === e.target.value);
            if (preset) setChain(structuredClone(preset.chain) as AudioEffect[]);
            e.currentTarget.value = '';
          }}
        >
          <option value="">{t('fxPresetChoose')}</option>
          {catalog.presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label[lang]}
            </option>
          ))}
        </select>
      </label>
      <div className="effects-add">
        <select
          aria-label={t('fxChoose')}
          value={kind}
          disabled={disabled}
          onChange={(e) => setKind(e.target.value as EffectKind)}
        >
          {catalog.effects.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label[lang]}
            </option>
          ))}
        </select>
        <button
          className="button subtle"
          disabled={disabled || chain.length >= catalog.maxChain}
          onClick={() => setChain([...chain, defaultEffect(kind)])}
        >
          {t('fxAdd')}
        </button>
      </div>
      {!chain.length && <p className="panel-description">{t('fxEmpty')}</p>}
      {chain.map((effect, index) => {
        const definition = catalog.effects.find((e) => e.id === effect.kind)!;
        return (
          <fieldset className="effect-card" key={`${index}:${effect.kind}`} disabled={disabled}>
            <legend>
              <label>
                <input
                  type="checkbox"
                  aria-label={t('fxEnabled', { name: definition.label[lang], number: index + 1 })}
                  checked={effect.enabled}
                  onChange={(e) => replace(index, { enabled: e.target.checked })}
                />
                {index + 1}. {definition.label[lang]}
              </label>
            </legend>
            <div className="effect-actions">
              <button
                aria-label={t('fxUp', { number: index + 1 })}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                aria-label={t('fxDown', { number: index + 1 })}
                disabled={disabled || index === chain.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                onClick={() =>
                  replace(index, { parameters: defaultEffect(effect.kind).parameters })
                }
              >
                {t('fxReset')}
              </button>
              <button
                aria-label={t('fxRemove', { number: index + 1 })}
                onClick={() => setChain(chain.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </div>
            <div className="effect-parameters">
              {definition.parameters.map((parameter) => {
                const value = effect.parameters[parameter.id] ?? parameter.default;
                const label = t('fxParameter', {
                  effect: definition.label[lang],
                  parameter: parameter.label[lang],
                  number: index + 1,
                });
                return (
                  <label key={parameter.id}>
                    <span>{parameter.label[lang]}</span>
                    <input
                      type="range"
                      aria-label={label}
                      min={parameter.min}
                      max={parameter.max}
                      step={parameter.step}
                      value={value}
                      disabled={!effect.enabled || disabled}
                      onChange={(e) =>
                        replace(index, {
                          parameters: {
                            ...effect.parameters,
                            [parameter.id]: Number(e.target.value),
                          },
                        })
                      }
                    />
                    <output>
                      {value}
                      {parameter.unit ? ` ${parameter.unit}` : ''}
                    </output>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      <div className="effects-buttons">
        {onPreview && (
          <button className="button subtle" disabled={disabled} onClick={() => onPreview(chain)}>
            {t('fxPreview')}
          </button>
        )}
        <button
          className="button accent"
          disabled={disabled || (!allowEmpty && !chain.length)}
          onClick={() => onApply(structuredClone(chain))}
        >
          {applyLabel}
        </button>
        <button
          className="text-button"
          disabled={disabled || !chain.length}
          onClick={() => setChain([])}
        >
          {t('fxClearDraft')}
        </button>
      </div>
      <p className="panel-description">{t('fxChainHint')}</p>
    </div>
  );
}
