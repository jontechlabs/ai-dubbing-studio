import {
  AudioLines,
  Captions,
  Download,
  Film,
  FolderOpen,
  ScanLine,
  Settings2,
  Sparkles,
  Users,
  Cpu,
  Play,
  Undo2,
  Redo2,
  DownloadCloud,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../domain/types';
import { IconButton } from './IconButton';

export type Panel =
  | 'import'
  | 'audio'
  | 'characters'
  | 'models'
  | 'export'
  | 'settings'
  | 'jobs'
  | 'subtitles'
  | 'alignment'
  | 'dub'
  | null;
export function Header({
  project,
  saveState,
  panel,
  onPanel,
  onOpen,
  onPreview,
  onSave,
  onHistory,
  busy,
  updateAvailable,
}: {
  project: Project | null;
  saveState: string;
  panel: Panel;
  onPanel: (panel: Panel) => void;
  onOpen: () => void;
  onPreview: () => void;
  onSave: () => void;
  onHistory: (direction: 'undo' | 'redo') => void;
  busy: boolean;
  updateAvailable: boolean;
}) {
  const { t } = useTranslation();
  return (
    <header className="header">
      <div className="titlebar">
        <div className="brand">
          <div className="brand-icon">
            <AudioLines size={23} />
          </div>
          <span>{t('brand')}</span>
          <span className="phase-label">{t('local')}</span>
        </div>
        <div className="project-title">
          <Film size={14} />
          {project?.name ?? '—'}
        </div>
        <div className="title-actions">
          {updateAvailable && (
            <IconButton label={t('updatesAvailableShort')} onClick={() => onPanel('settings')}>
              <DownloadCloud size={17} />
            </IconButton>
          )}
          <button
            className={`save-indicator ${saveState === 'saveError' ? 'warning' : ''}`}
            onClick={onSave}
            disabled={!project || busy}
          >
            <span className={`save-dot ${saveState === 'saved' ? 'done' : ''}`} />
            {t(saveState)}
          </button>
          <IconButton
            label={t('settings')}
            active={panel === 'settings'}
            onClick={() => onPanel('settings')}
          >
            <Settings2 size={17} />
          </IconButton>
        </div>
      </div>
      <nav className="toolbar" aria-label={t('brand')}>
        <button className="tool-button primary" onClick={() => onPanel('import')} disabled={busy}>
          <FolderOpen size={17} />
          {t('import')}
        </button>
        <button
          className="tool-button"
          onClick={() => onPanel('alignment')}
          disabled={!project || busy}
        >
          <ScanLine size={17} />
          {t('analyse')}
        </button>
        <button className="tool-button" onClick={() => onPanel('audio')} disabled={!project?.media}>
          <AudioLines size={17} />
          {t('audio')}
        </button>
        <span className="toolbar-separator" />
        <button className="tool-button" disabled={!project} onClick={() => onPanel('characters')}>
          <Users size={17} />
          {t('characters')}
        </button>
        <button className="tool-button" onClick={() => onPanel('models')}>
          <Cpu size={17} />
          {t('models')}
        </button>
        <span className="toolbar-space" />
        <IconButton label={t('open')} disabled={busy} onClick={onOpen}>
          <FolderOpen size={17} />
        </IconButton>
        <IconButton label="Ctrl+Z" disabled={!project || busy} onClick={() => onHistory('undo')}>
          <Undo2 size={17} />
        </IconButton>
        <IconButton label="Ctrl+Y" disabled={!project || busy} onClick={() => onHistory('redo')}>
          <Redo2 size={17} />
        </IconButton>
        <span className="toolbar-separator" />
        <button className="tool-button" onClick={onPreview} disabled={!project?.media}>
          <Play size={16} />
          {t('preview')}
        </button>
        <button
          className="tool-button export-button"
          onClick={() => onPanel('export')}
          disabled={!project}
        >
          <Download size={16} />
          {t('export')}
        </button>
      </nav>
      <span className="sr-only">
        <Captions />
        <Sparkles />
      </span>
    </header>
  );
}
