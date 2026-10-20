import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job, Project } from '../domain/types';
import * as bridge from '../services/bridge';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { rebaseProject } from '../domain/rebase';
import { cleanTranslationApprovals } from '../domain/translation';

export function useProject() {
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [saveState, setSaveState] = useState('saved');
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const latest = useRef<Project | null>(null);
  const base = useRef<Project | null>(null);
  const revision = useRef(0);
  const version = useRef(0);
  const savedVersion = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback((value: Project) => {
    value = cleanTranslationApprovals(value);
    if (latest.current?.id === value.id && latest.current.revision > value.revision) return;
    if (
      latest.current?.id === value.id &&
      base.current &&
      savedVersion.current !== version.current
    ) {
      latest.current = rebaseProject(base.current, latest.current, value);
      base.current = value;
      revision.current = value.revision;
      setProject(latest.current);
      setSaveState('unsaved');
      return;
    }
    latest.current = value;
    base.current = value;
    revision.current = value.revision;
    version.current = 0;
    savedVersion.current = 0;
    setProject(value);
    setSaveState('saved');
  }, []);
  const save = useCallback(async () => {
    clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current;
    if (!latest.current || savedVersion.current === version.current) return;
    const snapshot = latest.current;
    const captured = version.current;
    setSaveState('saving');
    const operation = (async () => {
      try {
        const result = await bridge.replaceProject(snapshot, revision.current);
        const newer = result.revision >= revision.current;
        revision.current = Math.max(revision.current, result.revision);
        if (newer) base.current = result;
        savedVersion.current = captured;
        if (version.current === captured && newer) {
          latest.current = result;
          setProject(result);
        } else if (latest.current) {
          latest.current = { ...latest.current, revision: revision.current };
          setProject(latest.current);
        }
        setSaveState(version.current === captured ? 'saved' : 'unsaved');
      } catch (e) {
        setError(String(e));
        setSaveState('saveError');
      }
    })();
    inFlight.current = operation;
    await operation;
    inFlight.current = null;
  }, []);
  const edit = useCallback(
    (update: (value: Project) => Project) => {
      if (!latest.current) return;
      try {
        latest.current = cleanTranslationApprovals(update(latest.current));
      } catch (error) {
        setError(String(error));
        return;
      }
      version.current += 1;
      setProject(latest.current);
      setSaveState('unsaved');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void save();
      }, 500);
    },
    [save],
  );
  const run = useCallback(
    async (operation: () => Promise<Project | null>) => {
      try {
        await save();
        if (savedVersion.current !== version.current) return;
        const result = await operation();
        if (result) load(result);
      } catch (e) {
        setError(String(e));
      }
    },
    [load, save],
  );
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void bridge
      .restoreProject()
      .then((p) => {
        if (p && !disposed) load(p);
      })
      .catch((e) => setError(String(e)));
    void bridge.jobs().then((items) => {
      if (!disposed) setJobs(items);
    });
    void bridge
      .subscribe(load, (job) => {
        setJobs((current) => [job, ...current.filter((j) => j.id !== job.id)].slice(0, 100));
        if (job.status === 'failed' && job.error) setError(job.error);
      })
      .then((fn) => {
        if (disposed) fn();
        else unsubscribe = fn;
      });
    const periodic = setInterval(() => {
      void save();
    }, 10000);
    return () => {
      disposed = true;
      unsubscribe?.();
      clearInterval(periodic);
      clearTimeout(timer.current);
    };
  }, [load, save]);
  useEffect(() => {
    if (!bridge.native) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const window = getCurrentWindow();
    void window
      .onCloseRequested(async (event) => {
        event.preventDefault();
        await save();
        if (savedVersion.current === version.current) await window.destroy();
      })
      .then((fn) => {
        if (disposed) fn();
        else unsubscribe = fn;
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [save]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (savedVersion.current !== version.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);
  const snapshot = useCallback(async () => {
    await save();
    if (!latest.current || savedVersion.current !== version.current) throw new Error('SAVE_FAILED');
    return structuredClone(latest.current);
  }, [save]);
  const flush = useCallback(async () => {
    await save();
    if (savedVersion.current !== version.current) throw new Error('SAVE_FAILED');
  }, [save]);
  const currentSnapshot = useCallback(async () => {
    await flush();
    return latest.current ? structuredClone(latest.current) : null;
  }, [flush]);
  const applySnapshot = useCallback(
    async (before: Project, after: Project) => {
      setApplying(true);
      try {
        await save();
        if (
          !latest.current ||
          latest.current.id !== before.id ||
          revision.current !== before.revision ||
          savedVersion.current !== version.current
        )
          throw new Error('STALE_REVISION');
        const result = await bridge.replaceProject(after, before.revision);
        load(result);
      } finally {
        setApplying(false);
      }
    },
    [load, save],
  );
  return {
    project,
    jobs,
    saveState,
    error,
    setError,
    load,
    edit,
    run,
    save,
    snapshot,
    applySnapshot,
    applying,
    flush,
    currentSnapshot,
  };
}
