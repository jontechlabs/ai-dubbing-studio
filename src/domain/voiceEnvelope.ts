export interface VoicePoint {
  atMs: number;
  level: number;
}
export function validEnvelope(points: VoicePoint[] | undefined, duration: number) {
  return (
    points === undefined ||
    (Array.isArray(points) &&
      points.length >= 2 &&
      points.length <= 16 &&
      points[0]?.atMs === 0 &&
      points.at(-1)?.atMs === duration &&
      points.every(
        (p, i) =>
          p &&
          Number.isFinite(p.atMs) &&
          p.atMs >= 0 &&
          p.atMs <= duration &&
          Number.isFinite(p.level) &&
          p.level >= 0 &&
          p.level <= 1 &&
          (!i || p.atMs > points[i - 1].atMs),
      ))
  );
}
export function envelopeLevel(points: VoicePoint[] | undefined, at: number): number {
  if (!points?.length) return 1;
  if (at <= 0) return points[0].level;
  for (let i = 1; i < points.length; i++)
    if (at <= points[i].atMs) {
      const a = points[i - 1],
        b = points[i];
      return a.level + ((b.level - a.level) * (at - a.atMs)) / (b.atMs - a.atMs);
    }
  return points.at(-1)!.level;
}
export function sliceEnvelope(points: VoicePoint[] | undefined, start: number, end: number) {
  return (
    points && [
      { atMs: 0, level: envelopeLevel(points, start) },
      ...points
        .filter((p) => p.atMs > start && p.atMs < end)
        .map((p) => ({ ...p, atMs: p.atMs - start })),
      { atMs: end - start, level: envelopeLevel(points, end) },
    ]
  );
}
export function scaleEnvelope(points: VoicePoint[] | undefined, from: number, to: number) {
  return points?.map((p) => ({ ...p, atMs: p.atMs === from ? to : (p.atMs / from) * to }));
}
export function fadeEnvelope(
  offset: number,
  duration: number,
  total: number,
  fadeIn: number,
  fadeOut: number,
): VoicePoint[] {
  const positions = [
    0,
    duration,
    ...[fadeIn, total - fadeOut].map((t) => t - offset).filter((t) => t > 0 && t < duration),
  ];
  return [...new Set(positions)]
    .sort((a, b) => a - b)
    .map((atMs) => {
      const t = atMs + offset;
      const level = Math.min(
        fadeIn > 0 ? Math.min(1, t / fadeIn) : 1,
        fadeOut > 0 ? Math.min(1, (total - t) / fadeOut) : 1,
      );
      return { atMs, level: Math.max(0, level) };
    });
}
