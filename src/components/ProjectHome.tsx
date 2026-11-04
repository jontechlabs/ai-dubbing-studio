import { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  FolderOpen,
  FolderPlus,
  Search,
  Pencil,
  Trash2,
  RefreshCw,
  Film,
  Settings2,
  Cpu,
  LoaderCircle,
  Play,
  ImagePlus,
  RotateCcw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../domain/types';
import {
  projectName,
  type ProjectEntry,
  type ProjectCover,
  type ProjectCatalogue,
} from '../domain/projectLibrary';
import { formatTime } from '../domain/time';
import * as library from '../services/projectLibrary';
import * as bridge from '../services/bridge';
import { Modal } from './Modal';
import { IconButton } from './IconButton';
import type { OpenContextMenu } from './ContextMenu';
import type { Panel } from './Header';
export function ProjectNameModal({
  name,
  working,
  error,
  onSave,
  onClose,
}: {
  name: string;
  working: boolean;
  error: string;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(),
    [value, setValue] = useState(name);
  return (
    <Modal
      title={t('home.rename')}
      onClose={() => {
        if (!working) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value);
        }}
      >
        <label className="field">
          <span>{t('projectName')}</span>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={160}
            disabled={working}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="reference-actions">
          <button type="button" className="button subtle" disabled={working} onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="button accent" disabled={working || !value.trim()}>
            {working ? <LoaderCircle size={14} className="spin" /> : null}
            {t('home.rename')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ProjectImage({ entry, revision }: { entry: ProjectEntry; revision: number }) {
  const { t } = useTranslation(),
    ref = useRef<HTMLDivElement>(null),
    [visible, setVisible] = useState(false),
    [image, setImage] = useState<ProjectCover | null>(null),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const element = ref.current!;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    io.observe(element);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !entry.hasVideo || !entry.available) return;
    const controller = new AbortController();
    setLoading(true);
    void library
      .projectCover(entry.key, undefined, controller.signal)
      .then((c) => {
        if (!controller.signal.aborted) setImage(c);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [visible, entry.key, entry.hasVideo, entry.available, entry.updatedAt, revision]);
  return (
    <div ref={ref} className="project-cover">
      {image ? (
        <img src={image.url} alt={t('home.coverAlt', { name: entry.name })} />
      ) : (
        <Film size={34} aria-hidden="true" />
      )}
      {loading && (
        <LoaderCircle
          className="spin project-cover-loading"
          size={18}
          aria-label={t('home.loadingCover')}
        />
      )}
      <span className="project-duration">
        {entry.durationMs ? formatTime(entry.durationMs).split('.')[0] : t('home.emptyProject')}
      </span>
    </div>
  );
}
export function ProjectHome({
  open,
  onPanel,
  onError,
  onMenu,
  locked,
}: {
  open: (operation: () => Promise<Project | null>) => Promise<void>;
  onPanel: (panel: Panel) => void;
  onError: (s: string) => void;
  onMenu: OpenContextMenu;
  locked: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<ProjectCatalogue>({
      entries: [],
      defaultParent: '',
      activeKey: null,
    }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [trash, setTrash] = useState(false),
    [refresh, setRefresh] = useState(0),
    [working, setWorking] = useState(false),
    [dialog, setDialog] = useState<{
      kind: 'rename' | 'trash' | 'forget' | 'cover';
      entry: ProjectEntry;
    } | null>(null),
    [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [source, setSource] = useState('ja'),
    [target, setTarget] = useState('fr'),
    [parent, setParent] = useState(''),
    [at, setAt] = useState('120'),
    [cover, setCover] = useState<ProjectCover | null>(null),
    [coverRevision, setCoverRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRefresh((n) => n + 1);
    document.addEventListener('studio-projects-changed', changed);
    return () => document.removeEventListener('studio-projects-changed', changed);
  }, []);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    void library
      .catalogue()
      .then((v) => {
        if (!disposed) {
          setData(v);
          setParent(v.defaultParent);
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [refresh]);
  const message = (e: unknown) =>
    t(
      `errors.${
        String(e)
          .replace(/^Error:\s*/, '')
          .split(':')[0]
      }`,
      { defaultValue: String(e) },
    );
  const act = async (operation: () => Promise<unknown>, close = true) => {
    setWorking(true);
    setError('');
    try {
      await operation();
      setRefresh((n) => n + 1);
      if (close) {
        setDialog(null);
        setCreating(false);
      }
    } catch (e) {
      setError(message(e));
      onError(String(e));
    } finally {
      setWorking(false);
    }
  };
  const choose = (kind: 'rename' | 'trash' | 'forget' | 'cover', entry: ProjectEntry) => {
    setError('');
    setDialog({ kind, entry });
    setCover(null);
    setAt(String((entry.coverAtMs ?? Math.min(120000, (entry.durationMs ?? 300000) * 0.4)) / 1000));
  };
  const opened = async (entry: ProjectEntry) => {
    if (working || locked) return;
    setWorking(true);
    try {
      await open(() => bridge.openRegisteredProject(entry.key));
    } catch (e) {
      setError(message(e));
      onError(String(e));
    } finally {
      setWorking(false);
    }
  };
  const rows = data.entries.filter(
    (e) =>
      !!e.trashedAt === trash && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const date = (s: string | null) => {
    const d = s ? new Date(s) : null;
    return d && Number.isFinite(d.getTime())
      ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(d)
      : '—';
  };
  const canTrash = (entry: ProjectEntry) =>
    entry.available && (!bridge.native || entry.path.toLowerCase().endsWith('.dubproject'));
  return (
    <section className="project-home" aria-label={t('home.title')}>
      <aside className="project-home-sidebar">
        <div className="project-home-brand">
          <AudioLines size={25} />
          <strong>{t('brand')}</strong>
        </div>
        <p>{t('local')}</p>
        <button aria-pressed={!trash} onClick={() => setTrash(false)}>
          <FolderOpen size={18} />
          {t('home.projects')}
        </button>
        <button aria-pressed={trash} onClick={() => setTrash(true)}>
          <Trash2 size={18} />
          {t('home.trash')}
          <small>{data.entries.filter((e) => e.trashedAt).length || ''}</small>
        </button>
        <div className="project-home-sidebar-bottom">
          <button onClick={() => onPanel('models')}>
            <Cpu size={17} />
            {t('models')}
          </button>
          <button onClick={() => onPanel('settings')}>
            <Settings2 size={17} />
            {t('settings')}
          </button>
        </div>
      </aside>
      <div className="project-home-content">
        <header className="project-home-header">
          <div>
            <h1>{t(trash ? 'home.trash' : 'home.title')}</h1>
            <p>{t(trash ? 'home.trashHint' : 'home.hint')}</p>
          </div>
          <div className="reference-actions">
            <button
              className="button subtle"
              disabled={working || locked}
              onClick={() => void open(bridge.openProject).catch((e) => onError(String(e)))}
            >
              <FolderOpen size={16} />
              {t('home.openExisting')}
            </button>
            <button
              className="button accent"
              disabled={working || locked}
              onClick={() => {
                setError('');
                setCreating(true);
                setName('');
              }}
            >
              <FolderPlus size={16} />
              {t('home.create')}
            </button>
          </div>
        </header>
        <div className="project-home-filters">
          <label>
            <Search size={16} />
            <input
              aria-label={t('home.search')}
              placeholder={t('home.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <span>{t('home.count', { count: rows.length })}</span>
          <IconButton
            label={t('refresh')}
            disabled={loading || working}
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw size={16} />
          </IconButton>
        </div>
        {locked && (
          <p role="status" className="panel-description">
            {t('home.busy')}
          </p>
        )}
        {loading && (
          <p role="status" className="home-loading">
            <LoaderCircle size={18} className="spin" />
            {t('home.loading')}
          </p>
        )}
        {error && !dialog && !creating && <p role="alert">{error}</p>}
        {!loading && !rows.length && (
          <div className="project-home-empty">
            <FolderOpen size={48} />
            <h2>{t(query ? 'home.noMatches' : trash ? 'home.emptyTrash' : 'home.empty')}</h2>
            {!trash && !query && (
              <button
                className="button subtle"
                disabled={working || locked}
                onClick={() => void open(bridge.loadDemo).catch((e) => onError(String(e)))}
              >
                <Play size={15} />
                {t('demo')}
              </button>
            )}
          </div>
        )}
        <div className="project-grid">
          {rows.map((entry) => (
            <article
              key={entry.key}
              className="project-card"
              aria-label={entry.name}
              onContextMenu={(e) =>
                onMenu(
                  e,
                  entry.name,
                  trash
                    ? [
                        {
                          label: t('home.restore'),
                          disabled: working || locked || !entry.available,
                          run: () => void act(() => library.restoreProject(entry.key)),
                        },
                      ]
                    : [
                        {
                          label: t('open'),
                          disabled: working || locked || !entry.available,
                          run: () => void opened(entry),
                        },
                        {
                          label: t('home.rename'),
                          disabled: working || locked || !entry.available,
                          run: () => choose('rename', entry),
                        },
                        {
                          label: t('home.cover'),
                          disabled: working || locked || !entry.hasVideo || !entry.available,
                          run: () => choose('cover', entry),
                        },
                        {
                          label: t(canTrash(entry) ? 'home.delete' : 'home.forget'),
                          danger: true,
                          disabled: working || locked,
                          run: () => choose(canTrash(entry) ? 'trash' : 'forget', entry),
                        },
                      ],
                )
              }
            >
              <button
                className="project-card-open"
                title={entry.path || entry.name}
                aria-label={t('home.openNamed', { name: entry.name })}
                disabled={working || locked || !entry.available || trash}
                onClick={() => void opened(entry)}
              >
                <ProjectImage entry={entry} revision={coverRevision} />
                <strong>{entry.name}</strong>
              </button>
              <div className="project-card-info">
                <small>{entry.available ? date(entry.updatedAt) : t('home.unavailable')}</small>
                {entry.source && (
                  <span>
                    {entry.source.toUpperCase()} → {entry.target?.toUpperCase()}
                  </span>
                )}
              </div>
              <div className="project-card-actions">
                {trash ? (
                  <button
                    className="button subtle"
                    disabled={working || locked || !entry.available}
                    onClick={() => void act(() => library.restoreProject(entry.key))}
                  >
                    <RotateCcw size={14} />
                    {t('home.restore')}
                  </button>
                ) : (
                  <>
                    <IconButton
                      label={t('home.renameNamed', { name: entry.name })}
                      disabled={working || locked || !entry.available}
                      onClick={() => choose('rename', entry)}
                    >
                      <Pencil size={16} />
                    </IconButton>
                    <IconButton
                      label={t('home.coverNamed', { name: entry.name })}
                      disabled={working || locked || !entry.available || !entry.hasVideo}
                      onClick={() => choose('cover', entry)}
                    >
                      <ImagePlus size={15} />
                    </IconButton>
                    <IconButton
                      label={t(canTrash(entry) ? 'home.deleteNamed' : 'home.forgetNamed', {
                        name: entry.name,
                      })}
                      disabled={working || locked}
                      onClick={() => choose(canTrash(entry) ? 'trash' : 'forget', entry)}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
      {creating && (
        <Modal
          title={t('home.create')}
          onClose={() => {
            if (!working) setCreating(false);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const n = projectName(name);
                await open(() =>
                  bridge.createLibraryProject(n, source, target, parent || undefined),
                );
              });
            }}
          >
            <label className="field">
              <span>{t('projectName')}</span>
              <input
                autoFocus
                value={name}
                maxLength={160}
                onChange={(e) => setName(e.target.value)}
                disabled={working}
              />
            </label>
            <div className="two-fields">
              {(['source', 'target'] as const).map((kind) => (
                <label className="field" key={kind}>
                  <span>{t(kind === 'source' ? 'sourceLanguage' : 'targetLanguage')}</span>
                  <select
                    value={kind === 'source' ? source : target}
                    onChange={(e) => (kind === 'source' ? setSource : setTarget)(e.target.value)}
                  >
                    {['ja', 'fr', 'en', 'es', 'de', 'it', 'pt', 'zh', 'ko'].map((c) => (
                      <option key={c} value={c}>
                        {new Intl.DisplayNames([i18n.resolvedLanguage ?? 'fr'], {
                          type: 'language',
                        }).of(c)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {bridge.native && (
              <label className="field">
                <span>{t('home.folder')}</span>
                <div className="project-folder">
                  <input aria-label={t('home.folder')} value={parent} readOnly />
                  <IconButton
                    label={t('chooseFolder')}
                    disabled={working}
                    onClick={() =>
                      void library.chooseProjectParent().then((p) => {
                        if (p) setParent(p);
                      })
                    }
                  >
                    <FolderOpen size={16} />
                  </IconButton>
                </div>
              </label>
            )}
            {error && <p role="alert">{error}</p>}
            <button className="button accent wide" disabled={working || locked || !name.trim()}>
              {working ? <LoaderCircle size={16} className="spin" /> : <FolderPlus size={16} />}{' '}
              {t('create')}
            </button>
          </form>
        </Modal>
      )}
      {dialog?.kind === 'rename' && (
        <ProjectNameModal
          name={dialog.entry.name}
          error={error}
          working={working}
          onClose={() => setDialog(null)}
          onSave={(name) =>
            void act(() => library.renameProject(dialog.entry.key, dialog.entry.revision!, name))
          }
        />
      )}
      {dialog && (dialog.kind === 'trash' || dialog.kind === 'forget') && (
        <Modal
          title={t(dialog.kind === 'trash' ? 'home.delete' : 'home.forget')}
          onClose={() => {
            if (!working) setDialog(null);
          }}
        >
          <p className="project-confirm-name">
            <strong>{dialog.entry.name}</strong>
          </p>
          <p>{t(dialog.kind === 'trash' ? 'home.deleteConfirm' : 'home.forgetConfirm')}</p>
          {dialog.entry.path && <small className="project-path">{dialog.entry.path}</small>}
          {error && <p role="alert">{error}</p>}
          <div className="reference-actions">
            <button className="button subtle" disabled={working} onClick={() => setDialog(null)}>
              {t('cancel')}
            </button>
            <button
              className="button accent"
              disabled={working || locked}
              onClick={() =>
                void act(() =>
                  dialog.kind === 'trash'
                    ? library.trashProject(dialog.entry.key, dialog.entry.revision!, true)
                    : library.forgetProject(dialog.entry.key, true),
                )
              }
            >
              {working ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{' '}
              {t(dialog.kind === 'trash' ? 'home.moveToTrash' : 'home.forget')}
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === 'cover' && (
        <Modal
          title={t('home.cover')}
          onClose={() => {
            if (!working) setDialog(null);
          }}
        >
          <p className="panel-description">{t('home.coverHint')}</p>
          {cover && (
            <img
              className="project-cover-preview"
              src={cover.url}
              alt={t('home.coverAlt', { name: dialog.entry.name })}
            />
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const c = await library.projectCover(
                  dialog.entry.key,
                  Math.round(Number(at) * 1000),
                );
                setCover(c);
                setCoverRevision((n) => n + 1);
              }, false);
            }}
          >
            <label className="field">
              <span>{t('home.coverTime')}</span>
              <input
                type="number"
                min="0"
                max={(dialog.entry.durationMs ?? 0) / 1000}
                step="0.1"
                value={at}
                onChange={(e) => setAt(e.target.value)}
                disabled={working}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <div className="reference-actions">
              <button className="button accent" disabled={working || !at.trim()}>
                {working ? <LoaderCircle className="spin" size={15} /> : <ImagePlus size={15} />}{' '}
                {t('home.capture')}
              </button>
              <button
                type="button"
                className="button subtle"
                disabled={working}
                onClick={() => setDialog(null)}
              >
                {t('close')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
