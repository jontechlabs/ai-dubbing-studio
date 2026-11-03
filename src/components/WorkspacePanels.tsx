import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const key = 'studio.workspaceWidths';
const defaults = { left: 330, right: 340 };
const dubbingKey = 'studio.dubbingInspectorWidth';
const dubbingDefault = 430;
const minimum = { left: 240, right: 280 };
const maximum = { left: 640, right: 560 };
type Side = 'left' | 'right';
function initialWidths() {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Object.fromEntries(
      (['left', 'right'] as const).map((side) => [
        side,
        typeof value?.[side] === 'number' && Number.isFinite(value[side])
          ? Math.max(minimum[side], Math.min(maximum[side], value[side]))
          : defaults[side],
      ]),
    ) as typeof defaults;
  } catch {
    return defaults;
  }
}

export function WorkspacePanels({
  children,
  dubbing = false,
}: {
  children: [ReactNode, ReactNode, ReactNode];
  dubbing?: boolean;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const [desired, setDesired] = useState(initialWidths);
  const [dubbingWidth, setDubbingWidth] = useState(() => {
    try {
      const value = Number(localStorage.getItem(dubbingKey));
      return Number.isFinite(value) && value >= minimum.right
        ? Math.min(maximum.right, value)
        : dubbingDefault;
    } catch {
      return dubbingDefault;
    }
  });
  const [width, setWidth] = useState(Math.max(930, window.innerWidth - 30));
  useLayoutEffect(() => {
    const element = root.current!;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(desired));
    } catch {
      // Layout remains usable when browser storage is unavailable.
    }
  }, [desired]);
  useEffect(() => {
    try {
      localStorage.setItem(dubbingKey, String(dubbingWidth));
    } catch {
      /* Optional preference. */
    }
  }, [dubbingWidth]);
  // Keep at least 320 px for the video. Saved widths are preferences: they must
  // never push the inspector outside the window after a monitor/size change.
  const budget = Math.max(0, width - 16 - 320 - minimum.left - minimum.right);
  const right = dubbing ? dubbingWidth : desired.right;
  const extra = desired.left - minimum.left + right - minimum.right;
  const scale = extra ? Math.min(1, budget / extra) : 1;
  const sizes = {
    left: Math.floor(minimum.left + (desired.left - minimum.left) * scale),
    right: Math.floor(minimum.right + (right - minimum.right) * scale),
  };
  const limit = (side: Side) =>
    Math.max(
      minimum[side],
      Math.min(maximum[side], width - 16 - 320 - sizes[side === 'left' ? 'right' : 'left']),
    );
  const resize = (side: Side, value: number) => {
    const size = Math.round(Math.max(minimum[side], Math.min(limit(side), value)));
    if (side === 'right' && dubbing) setDubbingWidth(size);
    else setDesired((current) => ({ ...current, [side]: size }));
  };
  const separator = (side: Side) => (
    <div
      className="resize-handle vertical"
      role="separator"
      aria-label={t(side === 'left' ? 'resizePanels' : 'resizeInspector')}
      aria-orientation="vertical"
      aria-valuemin={minimum[side]}
      aria-valuemax={Math.floor(limit(side))}
      aria-valuenow={sizes[side]}
      aria-valuetext={`${sizes[side]} px`}
      title={t('resizeWorkspaceHint')}
      tabIndex={0}
      onDoubleClick={() => {
        if (side === 'right' && dubbing) setDubbingWidth(dubbingDefault);
        else setDesired((current) => ({ ...current, [side]: defaults[side] }));
      }}
      onKeyDown={(event) => {
        const amount = event.shiftKey ? 40 : 10;
        if (event.key === 'Home') resize(side, minimum[side]);
        else if (event.key === 'End') resize(side, limit(side));
        else if (event.key === 'ArrowLeft')
          resize(side, sizes[side] + (side === 'left' ? -amount : amount));
        else if (event.key === 'ArrowRight')
          resize(side, sizes[side] + (side === 'left' ? amount : -amount));
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds = root.current!.getBoundingClientRect();
        resize(side, side === 'left' ? event.clientX - bounds.left : bounds.right - event.clientX);
      }}
    />
  );
  return (
    <div
      ref={root}
      className="upper-workspace"
      style={{ gridTemplateColumns: `${sizes.left}px 8px minmax(0, 1fr) 8px ${sizes.right}px` }}
    >
      {children[0]}
      {separator('left')}
      {children[1]}
      {separator('right')}
      <aside className="inspector-workspace" aria-label={t('subtitleInspector')}>
        {children[2]}
      </aside>
    </div>
  );
}
