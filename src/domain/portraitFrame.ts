export interface PortraitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PortraitPreviewOptions {
  characterId: string;
  lineId: string;
  atMs?: number;
  profile: 'auto' | 'anime' | 'live';
}
export interface PortraitPreview {
  projectId: string;
  revision: number;
  sourcePath: string;
  characterId: string;
  lineId: string;
  atMs: number;
  imagePath: string;
  width: number;
  height: number;
  faces: PortraitRect[];
}
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
export function portraitRectValid(r: PortraitRect | null | undefined): r is PortraitRect {
  return (
    !!r &&
    Object.values(r).every(Number.isFinite) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.width > 0 &&
    r.height > 0 &&
    r.x + r.width <= 1.000001 &&
    r.y + r.height <= 1.000001
  );
}
export function portraitDraw(
  a: { x: number; y: number },
  b: { x: number; y: number },
): PortraitRect {
  const x = clamp(Math.min(a.x, b.x), 0, 0.99),
    y = clamp(Math.min(a.y, b.y), 0, 0.99);
  return {
    x,
    y,
    width: clamp(Math.abs(a.x - b.x), 0.01, 1 - x),
    height: clamp(Math.abs(a.y - b.y), 0.01, 1 - y),
  };
}
export function portraitMove(r: PortraitRect, x: number, y: number): PortraitRect {
  return { ...r, x: clamp(r.x + x, 0, 1 - r.width), y: clamp(r.y + y, 0, 1 - r.height) };
}
export function portraitResize(
  r: PortraitRect,
  corner: string,
  p: { x: number; y: number },
): PortraitRect {
  const left = corner.includes('w') ? clamp(p.x, 0, r.x + r.width - 0.01) : r.x;
  const top = corner.includes('n') ? clamp(p.y, 0, r.y + r.height - 0.01) : r.y;
  const right = corner.includes('e') ? clamp(p.x, r.x + 0.01, 1) : r.x + r.width;
  const bottom = corner.includes('s') ? clamp(p.y, r.y + 0.01, 1) : r.y + r.height;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
