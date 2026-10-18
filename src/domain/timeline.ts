export interface TimelineNavigation {
  projectId: string;
  lineId: string;
  startMs: number;
  endMs: number;
  timeMs: number;
}
export function navigationLeft(
  duration: number,
  viewport: number,
  zoom: number,
  request: TimelineNavigation,
) {
  const scale = (viewport * zoom) / duration;
  const start = Math.min(request.startMs, request.timeMs),
    end = Math.max(request.endMs, request.timeMs);
  const left =
    (end - start) * scale <= viewport * 0.7
      ? ((start + end) / 2) * scale - viewport / 2
      : request.timeMs * scale - viewport * 0.2;
  return Math.max(0, Math.min(viewport * zoom - viewport, left));
}
