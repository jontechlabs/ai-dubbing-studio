import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { useProject } from './useProject';
import type { Transport } from './useTransport';
import type { Dialogue, Generation } from '../domain/types';
import type { Panel } from '../components/Header';
import { native, dubbingUrl } from '../services/bridge';
import { checkContext, editProject, type Context } from '../mcp/actions';
import catalog from '../mcp/catalog.json';
import { dialogueText } from '../domain/subtitles';
import { translationState } from '../domain/translation';
import { validateProject } from '../domain/project';
import { dubbingClips } from '../domain/mix';
import { APP_VERSION } from '../domain/project';
import {
  readMicrophone,
  startMicrophone,
  stopMicrophone,
  discardMicrophone,
  saveMicrophone,
} from '../services/microphone';
import { storeMicrophoneTake } from '../services/bridge';
import { readVoicePlayback } from '../services/voicePlayback';
import type { Updater } from './useUpdater';

interface Control {
  updater: Updater;
  studio: ReturnType<typeof useProject>;
  transport: Transport;
  selectedId: string | null;
  batchIds: string[];
  select: (line: Dialogue) => void;
  checkBatch: (ids: string[]) => void;
  playGeneration: (generation: Generation) => void;
  stopAudio: () => void;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  theme: string;
  setTheme: (theme: string) => void;
  padding: number;
  setPadding: (padding: number) => void;
  language: string;
  changeLanguage: (language: string) => Promise<unknown>;
}
export function useMcpControl(control: Control) {
  const [active, setActive] = useState(false);
  const current = useRef(control);
  useEffect(() => {
    current.current = control;
  });
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let release: (() => void) | undefined;
    let queue = Promise.resolve();
    async function handle(id: string) {
      if (disposed) return;
      const request = await invoke<{ tool: string; arguments: Record<string, unknown> } | null>(
        'mcp_claim',
        { id },
      );
      if (!request) return;
      setActive(true);
      try {
        const c = current.current,
          { studio, transport } = c;
        const { tool, arguments: args } = request;
        await studio.flush();
        const project = await studio.currentSnapshot();
        const live = async () => {
          if (disposed || !(await invoke<boolean>('mcp_live', { id })))
            throw Error('MCP_CANCELLED');
        };
        await live();
        let result: unknown;
        const command = catalog.commands.find((entry) => entry.name === tool);
        if (command) {
          if (args.context) checkContext(project, args.context as Context);
          const parameters = { ...args };
          delete parameters.context;
          result = await invoke(command.command, parameters);
          if (result && typeof result === 'object' && 'formatVersion' in result)
            studio.load(validateProject(result));
        } else if (tool === 'studio_microphone') {
          checkContext(project, args.context as Context);
          const action = args.action;
          if (action === 'start' || action === 'save') {
            if (!project) throw Error('NO_PROJECT');
            const line = project.dialogues.find(
              (l) => l.id === (args.lineId ?? readMicrophone().lineId ?? c.selectedId),
            );
            if (!line) throw Error('NO_DIALOGUES');
            c.select(line);
            c.setPanel('dub');
            if (action === 'start') {
              c.stopAudio();
              transport.videoRef.current?.pause();
              void startMicrophone(project, line, String(args.deviceId ?? '')).catch((error) =>
                studio.setError(String(error)),
              );
            } else
              studio.load(
                await saveMicrophone(project, line, (bytes) =>
                  storeMicrophoneTake(project.id, project.revision, line.id, bytes),
                ),
              );
          } else if (action === 'stop') await stopMicrophone();
          else if (action === 'discard') discardMicrophone();
          else if (action !== 'status') throw Error('MCP_INVALID_ARGUMENTS');
          const { url: _url, ...status } = readMicrophone();
          void _url;
          result = status;
        } else if (tool === 'studio_get_project') result = project;
        else if (tool === 'studio_save')
          result = {
            saved: true,
            context: project && { projectId: project.id, expectedRevision: project.revision },
          };
        else if (tool === 'studio_get_state')
          result = {
            version: APP_VERSION,
            microphone: { ...readMicrophone(), url: undefined },
            context: project && { projectId: project.id, expectedRevision: project.revision },
            name: project?.name ?? null,
            media: project?.media ?? null,
            selectedId: c.selectedId,
            checkedIds: c.batchIds,
            counts: project && {
              dialogues: project.dialogues.length,
              generations: project.generations.length,
              characters: project.characters.length,
            },
            playback: {
              ready: transport.ready,
              playing: !!transport.videoRef.current && !transport.videoRef.current.paused,
              timeMs: transport.videoRef.current
                ? Math.round(transport.videoRef.current.currentTime * 1000)
                : 0,
              volume: transport.volume,
              loop: transport.loop,
              rate: transport.videoRef.current?.playbackRate ?? 1,
              audition: readVoicePlayback().playback,
            },
            preferences: {
              language: c.language,
              theme: c.theme,
              paddingMs: c.padding,
              panel: c.panel,
              zoom:
                Number.parseFloat(document.querySelector('.zoom-value')?.textContent ?? '100') /
                100,
            },
            jobs: await invoke('list_jobs'),
            updater: {
              state: c.updater.state,
              available: c.updater.available,
              error: c.updater.error,
              progress: c.updater.progress,
              automatic: c.updater.automatic,
            },
          };
        else if (tool === 'studio_get_dialogues') {
          if (!project) throw Error('NO_PROJECT');
          const ids = new Set((args.ids as string[] | undefined) ?? []);
          const rows = project.dialogues
            .map((line, index) => ({
              ...line,
              index,
              original: dialogueText(project, line, 'source'),
              translated: dialogueText(project, line, 'target'),
              translationStatus: translationState(project, line),
            }))
            .filter(
              (line) =>
                (!ids.size || ids.has(line.id)) &&
                (!args.status || args.status === 'all' || line.translationStatus === args.status),
            );
          const offset = (args.offset as number) ?? 0,
            limit = (args.limit as number) ?? 50;
          result = {
            context: { projectId: project.id, expectedRevision: project.revision },
            total: rows.length,
            offset,
            rows: rows.slice(offset, offset + limit),
          };
        } else if (tool === 'studio_select_dialogue' || tool === 'studio_set_selection') {
          if (!project) throw Error('NO_PROJECT');
          if (tool === 'studio_select_dialogue') {
            const line = project.dialogues.find((line) => line.id === args.lineId);
            if (!line) throw Error('MCP_UNKNOWN_DIALOGUE');
            c.select(line);
          } else {
            const ids = args.ids as string[];
            if (ids.some((id) => !project.dialogues.some((line) => line.id === id)))
              throw Error('MCP_UNKNOWN_DIALOGUE');
            c.checkBatch([...new Set(ids)]);
          }
          result = { applied: true };
        } else if (tool === 'studio_playback') {
          const action = args.action;
          if (['line', 'original', 'dub'].includes(String(action))) {
            const line = project?.dialogues.find(
              (line) => line.id === (args.lineId ?? c.selectedId),
            );
            if (!line || !project) throw Error('MCP_UNKNOWN_DIALOGUE');
            c.select(line);
            if (action === 'line') transport.playLine(line);
            else if (action === 'original') transport.playOriginalLine(line);
            else {
              const take = project.generations.find(
                (take) =>
                  take.id === line.selectedGenerationIds[project.languages.target] &&
                  take.kind === 'tts',
              );
              if (!take) throw Error('TTS_AUDIO_MISSING');
              c.playGeneration(take as Generation);
            }
          } else if (action === 'seek') {
            if (
              !Number.isSafeInteger(args.timeMs) ||
              (args.timeMs as number) > (project?.media?.durationMs ?? 0)
            )
              throw Error('MCP_INVALID_ARGUMENTS');
            c.stopAudio();
            transport.seek(args.timeMs as number);
          } else if (action === 'play') {
            if (!transport.ready) throw Error('MEDIA_LOADING');
            c.stopAudio();
            if (transport.videoRef.current?.paused) transport.toggle();
          } else if (action === 'pause' || action === 'stop') {
            c.stopAudio();
            transport.pause();
          } else if (action === 'volume') {
            if (typeof args.value !== 'number' || args.value < 0 || args.value > 1)
              throw Error('MCP_INVALID_ARGUMENTS');
            transport.setVolume(args.value);
          } else if (action === 'rate') {
            if (
              typeof args.value !== 'number' ||
              args.value < 0.25 ||
              args.value > 4 ||
              !transport.videoRef.current
            )
              throw Error('MCP_INVALID_ARGUMENTS');
            transport.videoRef.current.playbackRate = args.value;
          } else if (action === 'loop') {
            if (typeof args.enabled !== 'boolean') throw Error('MCP_INVALID_ARGUMENTS');
            transport.setLoop(args.enabled);
          } else throw Error('MCP_INVALID_ARGUMENTS');
          result = { applied: true };
        } else if (tool === 'studio_updates') {
          if (args.action === 'check') await c.updater.checkNow();
          else if (args.action === 'automatic') {
            if (typeof args.enabled !== 'boolean') throw Error('MCP_INVALID_ARGUMENTS');
            c.updater.setAutomatic(args.enabled);
          } else if (args.action === 'download' || args.action === 'install') {
            const update = current.current.updater;
            if (args.action === 'download' && update.state !== 'available')
              throw Error('MCP_UPDATE_NOT_AVAILABLE');
            if (args.action === 'install' && update.state !== 'downloaded')
              throw Error('MCP_UPDATE_NOT_DOWNLOADED');
            if (
              args.action === 'install' &&
              (await invoke<{ status: string }[]>('list_jobs')).some((job) =>
                ['queued', 'running', 'paused'].includes(job.status),
              )
            )
              throw Error('BUSY');
            setTimeout(() => {
              void (args.action === 'download' ? update.download() : update.install());
            }, 200);
          } else if (args.action !== 'status') throw Error('MCP_INVALID_ARGUMENTS');
          result = { accepted: true, state: current.current.updater.state };
        } else if (tool === 'studio_preferences') {
          if (args.language) {
            localStorage.setItem('studio.language', String(args.language));
            await c.changeLanguage(String(args.language));
          }
          if (args.theme) c.setTheme(String(args.theme));
          if (typeof args.paddingMs === 'number') c.setPadding(args.paddingMs);
          if (Object.hasOwn(args, 'panel')) c.setPanel(args.panel as Panel);
          if (args.zoom !== undefined)
            document.dispatchEvent(new CustomEvent('studio-timeline-zoom', { detail: args.zoom }));
          result = { applied: true };
        } else {
          const before = checkContext(project, args.context as Context);
          const next = editProject(before, tool, args);
          // The same private render preflight as the visible voice editor.
          const old = new Map(dubbingClips(before).map((clip) => [clip.generation.id, clip]));
          for (const clip of dubbingClips(next)) {
            const previous = old.get(clip.generation.id);
            if (
              JSON.stringify(before.voiceEdits?.[clip.generation.id]) !==
                JSON.stringify(next.voiceEdits?.[clip.generation.id]) ||
              previous?.slotMs !== clip.slotMs ||
              previous?.exactDuration !== clip.exactDuration
            )
              await dubbingUrl(
                clip.generation.id,
                clip.slotMs,
                clip.exactDuration,
                next.voiceEdits?.[clip.generation.id],
              );
          }
          await live();
          c.stopAudio();
          transport.pause();
          await studio.applySnapshot(before, next);
          const saved = await studio.currentSnapshot();
          result = {
            context: saved && { projectId: saved.id, expectedRevision: saved.revision },
            applied: true,
          };
        }
        await invoke('mcp_complete', { id, result: result ?? null, error: null });
      } catch (error) {
        await invoke('mcp_complete', { id, result: null, error: String(error) });
      } finally {
        if (!disposed) setActive(false);
      }
    }
    void listen<string>('mcp-request', (event) => {
      queue = queue.then(() => handle(event.payload)).catch(() => {});
    }).then((unlisten) => {
      if (disposed) unlisten();
      else {
        release = unlisten;
        void invoke('mcp_ready', { ready: true });
      }
    });
    return () => {
      disposed = true;
      release?.();
      void invoke('mcp_ready', { ready: false });
    };
  }, []);
  return active;
}
