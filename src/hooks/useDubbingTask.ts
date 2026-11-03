import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job, Project } from '../domain/types';
import { selectedGeneration, voiceGenerations } from '../domain/tts';

type Task = {
  scope: string;
  sequence: number;
  before: Set<string>;
  id: string | null;
  starting: boolean;
  error?: string;
};
type Operation = {
  task: Task | null;
  lastJob?: Job;
  localTake?: { id: string; sequence: number };
};
const belongsToProject = (job: Job, projectId: string) =>
  job.projectId === projectId || job.projectId === '';

/** Keep a panel operation and its eventual selected take together, in either event order. */
export function useDubbingTask(
  project: Project,
  lineId: string | undefined,
  batch: boolean,
  jobs: Job[],
  run: (operation: () => Promise<Project | null>) => Promise<void>,
) {
  const scope = JSON.stringify([
    project.id,
    project.media?.path,
    project.languages.target,
    batch ? null : lineId,
    batch,
  ]);
  const alive = useRef(false),
    sequence = useRef(0);
  const operations = useRef(new Map<string, Operation>());
  const [, refresh] = useState(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Only operated-on replies are retained, with a bounded history. Changing the
  // selection must not discard a launch whose job ID has not arrived yet.
  const remember = useCallback((key: string, operation: Operation) => {
    const cache = operations.current;
    cache.delete(key);
    cache.set(key, operation);
    while (cache.size > 12) cache.delete(cache.keys().next().value!);
    if (alive.current) refresh((n) => n + 1);
  }, []);
  const start = useCallback(
    async (operation: () => Promise<string>) => {
      const next: Task = {
        scope,
        sequence: ++sequence.current,
        before: new Set(
          voiceGenerations(project)
            .filter((g) => batch || g.dialogueId === lineId)
            .map((g) => g.id),
        ),
        id: null,
        starting: true,
      };
      const operationState: Operation = { task: next };
      remember(scope, operationState);
      try {
        const id = await operation();
        if (alive.current && operations.current.get(scope) === operationState) {
          operationState.task = { ...next, id, starting: false };
          refresh((n) => n + 1);
        }
        return id;
      } catch (error) {
        if (alive.current && operations.current.get(scope) === operationState) {
          operationState.task = { ...next, starting: false, error: String(error) };
          refresh((n) => n + 1);
        }
        throw error;
      }
    },
    [project, scope, batch, lineId, remember],
  );
  const runInPanel = useCallback(
    (operation: () => Promise<Project | null>) => {
      const before = new Set(
          voiceGenerations(project)
            .filter((g) => g.dialogueId === lineId)
            .map((g) => g.id),
        ),
        currentSequence = ++sequence.current;
      const operationState: Operation = {
        ...operations.current.get(scope),
        task: operations.current.get(scope)?.task ?? null,
        localTake: undefined,
      };
      remember(scope, operationState);
      return run(async () => {
        const result = await operation();
        const line = result?.dialogues.find((l) => l.id === lineId);
        const take = result && line ? selectedGeneration(result, line) : undefined;
        if (
          take &&
          !before.has(take.id) &&
          alive.current &&
          operations.current.get(scope) === operationState
        ) {
          operationState.localTake = { id: take.id, sequence: currentSequence };
          refresh((n) => n + 1);
        }
        return result;
      });
    },
    [project, scope, lineId, run, remember],
  );
  const operation = operations.current.get(scope);
  const current = operation?.task ?? null;
  const observedJob = jobs.find((j) => j.id === current?.id && belongsToProject(j, project.id));
  useEffect(() => {
    for (const entry of operations.current.values()) {
      const observed = jobs.find((j) => j.id === entry.task?.id && belongsToProject(j, project.id));
      if (observed) entry.lastJob = observed;
    }
  }, [jobs, project.id, current?.id]);
  // The global job history is bounded; a completed panel task must not turn
  // back into an indefinitely pending launch when its record is pruned.
  const job =
    observedJob ??
    (operation?.lastJob &&
    operation.lastJob.id === current?.id &&
    belongsToProject(operation.lastJob, project.id)
      ? operation.lastJob
      : undefined);
  const terminal = job && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status);
  const makesTake =
    job &&
    ['tts', 'ttsTrials', 'ttsPipeline', 'voiceConversion', 'prosodyTransfer', 'ttsBatch'].includes(
      job.kind,
    );
  const result =
    terminal && makesTake && current
      ? [...voiceGenerations(project)].reverse().find((g) => {
          if (
            current.before.has(g.id) ||
            g.language !== project.languages.target ||
            (!batch && g.dialogueId !== lineId)
          )
            return false;
          if (job.kind === 'ttsPipeline' && !g.dubbingPipeline) return false;
          if (job.kind === 'voiceConversion' && g.takeOrigin?.type !== 'conversion') return false;
          if (job.kind === 'prosodyTransfer' && !g.prosodyTransfer) return false;
          const line = project.dialogues.find((l) => l.id === g.dialogueId);
          return (
            !!line &&
            !line.excludedFromDubbing &&
            line.selectedGenerationIds[project.languages.target] === g.id
          );
        })
      : undefined;
  const localTake = operation?.localTake;
  const local =
    localTake && voiceGenerations(project).some((g) => g.id === localTake.id) ? localTake : null;
  return {
    start,
    run: runInPanel,
    job,
    pending: !!current && (current.starting || (!!current.id && !job)),
    error: current?.error,
    result,
    focusId: local?.id ?? result?.id,
    focusKey: local
      ? `local:${local.sequence}:${local.id}`
      : result
        ? `${current!.sequence}:${result.id}`
        : '',
  };
}
