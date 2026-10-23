import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Power, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
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
  const [editing, setEditing] = useState<number | null>(null);
  const replace = (index: number, update: Partial<AudioEffect>) =>
    setChain((items) =>
      items.map((effect, i) => (i === index ? { ...effect, ...update } : effect)),
    );
  const move = (index: number, delta: number) => {
    setChain((items) => {
      const next = [...items];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
    setEditing(index + delta);
  };
  const effect = editing === null ? undefined : chain[editing];
  const definition = catalog.effects.find((item) => item.id === effect?.kind);
  return (
    <div className="effects-chain">
      <div className="effects-tools">
        <select
          aria-label={t('fxPreset')}
          defaultValue=""
          disabled={disabled}
          onChange={(event) => {
            const preset = catalog.presets.find((item) => item.id === event.target.value);
            if (preset) {
              setChain(structuredClone(preset.chain) as AudioEffect[]);
              setEditing(null);
            }
            event.currentTarget.value = '';
          }}
        >
          <option value="">{t('fxPresetChoose')}</option>
          {catalog.presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label[lang]}
            </option>
          ))}
        </select>
        <div className="effects-add">
          <select
            aria-label={t('fxChoose')}
            value={kind}
            disabled={disabled}
            onChange={(event) => setKind(event.target.value as EffectKind)}
          >
            {catalog.effects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label[lang]}
              </option>
            ))}
          </select>
          <button
            className="button subtle"
            aria-label={t('fxAdd')}
            title={t('fxAdd')}
            disabled={disabled || chain.length >= catalog.maxChain}
            onClick={() => setChain([...chain, defaultEffect(kind)])}
          >
            <Plus size={15} />
          </button>
        </div>
        <span className="effects-count" title={t('fxChainLimit')}>
          {chain.length}/{catalog.maxChain}
        </span>
      </div>
      {!chain.length && <p className="panel-description">{t('fxEmpty')}</p>}
      <div className="effect-chips">
        {chain.map((item, index) => {
          const label = catalog.effects.find((entry) => entry.id === item.kind)!.label[lang];
          return (
            <div
              className={`effect-chip ${item.enabled ? 'enabled' : 'bypassed'}`}
              key={`${index}:${item.kind}`}
            >
              <button
                className="effect-toggle"
                disabled={disabled}
                aria-label={t('fxEnabled', { name: label, number: index + 1 })}
                aria-pressed={item.enabled}
                title={`${label} · ${t(item.enabled ? 'fxOn' : 'fxOff')}`}
                onClick={() => replace(index, { enabled: !item.enabled })}
              >
                <span className="effect-number">{index + 1}</span>
                <Power size={12} />
                <span className="effect-name">{label}</span>
                <small>{t(item.enabled ? 'fxOn' : 'fxOff')}</small>
              </button>
              <button
                className="effect-chip-settings"
                disabled={disabled}
                aria-label={t('fxSettings', { name: label, number: index + 1 })}
                title={t('fxSettings', { name: label, number: index + 1 })}
                onClick={() => setEditing(index)}
              >
                <SlidersHorizontal size={13} />
              </button>
              <button
                className="effect-chip-remove"
                disabled={disabled}
                aria-label={t('fxRemove', { number: index + 1 })}
                title={t('fxRemove', { number: index + 1 })}
                onClick={() => setChain(chain.filter((_, i) => i !== index))}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
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
          onClick={() => {
            setChain([]);
            setEditing(null);
          }}
        >
          {t('fxClearDraft')}
        </button>
        <details className="effects-help">
          <summary>{t('fxHelp')}</summary>
          <p className="panel-description">{t('fxChainHint')}</p>
        </details>
      </div>
      {effect && definition && editing !== null && (
        <Modal
          title={t('fxSettingsTitle', { name: definition.label[lang] })}
          onClose={() => setEditing(null)}
        >
          <div className="effect-modal-toolbar">
            <button
              className="button subtle effect-modal-toggle"
              aria-pressed={effect.enabled}
              disabled={disabled}
              onClick={() => replace(editing, { enabled: !effect.enabled })}
            >
              <Power size={14} />
              {t(effect.enabled ? 'fxOn' : 'fxOff')}
            </button>
            <span>{t('fxPosition', { number: editing + 1, total: chain.length })}</span>
            <button
              className="icon-button"
              aria-label={t('fxUp', { number: editing + 1 })}
              disabled={disabled || editing === 0}
              onClick={() => move(editing, -1)}
            >
              <ArrowUp size={15} />
            </button>
            <button
              className="icon-button"
              aria-label={t('fxDown', { number: editing + 1 })}
              disabled={disabled || editing === chain.length - 1}
              onClick={() => move(editing, 1)}
            >
              <ArrowDown size={15} />
            </button>
            <button
              className="button subtle"
              disabled={disabled}
              onClick={() =>
                replace(editing, { parameters: defaultEffect(effect.kind).parameters })
              }
            >
              <RotateCcw size={13} />
              {t('fxReset')}
            </button>
          </div>
          <div className="effect-parameters">
            {definition.parameters.map((parameter) => {
              const value = effect.parameters[parameter.id] ?? parameter.default;
              const label = t('fxParameter', {
                effect: definition.label[lang],
                parameter: parameter.label[lang],
                number: editing + 1,
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
                    disabled={disabled}
                    onChange={(event) =>
                      replace(editing, {
                        parameters: {
                          ...effect.parameters,
                          [parameter.id]: Number(event.target.value),
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
          <p className="panel-description effect-draft-hint">{t('fxDraftHint')}</p>
          <footer className="effect-modal-footer">
            {onPreview && (
              <button
                className="button subtle"
                disabled={disabled}
                onClick={() => onPreview(chain)}
              >
                {t('fxPreview')}
              </button>
            )}
            <button className="button accent" onClick={() => setEditing(null)}>
              {t('fxDone')}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
