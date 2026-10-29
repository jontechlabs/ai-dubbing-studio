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

/** Keep a panel operation and its eventual selected take together, in either event order. */
export function useDubbingTask(
  project: Project,
  lineId: string | undefined,
  batch: boolean,
  jobs: Job[],
  run: (operation: () => Promise<Project | null>) => Promise<void>,
) {
  const scope = JSON.stringify([project.id, project.languages.target, lineId, batch]);
  const alive = useRef(false),
    sequence = useRef(0);
  const [task, setTask] = useState<Task | null>(null);
  const [lastJob, setLastJob] = useState<Job>();
  const [localTake, setLocalTake] = useState<{
    scope: string;
    id: string;
    sequence: number;
  } | null>(null);
  useEffect(() => {
    alive.current = true;
    sequence.current += 1;
    setTask(null);
    setLocalTake(null);
    setLastJob(undefined);
    return () => {
      alive.current = false;
      sequence.current += 1;
    };
  }, [scope]);
  const start = useCallback(
    async (operation: () => Promise<string>) => {
      const next: Task = {
        scope,
        sequence: ++sequence.current,
        before: new Set(voiceGenerations(project).map((g) => g.id)),
        id: null,
        starting: true,
      };
      setTask(next);
      setLocalTake(null);
      try {
        const id = await operation();
        if (alive.current && sequence.current === next.sequence)
          setTask({ ...next, id, starting: false });
        return id;
      } catch (error) {
        if (alive.current && sequence.current === next.sequence)
          setTask({ ...next, starting: false, error: String(error) });
        throw error;
      }
    },
    [project, scope],
  );
  const runInPanel = useCallback(
    (operation: () => Promise<Project | null>) => {
      const before = new Set(voiceGenerations(project).map((g) => g.id)),
        currentSequence = sequence.current;
      return run(async () => {
        const result = await operation();
        const line = result?.dialogues.find((l) => l.id === lineId);
        const take = result && line ? selectedGeneration(result, line) : undefined;
        if (take && !before.has(take.id) && alive.current && sequence.current === currentSequence)
          setLocalTake({ scope, id: take.id, sequence: ++sequence.current });
        return result;
      });
    },
    [project, scope, lineId, run],
  );
  const current = task?.scope === scope ? task : null;
  const observedJob = jobs.find((j) => j.id === current?.id && j.projectId === project.id);
  useEffect(() => {
    if (observedJob) setLastJob(observedJob);
  }, [observedJob]);
  // The global job history is bounded; a completed panel task must not turn
  // back into an indefinitely pending launch when its record is pruned.
  const job =
    observedJob ??
    (lastJob?.id === current?.id && lastJob?.projectId === project.id ? lastJob : undefined);
  const terminal = job && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status);
  const makesTake =
    job &&
    ['tts', 'ttsPipeline', 'voiceConversion', 'prosodyTransfer', 'ttsBatch'].includes(job.kind);
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
  const local =
    localTake?.scope === scope && voiceGenerations(project).some((g) => g.id === localTake.id)
      ? localTake
      : null;
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
