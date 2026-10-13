export function formatTime(ms: number, separator = '.'): string {
  const value = Math.max(0, Math.round(ms));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}
export function parseTime(text: string): number {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(text.trim());
  if (!match) throw new Error('INVALID_TIMECODE');
  return (
    Number(match[1]) * 3_600_000 +
    Number(match[2]) * 60_000 +
    Number(match[3]) * 1000 +
    Number(match[4])
  );
}
export function timeToX(time: number, start: number, scale: number): number {
  return (time - start) * scale;
}
export function xToTime(x: number, start: number, scale: number, duration: number): number {
  return Math.round(Math.max(0, Math.min(duration, start + x / scale)));
}
export function loopRange(start: number, end: number, duration: number, padding: number) {
  return { start: Math.max(0, start - padding), end: Math.min(duration, end + padding) };
}
