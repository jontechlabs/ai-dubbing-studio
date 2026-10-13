import { useState } from 'react';
import { Film, FolderOpen, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MediaInfo, Project } from '../domain/types';
import * as bridge from '../services/bridge';

export function ImportPanel({
  run,
  onClose,
  onError,
}: {
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<{ path: string; info: MediaInfo } | null>(null);
  const [probing, setProbing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [source, setSource] = useState('ja');
  const [target, setTarget] = useState('fr');
  const [audio, setAudio] = useState<number | null>(null);
  const choose = async () => {
    setProbing(true);
    try {
      const result = await bridge.chooseMedia();
      if (!result) return;
      setChoice(result);
      setName(result.info.originalName.replace(/\.[^.]+$/, ''));
      const track = result.info.streams.find((stream) => stream.kind === 'audio');
      setAudio(track?.index ?? null);
    } catch (e) {
      onError(String(e));
    } finally {
      setProbing(false);
    }
  };
  const create = async () => {
    if (!choice || !name.trim()) return;
    setCreating(true);
    await run(async () => {
      const project = await bridge.createProject(name.trim(), source, target);
      if (!project) return null;
      try {
        const imported = await bridge.importMedia(choice.path, audio);
        onClose();
        return imported ?? project;
      } catch (e) {
        onError(String(e));
        return project;
      }
    });
    setCreating(false);
  };
  return (
    <div className="panel-body import-panel">
      <p className="panel-description">{t('importHint')}</p>
      <button className="media-choice" onClick={() => void choose()} disabled={probing || creating}>
        {probing ? <LoaderCircle className="spin" size={26} /> : <Film size={28} />}
        <strong>{probing ? t('probing') : (choice?.info.originalName ?? t('chooseVideo'))}</strong>
        <span>
          {choice
            ? `${(choice.info.durationMs / 1000).toFixed(1)} s · ${t('changeVideo')}`
            : 'MKV · MP4 · MOV · AVI · WEBM'}
        </span>
      </button>
      <label className="field">
        <span>{t('projectName')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={creating} />
      </label>
      <div className="two-fields">
        <LanguageField label={t('sourceLanguage')} value={source} onChange={setSource} />
        <LanguageField label={t('targetLanguage')} value={target} onChange={setTarget} />
      </div>
      <label className="field">
        <span>{t('sourceAudio')}</span>
        <select
          value={audio ?? ''}
          onChange={(e) => setAudio(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">{t('noAudio')}</option>
          {choice?.info.streams
            .filter((s) => s.kind === 'audio')
            .map((s) => (
              <option key={s.index} value={s.index}>
                {s.language} · {s.codec.toUpperCase()} · {s.channels} ch {s.title}
              </option>
            ))}
        </select>
      </label>
      {choice?.info.streams.some((s) => s.kind === 'subtitle') && (
        <div className="detected-subtitles">
          <span className="field-label">{t('subtitles')}</span>
          {choice.info.streams
            .filter((s) => s.kind === 'subtitle')
            .map((s) => (
              <div key={s.index}>
                {s.language} · {s.codec}
                <small>{s.bitmap ? t('bitmap') : s.title}</small>
              </div>
            ))}
          <p>{t('embeddedHint')}</p>
        </div>
      )}
      <button
        className="button accent wide"
        disabled={!choice || !name.trim() || probing || creating}
        onClick={() => void create()}
      >
        {creating ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}{' '}
        {t('create')}
      </button>
    </div>
  );
}
function LanguageField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { i18n } = useTranslation();
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {['ja', 'fr', 'en', 'es', 'de', 'it', 'pt', 'zh', 'ko'].map((code) => (
          <option key={code} value={code}>
            {new Intl.DisplayNames([i18n.resolvedLanguage ?? 'en'], { type: 'language' }).of(code)}
          </option>
        ))}
      </select>
    </label>
  );
}
