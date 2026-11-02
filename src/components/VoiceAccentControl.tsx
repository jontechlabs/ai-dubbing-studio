import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { VoiceSettings } from '../domain/types';
import { accentSupported, voiceAccents } from '../domain/voiceAccents';

export function VoiceAccentControl({
  settings,
  language,
  busy,
  onChange,
}: {
  settings: VoiceSettings;
  language: string;
  busy: boolean;
  onChange: (changes: Partial<VoiceSettings>) => void;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const variant = settings.variantId ?? 'cosy3-official';
  const engineSupported = accentSupported(variant);
  const supported = accentSupported(variant, language);
  const voxBlocked =
    variant === 'voxcpm2-bf16' &&
    (settings.mode === 'zeroShot' || settings.intonationGuide?.mode === 'hybrid');
  const hint = !engineSupported
    ? variant === 'audio8-realistic-06b-gguf-q8'
      ? 'ttsAccentAudio8Hint'
      : variant.startsWith('qwen3')
        ? 'ttsAccentQwenHint'
        : variant.startsWith('chatterbox')
          ? 'ttsAccentChatterboxHint'
          : 'ttsAccentUnsupported'
    : !supported
      ? 'ttsAccentLanguageHint'
      : voxBlocked
        ? 'ttsAccentVoxBlockedHint'
        : 'ttsAccentHint';
  return (
    <section className="voice-accent">
      <label className="field">
        <span>{t('ttsAccent')}</span>
        <select
          value={supported && !voxBlocked ? (settings.accent ?? 'auto') : 'auto'}
          disabled={busy || !supported || voxBlocked}
          aria-describedby={hintId}
          onChange={(event) => onChange({ accent: event.target.value as VoiceSettings['accent'] })}
        >
          <option value="auto">
            {t(engineSupported ? 'accents.auto' : 'ttsAccentFromReference')}
          </option>
          {supported &&
            voiceAccents
              .filter((a) => a.language === language)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {t(`accents.${a.labelKey}`)}
                </option>
              ))}
        </select>
      </label>
      <p id={hintId} className="panel-description">
        {t(hint)}
      </p>
      {supported && voxBlocked && (
        <button
          className="button subtle wide"
          disabled={busy}
          onClick={() => onChange({ mode: 'crossLingual', intonationGuide: undefined })}
        >
          {t('ttsAccentEnableStandard')}
        </button>
      )}
    </section>
  );
}
