import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { WorkflowQueue } from '../domain/taskQueue';
import * as bridge from '../services/bridge';
export function useTaskQueue() {
  const [data, setData] = useState<WorkflowQueue | null>(null),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!bridge.native) return;
    try {
      const q = await bridge.taskQueueStatus();
      setData((old) => (!old || q.revision >= old.revision ? q : old));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    if (!bridge.native) return;
    let disposed = false,
      off: (() => void) | undefined;
    void bridge
      .taskQueueStatus()
      .then((q) => {
        if (!disposed) setData((old) => (!old || q.revision >= old.revision ? q : old));
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    void listen<WorkflowQueue>('task-queue-changed', (event) => {
      if (!disposed) {
        const q = event.payload;
        setData((old) => (!old || q.revision >= old.revision ? q : old));
        setError('');
      }
    }).then((fn) => {
      if (disposed) fn();
      else off = fn;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  return { data, error, refresh };
}
