import { useCallback, useEffect, useMemo, useState } from 'react';
import { AudioLines, ChevronUp, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MicrophoneIndicator } from './components/VoiceCapture';
import { JobDuration } from './components/JobDuration';
import { readMicrophone } from './services/microphone';
import { Dialogues } from './components/Dialogues';
import { Editor } from './components/Editor';
import { Header, type Panel } from './components/Header';
import { Panels } from './components/Panels';
import { Player } from './components/Player';
import { Timeline } from './components/Timeline';
import type { AudioSelection, Dialogue, Generation, Project } from './domain/types';
import { selectedGeneration, reviewGeneration } from './domain/tts';
import { useGenerationAudio } from './hooks/useGenerationAudio';
import { useProject } from './hooks/useProject';
import { useShortcuts } from './hooks/useShortcuts';
import { useTransport } from './hooks/useTransport';
import * as bridge from './services/bridge';
import type { TimelineNavigation } from './domain/timeline';
import { useUpdater } from './hooks/useUpdater';
import { useMcpControl } from './hooks/useMcpControl';
import { ContextMenu, type ContextRequest, type OpenContextMenu } from './components/ContextMenu';

export default function App() {
  const { t, i18n } = useTranslation();
  const studio = useProject();
  const updater = useUpdater(studio.flush);
  const [panel, setPanel] = useState<Panel>(null);
  const [timelineNavigation, setTimelineNavigation] = useState<TimelineNavigation | null>(null);
  const [audioSelection, setAudioSelection] = useState<AudioSelection | null>(null);
  const selectAudio = useCallback((value: AudioSelection | null) => {
    setAudioSelection(value);
  }, []);
  const openAudioAdvanced = useCallback(() => setPanel('audio'), []);
  const [subtitleRole, setSubtitleRole] = useState<'source' | 'target'>('source');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [batchSelection, setBatchSelection] = useState<{ projectId: string | null; ids: string[] }>(
    { projectId: null, ids: [] },
  );
  const batchIds = useMemo(() => {
    const ids = new Set(studio.project?.dialogues.map((l) => l.id));
    return batchSelection.projectId === studio.project?.id
      ? batchSelection.ids.filter((id) => ids.has(id))
      : [];
  }, [batchSelection, studio.project]);
  const batchProjectId = studio.project?.id ?? null;
  const checkBatch = useCallback(
    (ids: string[]) => setBatchSelection({ projectId: batchProjectId, ids }),
    [batchProjectId],
  );
  const openBatch = useCallback(() => setPanel('batchDub'), []);
  const openLipBatch = useCallback(() => setPanel('inpaintBatch'), []);
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
  const contextScope = `${studio.project?.id}:${busy}:${panel}`;
  const [context, setContext] = useState<
    (ContextRequest & { scope: string; basis: Project | null }) | null
  >(null);
  const contextCurrent = useMemo(() => {
    if (!context) return false;
    if (context.basis === studio.project) return true;
    // Autosave only changes metadata. It must not close a menu just opened
    // after adjusting a level, while actual edits still invalidate its actions.
    const content = (p: Project | null) =>
      p && { ...p, revision: 0, updatedAt: '', appVersion: '' };
    return JSON.stringify(content(context.basis)) === JSON.stringify(content(studio.project));
  }, [context, studio.project]);
  const closeContext = useCallback(() => setContext(null), []);
  useEffect(() => {
    if (context && (context.scope !== contextScope || !contextCurrent)) setContext(null);
  }, [context, contextScope, contextCurrent]);
  const openContext: OpenContextMenu = useCallback(
    (event, label, actions) => {
      event.preventDefault();
      event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      const scrollOffsets: ContextRequest['scrollOffsets'] = [];
      for (
        let element: Element | null = event.target as Element;
        element;
        element = element.parentElement
      ) {
        scrollOffsets.push({ element, left: element.scrollLeft, top: element.scrollTop });
      }
      setContext({
        x: event.clientX || bounds.left + Math.min(20, bounds.width / 2),
        y: event.clientY || bounds.top + Math.min(20, bounds.height / 2),
        label,
        actions,
        opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        scrollOffsets,
        scope: contextScope,
        basis: studio.project,
      });
    },
    [contextScope, studio.project],
  );
  const transport = useTransport(studio.project, selected, padding, studio.setError);
  const { endOriginal } = transport;
  const { edit: editProject } = studio;
  const edit = useCallback(
    (update: (project: Project) => Project) => {
      endOriginal();
      editProject(update);
    },
    [endOriginal, editProject],
  );
  const generationAudio = useGenerationAudio(
    transport.videoRef,
    transport.url ?? undefined,
    transport.volume,
    studio.setError,
    studio.project?.voiceEdits,
  );
  const { stop: stopGeneration } = generationAudio;
  const { seek: seekVideo } = transport;
  const close = useCallback(() => setPanel(null), []);
  const closeSubtitles = useCallback(
    () => setPanel((current) => (current === 'subtitles' ? null : current)),
    [],
  );
  const showJobs = useCallback(() => setPanel('jobs'), []);
  const showCharacters = useCallback(() => setPanel('characters'), []);
  const showAlignment = useCallback(() => setPanel('alignment'), []);
  const select = useCallback(
    (line: Dialogue, positionMs?: number) => {
      stopGeneration();
      document.dispatchEvent(new Event('studio-voice-preview'));
      const timeMs = positionMs ?? Math.max(0, line.startMs - padding);
      setSelectedId(line.id);
      setAudioSelection(null);
      setTimelineNavigation({
        projectId: studio.project?.id ?? '',
        lineId: line.id,
        startMs: line.startMs,
        endMs: line.endMs,
        timeMs,
      });
      seekVideo(timeMs);
    },
    [padding, seekVideo, stopGeneration, studio.project?.id],
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
    generationAudio.stop();
    transport.playOriginalLine(selected);
  };
  const openDub = (line: Dialogue) => {
    select(line);
    setPanel('dub');
  };
  const playGeneration = (generation: Generation) => {
    if (generationAudio.active === generation.id) {
      generationAudio.stop();
      return;
    }
    const line = studio.project?.dialogues.find((d) => d.id === generation.dialogueId);
    if (line) select(line);
    generationAudio.play(generation);
  };
  const playDub = (line: Dialogue) => {
    const generation = studio.project && selectedGeneration(studio.project, line);
    if (generation) playGeneration(generation);
    else openDub(line);
  };
  const mcpActive = useMcpControl({
    updater,
    studio,
    transport,
    selectedId,
    batchIds,
    select,
    checkBatch,
    playGeneration,
    stopAudio: () => {
      stopGeneration();
      document.dispatchEvent(new Event('studio-voice-preview'));
    },
    panel,
    setPanel,
    theme,
    setTheme,
    padding,
    setPadding,
    language: i18n.resolvedLanguage ?? 'fr',
    changeLanguage: (language) => i18n.changeLanguage(language),
  });
  useShortcuts({
    toggle: transport.toggle,
    dub: () => {
      if (selected) playDub(selected);
    },
    regenerate: () => {
      if (selected) openDub(selected);
    },
    validate: () => {
      if (selected && !busy) studio.edit((p) => reviewGeneration(p, selected.id, true));
    },
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
    pause: transport.pause,
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
    <div
      className="app-shell"
      onContextMenu={(event) => {
        // Keep the platform's text editing menu (copy, paste, spelling, etc.).
        if (
          event.defaultPrevented ||
          (event.target as Element).closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
          )
        )
          return;
        openContext(event, t('contextApplication'), [
          {
            label: t('contextUndo'),
            shortcut: 'Ctrl+Z',
            disabled: !studio.project || busy,
            run: () => {
              void studio.run(() => bridge.history('undo'));
            },
          },
          {
            label: t('contextRedo'),
            shortcut: 'Ctrl+Y',
            disabled: !studio.project || busy,
            run: () => {
              void studio.run(() => bridge.history('redo'));
            },
          },
          {
            label: t('save'),
            shortcut: 'Ctrl+S',
            disabled: !studio.project || busy,
            run: () => {
              void studio.save();
            },
          },
          { label: t('settings'), run: () => setPanel('settings') },
        ]);
      }}
    >
      <MicrophoneIndicator
        onOpen={() => {
          const id = readMicrophone().lineId;
          const line = studio.project?.dialogues.find((l) => l.id === id);
          if (line) select(line);
          setPanel('dub');
        }}
      />
      <Header
        project={studio.project}
        saveState={studio.saveState}
        panel={panel}
        onPanel={setPanel}
        onOpen={() => {
          void studio.run(bridge.openProject);
        }}
        onPreview={() => {
          generationAudio.stop();
          if (selected) transport.playLine(selected);
          else transport.toggle();
        }}
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
            checkedIds={batchIds}
            onCheck={checkBatch}
            onBatch={openBatch}
            onLipBatch={openLipBatch}
            project={studio.project}
            selectedId={selectedId}
            onSelect={select}
            onPlay={transport.playOriginalLine}
            onImport={importSubtitles}
            onEdit={edit}
            onCharacters={showCharacters}
            onDub={openDub}
            onPlayDub={playDub}
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
              onEdit={edit}
            />
            <Editor
              project={studio.project}
              selected={selected}
              onEdit={edit}
              onPlay={transport.playOriginalLine}
              busy={busy}
              time={transport.time}
              translationFocus={translationFocus}
              jobs={studio.jobs}
              snapshot={studio.snapshot}
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
        <div className="timeline-container" style={{ height: timelineHeight, flexShrink: 0 }}>
          <Timeline
            onContextMenu={openContext}
            navigation={timelineNavigation}
            audioSelection={audioSelection}
            onAudioAdvanced={openAudioAdvanced}
            onAudioSelection={selectAudio}
            project={studio.project}
            selected={selected}
            timeRef={transport.timeRef}
            onSeek={transport.seek}
            onSelect={select}
            onEdit={edit}
            busy={busy}
          />
        </div>
      </main>
      <footer className="statusbar">
        {mcpActive && <span>{t('mcpActive')}</span>}
        {generationAudio.active && (
          <button onClick={generationAudio.stop}>{t('ttsStopListening')}</button>
        )}
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
          {running && <JobDuration job={running} />}
          <ChevronUp size={12} />
        </button>
      </footer>
      <Panels
        batchIds={batchIds}
        activeGenerationId={generationAudio.active}
        onPlayGeneration={playGeneration}
        onOriginal={(line) => {
          generationAudio.stop();
          transport.playOriginalLine(line);
        }}
        audioSelection={audioSelection}
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
        onEdit={edit}
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
      {context?.scope === contextScope && contextCurrent && (
        <ContextMenu request={context} onClose={closeContext} />
      )}
    </div>
  );
}
