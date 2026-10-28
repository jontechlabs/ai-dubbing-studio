import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
export function OutputGainControl({
  value,
  onChange,
  disabled = false,
  take = false,
  commit,
}: {
  value: number;
  onChange?: (value: number) => void;
  disabled?: boolean;
  take?: boolean;
  commit?: (value: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value),
    [working, setWorking] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const current = commit ? draft : value,
    percent = Math.round(current * 100),
    presets = [0, 50, 100, 125, 150, 175, 200, 300, 400];
  const change = (gain: number) => {
    if (commit) setDraft(gain);
    else onChange?.(gain);
  };
  return (
    <div className="output-gain-control">
      <label className="field">
        <span>
          {t(take ? 'outputGain.takeTitle' : 'outputGain.newTitle')} · {percent}%
        </span>
        <input
          type="range"
          min={0}
          max={400}
          step={1}
          aria-label={t(take ? 'outputGain.takeTitle' : 'outputGain.newTitle')}
          value={percent}
          disabled={disabled || working}
          onChange={(e) => change(e.target.valueAsNumber / 100)}
        />
      </label>
      <label className="field">
        <span className="sr-only">{t('outputGain.preset')}</span>
        <select
          aria-label={t('outputGain.preset')}
          value={presets.includes(percent) ? percent : 'custom'}
          disabled={disabled || working}
          onChange={(e) => change(Number(e.target.value) / 100)}
        >
          {!presets.includes(percent) && (
            <option value="custom" disabled>
              {percent}%
            </option>
          )}
          {presets.map((p) => (
            <option key={p} value={p}>
              {p === 0
                ? t('outputGain.mute')
                : p === 100
                  ? t('outputGain.unity')
                  : p > 100
                    ? `+${p - 100}% (${p}%)`
                    : `−${100 - p}% (${p}%)`}
            </option>
          ))}
        </select>
      </label>
      {commit && (
        <button
          className="button subtle"
          disabled={disabled || working || draft === value}
          onClick={() => {
            setWorking(true);
            void commit(draft).finally(() => setWorking(false));
          }}
        >
          {t('outputGain.apply')}
        </button>
      )}
      <small className="panel-description">
        {t(take ? 'outputGain.takeHint' : 'outputGain.newHint')}
      </small>
    </div>
  );
}
