import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { navigationLeft, type TimelineNavigation } from '../domain/timeline';

export function useTimelineZoom(
  scroll: RefObject<HTMLDivElement | null>,
  duration: number,
  viewport: number,
  timeRef: RefObject<number>,
  projectId: string | undefined,
) {
  const [zoom, setZoom] = useState(1);
  const current = useRef(1);
  const committed = useRef(1);
  const pending = useRef<{ time: number; pixel: number } | null>(null);
  // Keep the browser canvas bounded while allowing sub-second detail on long films.
  const maxZoom = Math.max(1, Math.min(duration / 500, 8_000_000 / viewport));
  const change = useCallback(
    (value: number, pixel?: number, time?: number) => {
      const element = scroll.current;
      if (!element) return;
      const oldScale = (viewport * current.current) / duration;
      const left = pending.current
        ? pending.current.time * oldScale - pending.current.pixel
        : element.scrollLeft;
      const playhead = timeRef.current * oldScale - left;
      const anchor = pixel ?? (playhead >= 0 && playhead <= viewport ? playhead : viewport / 2);
      pending.current = { time: time ?? (left + anchor) / oldScale, pixel: anchor };
      const next = Math.max(1, Math.min(maxZoom, value));
      current.current = next;
      if (next === committed.current) {
        element.scrollLeft = Math.max(
          0,
          (pending.current.time * viewport * next) / duration - anchor,
        );
        pending.current = null;
      }
      // A shortcut may arrive before passive effects from the last zoom render.
      // Always enqueue it, even when its closure still sees an older zoom value.
      setZoom(next);
    },
    [duration, maxZoom, scroll, timeRef, viewport],
  );
  useLayoutEffect(() => {
    committed.current = zoom;
    if (scroll.current && pending.current) {
      scroll.current.scrollLeft = Math.max(
        0,
        (pending.current.time * viewport * zoom) / duration - pending.current.pixel,
      );
      pending.current = null;
    }
  }, [duration, scroll, viewport, zoom]);
  useEffect(() => {
    current.current = 1;
    pending.current = null;
    setZoom(1);
    if (scroll.current) scroll.current.scrollLeft = 0;
  }, [projectId, scroll]);
  const reveal = useCallback(
    (request: TimelineNavigation) => {
      const scale = (viewport * current.current) / duration;
      change(
        current.current,
        0,
        navigationLeft(duration, viewport, current.current, request) / scale,
      );
    },
    [change, duration, viewport],
  );
  const fit = useCallback(() => change(1, 0, 0), [change]);
  useEffect(() => {
    if (zoom > maxZoom) change(maxZoom);
  }, [change, maxZoom, zoom]);
  const focus = (start: number, end: number) =>
    change(duration / Math.max(500, (end - start) * 1.6), viewport / 2, (start + end) / 2);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !projectId) return;
      event.preventDefault();
      if (event.deltaY === 0) return;
      const pixel = Math.max(
        0,
        Math.min(viewport, event.clientX - element.getBoundingClientRect().left),
      );
      change(
        current.current * Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * 0.005),
        pixel,
      );
    };
    const key = (event: KeyboardEvent) => {
      if (
        !projectId ||
        event.defaultPrevented ||
        event.altKey ||
        document.querySelector('[role="dialog"]') ||
        (event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')
      )
        return;
      if (
        (event.ctrlKey || event.metaKey) &&
        ['+', '=', '-', 'Add', 'Subtract'].includes(event.key)
      ) {
        event.preventDefault();
        change(current.current * (['-', 'Subtract'].includes(event.key) ? 1 / 1.5 : 1.5));
      } else if (
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key.toLowerCase() === 'z'
      ) {
        event.preventDefault();
        fit();
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', key);
    return () => {
      element.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', key);
    };
  }, [change, fit, projectId, scroll, viewport]);
  return { zoom, maxZoom, change, fit, focus, reveal };
}
