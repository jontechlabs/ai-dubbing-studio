import type { Project } from './types';
import type { DubbingBatchSelection } from '../services/bridge';
import { translationStates } from './translation';
export function workflowLines(p: Project, selection: DubbingBatchSelection) {
  const ids = new Set(selection.lineIds),
    children = new Set(
      p.speakerDubbings?.filter((g) => g.active).flatMap((g) => g.voices.map((v) => v.lineId)) ??
        [],
    );
  const states = translationStates(p);
  return p.dialogues.filter(
    (l) =>
      !l.excludedFromDubbing &&
      (selection.scope === 'selected' ? ids.has(l.id) : !children.has(l.id)) &&
      (!selection.approvedOnly || states.get(l.id) === 'approved') &&
      (!selection.unapprovedOnly || states.get(l.id) !== 'approved'),
  );
}
