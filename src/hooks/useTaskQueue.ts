import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { WorkflowQueue } from '../domain/taskQueue';
import * as bridge from '../services/bridge';
function latestQueue(old: WorkflowQueue | null, q: WorkflowQueue) {
  if (old && q.revision < old.revision) return old;
  // Forecasts change after completed work, not every clock tick. Keep the
  // editor/timeline out of unchanged polling and notification renders.
  return old && JSON.stringify(old) === JSON.stringify(q) ? old : q;
}
export function useTaskQueue() {
  const [data, setData] = useState<WorkflowQueue | null>(null),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!bridge.native) return;
    try {
      const q = await bridge.taskQueueStatus();
      setData((old) => latestQueue(old, q));
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
        if (!disposed) setData((old) => latestQueue(old, q));
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    void listen<WorkflowQueue>('task-queue-changed', (event) => {
      if (!disposed) {
        const q = event.payload;
        setData((old) => latestQueue(old, q));
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
  const pending = !!data?.entries.some((e) => ['pending', 'running'].includes(e.status));
  useEffect(() => {
    if (!bridge.native || !pending) return;
    let disposed = false,
      inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void bridge
        .taskQueueStatus()
        .then((q) => {
          if (!disposed) setData((old) => latestQueue(old, q));
        })
        .catch(() => {
          /* The next poll or explicit refresh can recover. */
        })
        .finally(() => {
          inFlight = false;
        });
    }, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pending]);
  return { data, error, refresh };
}
