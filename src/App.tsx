import { useCallback, useEffect, useState } from 'react';
import { AudioLines, ChevronUp, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialogues } from './components/Dialogues';
import { Editor } from './components/Editor';
import { Header, type Panel } from './components/Header';
import { Panels } from './components/Panels';
import { Player } from './components/Player';
import { Timeline } from './components/Timeline';
import type { Dialogue } from './domain/types';
import { useProject } from './hooks/useProject';
import { useShortcuts } from './hooks/useShortcuts';
import { useTransport } from './hooks/useTransport';
import * as bridge from './services/bridge';
import { useUpdater } from './hooks/useUpdater';

export default function App() {
  const { t, i18n } = useTranslation();
  const studio = useProject();
  const updater = useUpdater(studio.flush);
  const [panel, setPanel] = useState<Panel>(null);
  const [subtitleRole, setSubtitleRole] = useState<'source' | 'target'>('source');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [translationFocus, setTranslationFocus] = useState(0);
  const [left, setLeft] = useState(Number(localStorage.getItem('studio.left') ?? 36));
  const [timelineHeight, setTimelineHeight] = useState(
    Number(localStorage.getItem('studio.timelineHeight') ?? 242),
  );
  const [padding, setPadding] = useState(Number(localStorage.getItem('studio.padding') ?? 750));
  const [theme, setTheme] = useState(localStorage.getItem('studio.theme') ?? 'dark');
  useEffect(() => {
    const clamp = () =>
      setTimelineHeight((height) =>
        Math.min(height, Math.max(160, Math.min(420, window.innerHeight - 500))),
      );
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);
  const selected = studio.project?.dialogues.find((d) => d.id === selectedId);
  const busy =
    studio.applying ||
    studio.jobs.some(
      (job) =>
        ['import', 'subtitles'].includes(job.kind) && ['queued', 'running'].includes(job.status),
    );
  const transport = useTransport(studio.project, selected, padding, studio.setError);
  const { seek: seekVideo } = transport;
  const close = useCallback(() => setPanel(null), []);
  const closeSubtitles = useCallback(
    () => setPanel((current) => (current === 'subtitles' ? null : current)),
    [],
  );
  const showJobs = useCallback(() => setPanel('jobs'), []);
  const showCharacters = useCallback(() => setPanel('characters'), []);
  const showModels = useCallback(() => setPanel('models'), []);
  const showAlignment = useCallback(() => setPanel('alignment'), []);
  const select = useCallback(
    (line: Dialogue) => {
      setSelectedId(line.id);
      seekVideo(Math.max(0, line.startMs - padding));
    },
    [padding, seekVideo],
  );
  const importSubtitles = useCallback((role: 'source' | 'target') => {
    setSubtitleRole(role);
    setPanel('subtitles');
  }, []);
  const editTranslation = useCallback(
    (line: Dialogue) => {
      select(line);
      setTranslationFocus((value) => value + 1);
    },
    [select],
  );
  const step = (offset: number) => {
    const lines = studio.project?.dialogues ?? [];
    const index = lines.findIndex((line) => line.id === selectedId);
    const next = lines[Math.max(0, Math.min(lines.length - 1, index + offset))];
    if (next) select(next);
  };
  const original = () => {
    if (selected) transport.playLine(selected);
    else transport.toggle();
  };
  useShortcuts({
    toggle: transport.toggle,
    original,
    save: () => {
      void studio.save();
    },
    undo: () => {
      if (!busy) void studio.run(() => bridge.history('undo'));
    },
    redo: () => {
      if (!busy) void studio.run(() => bridge.history('redo'));
    },
    backward: () => {
      transport.videoRef.current?.pause();
      transport.seek(transport.time - 2000);
    },
    pause: () => transport.videoRef.current?.pause(),
    forward: () => {
      if (transport.videoRef.current?.paused) transport.toggle();
      else if (transport.videoRef.current)
        transport.videoRef.current.playbackRate = Math.min(
          4,
          transport.videoRef.current.playbackRate * 2,
        );
    },
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('studio.theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? 'en';
  }, [i18n.resolvedLanguage]);
  useEffect(() => {
    localStorage.setItem('studio.left', String(left));
    localStorage.setItem('studio.timelineHeight', String(timelineHeight));
    localStorage.setItem('studio.padding', String(padding));
  }, [left, timelineHeight, padding]);
  useEffect(() => {
    setSelectedId(null);
  }, [studio.project?.id]);
  const running = studio.jobs.find((job) => ['running', 'queued', 'paused'].includes(job.status));
  const code =
    studio.error
      ?.replace(/^Error:\s*/, '')
      .split(':')[0]
      .trim() ?? 'UNKNOWN';
  return (
    <div className="app-shell">
      <Header
        project={studio.project}
        saveState={studio.saveState}
        panel={panel}
        onPanel={setPanel}
        onOpen={() => {
          void studio.run(bridge.openProject);
        }}
        onPreview={original}
        onSave={() => {
          void studio.save();
        }}
        onHistory={(direction) => {
          void studio.run(() => bridge.history(direction));
        }}
        busy={busy}
        updateAvailable={!!updater.available}
      />
      {!bridge.native && (
        <div className="browser-banner">
          <ShieldCheck size={12} />
          {t('browser')}
        </div>
      )}
      <main className="workspace">
        <div
          className="upper-workspace"
          style={{ gridTemplateColumns: `${left}% 5px minmax(0, 1fr)` }}
        >
          <Dialogues
            project={studio.project}
            selectedId={selectedId}
            onSelect={select}
            onPlay={transport.playLine}
            onImport={importSubtitles}
            onEdit={studio.edit}
            onCharacters={showCharacters}
            onModels={showModels}
            onAlignment={showAlignment}
            onTranslation={editTranslation}
            busy={busy}
          />
          <div
            className="resize-handle vertical"
            role="separator"
            aria-label={t('resizePanels')}
            aria-orientation="vertical"
            aria-valuenow={Math.round(left)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') setLeft(Math.max(28, left - 2));
              if (e.key === 'ArrowRight') setLeft(Math.min(55, left + 2));
            }}
            onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId) && e.buttons === 1) {
                const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                setLeft(Math.max(28, Math.min(55, ((e.clientX - rect.left) / rect.width) * 100)));
              }
            }}
          />
          <div className="right-workspace">
            <Player
              project={studio.project}
              transport={transport}
              onImport={() => setPanel('import')}
              onOpen={() => {
                void studio.run(bridge.openProject);
              }}
              onDemo={() => {
                void studio.run(bridge.loadDemo);
              }}
              onStep={step}
              onAudio={() => setPanel('audio')}
              importJob={studio.jobs.find(
                (job) =>
                  job.kind === 'import' &&
                  job.projectId === studio.project?.id &&
                  ['queued', 'running'].includes(job.status),
              )}
              onJobs={showJobs}
              onEdit={studio.edit}
            />
            <Editor
              project={studio.project}
              selected={selected}
              onEdit={studio.edit}
              onPlay={transport.playLine}
              busy={busy}
              time={transport.time}
              translationFocus={translationFocus}
            />
          </div>
        </div>
        <div
          className="resize-handle horizontal"
          role="separator"
          aria-label={t('resizeTimeline')}
          aria-orientation="horizontal"
          aria-valuenow={timelineHeight}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp')
              setTimelineHeight(
                Math.max(160, Math.min(420, window.innerHeight - 500, timelineHeight + 10)),
              );
            if (e.key === 'ArrowDown') setTimelineHeight(Math.max(160, timelineHeight - 10));
          }}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId) && e.buttons === 1)
              setTimelineHeight(
                Math.max(
                  160,
                  Math.min(420, window.innerHeight - 500, window.innerHeight - e.clientY - 36),
                ),
              );
          }}
        />
        <div style={{ height: timelineHeight, flexShrink: 0 }}>
          <Timeline
            project={studio.project}
            selected={selected}
            timeRef={transport.timeRef}
            onSeek={transport.seek}
            onSelect={select}
            onEdit={studio.edit}
            busy={busy}
          />
        </div>
      </main>
      <footer className="statusbar">
        <div>
          <ShieldCheck size={12} />
          <span>{t('local')}</span>
          <span className="statusbar-shortcuts" title={t('shortcuts')}>
            {t('shortcuts')}
          </span>
        </div>
        <button onClick={() => setPanel('jobs')}>
          {running ? <LoaderCircle size={12} className="spin" /> : <AudioLines size={12} />}
          <span>
            {running
              ? `${t(`jobStages.${running.stage}`)} ${running.progress === null ? '' : `${Math.round(running.progress * 100)}%`}`
              : t('noJobs')}
          </span>
          <ChevronUp size={12} />
        </button>
      </footer>
      <Panels
        panel={panel}
        project={studio.project}
        jobs={studio.jobs}
        run={studio.run}
        close={close}
        closeSubtitles={closeSubtitles}
        showJobs={showJobs}
        subtitleRole={subtitleRole}
        onError={studio.setError}
        padding={padding}
        setPadding={setPadding}
        theme={theme}
        setTheme={setTheme}
        snapshot={studio.snapshot}
        applySnapshot={studio.applySnapshot}
        updater={updater}
        onEdit={studio.edit}
        videoRef={transport.videoRef}
        busy={busy}
        selectedId={selectedId}
        onPanel={setPanel}
      />
      {studio.error && (
        <div className="error-toast" role="alert">
          <span>{t(`errors.${code}`, { defaultValue: t('errors.UNKNOWN') })}</span>
          <button aria-label={t('close')} onClick={() => studio.setError(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
