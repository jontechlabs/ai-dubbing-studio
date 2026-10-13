import { useCallback, useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { native } from '../services/bridge';
export function useUpdater(flush: () => Promise<void>) {
  const [state, setState] = useState('idle');
  const [available, setAvailable] = useState<{ version: string; body?: string } | null>(null);
  const [error, setError] = useState<string | null>(null),
    [progress, setProgress] = useState<number | null>(null);
  const [automatic, setAutomatic] = useState(
    localStorage.getItem('studio.updateCheck') !== 'false',
  );
  const resource = useRef<Update | null>(null),
    running = useRef(false),
    mounted = useRef(true);
  const checkNow = useCallback(async () => {
    if (!native || running.current) return;
    running.current = true;
    setState('checking');
    setError(null);
    try {
      await resource.current?.close();
      resource.current = null;
      const update = await check({ timeout: 15000 });
      if (!mounted.current) {
        await update?.close();
        return;
      }
      resource.current = update;
      setAvailable(update ? { version: update.version, body: update.body } : null);
      setState(update ? 'available' : 'current');
    } catch (cause) {
      if (mounted.current) {
        setError(String(cause));
        setState('error');
      }
    } finally {
      running.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!running.current) void resource.current?.close();
    };
  }, []);
  useEffect(() => {
    const timer = native && automatic ? setTimeout(() => void checkNow(), 5000) : undefined;
    return () => clearTimeout(timer);
  }, [automatic, checkNow]);
  const download = async () => {
    if (!resource.current || running.current) return;
    running.current = true;
    setState('downloading');
    setError(null);
    setProgress(null);
    let received = 0,
      total = 0;
    try {
      await resource.current.download(
        (event) => {
          if (event.event === 'Started') total = event.data.contentLength ?? 0;
          else if (event.event === 'Progress') {
            received += event.data.chunkLength;
            if (mounted.current) setProgress(total ? received / total : null);
          }
        },
        { timeout: 300000 },
      );
      if (mounted.current) {
        setState('downloaded');
        setProgress(1);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(String(cause));
        setState('error');
      }
    } finally {
      running.current = false;
    }
  };
  const install = async () => {
    if (!resource.current || state !== 'downloaded' || running.current) return;
    running.current = true;
    setError(null);
    try {
      await flush();
      setState('installing');
      await resource.current.install({ restartAfterInstall: true });
    } catch (cause) {
      if (mounted.current) {
        setError(String(cause));
        setState('downloaded');
      }
    } finally {
      running.current = false;
    }
  };
  return {
    state,
    available,
    error,
    progress,
    automatic,
    checkNow,
    download,
    install,
    setAutomatic: (enabled: boolean) => {
      localStorage.setItem('studio.updateCheck', String(enabled));
      setAutomatic(enabled);
    },
  };
}
export type Updater = ReturnType<typeof useUpdater>;
