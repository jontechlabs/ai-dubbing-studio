import { useEffect } from 'react';

export function useShortcuts(actions: {
  toggle: () => void;
  original: () => void;
  save: () => void;
  undo: () => void;
  redo: () => void;
  backward: () => void;
  pause: () => void;
  forward: () => void;
  dub?: () => void;
  regenerate?: () => void;
  validate?: () => void;
}) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))
        return;
      const key = event.key.toLowerCase();
      const modifier = event.ctrlKey || event.metaKey;
      const action = modifier
        ? (
            {
              s: actions.save,
              z: event.shiftKey ? actions.redo : actions.undo,
              y: actions.redo,
            } as Record<string, () => void>
          )[key]
        : (
            {
              ' ': actions.toggle,
              o: actions.original,
              j: actions.backward,
              k: actions.pause,
              l: actions.forward,
              t: actions.dub,
              r: actions.regenerate,
              v: actions.validate,
            } as Record<string, () => void>
          )[key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [actions]);
}
