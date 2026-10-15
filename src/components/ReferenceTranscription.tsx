import { useState } from 'react';
import { FileText, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as bridge from '../services/bridge';

export function ReferenceTranscription({
  busy,
  start,
  onError,
}: {
  busy: boolean;
  start: (language: string) => Promise<void>;
  onError: (error: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [language, setLanguage] = useState('auto');
  const [working, setWorking] = useState(false);
  return (
    <div className="reference-transcription">
      <label className="field">
        <span>{t('asrLanguage')}</span>
        <select
          value={language}
          disabled={busy || working}
          onChange={(event) => setLanguage(event.target.value)}
        >
          <option value="auto">{t('asrLanguageAuto')}</option>
          {['ja', 'fr', 'en', 'zh', 'ko', 'de', 'es', 'it', 'ru'].map((code) => (
            <option key={code} value={code}>
              {new Intl.DisplayNames([i18n.resolvedLanguage ?? 'fr'], { type: 'language' }).of(
                code,
              )}
            </option>
          ))}
        </select>
      </label>
      <button
        className="button subtle wide"
        disabled={!bridge.native || busy || working}
        onClick={() => {
          setWorking(true);
          void start(language)
            .catch((error) => onError(String(error)))
            .finally(() => setWorking(false));
        }}
      >
        {working ? <LoaderCircle size={14} className="spin" /> : <FileText size={14} />}
        {t('asrTranscribe')}
      </button>
      <p className="panel-description">{t('asrHint')}</p>
    </div>
  );
}
