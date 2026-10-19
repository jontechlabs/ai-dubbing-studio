import type { Project } from './types';
import { retimeDubbing } from './mix';
export interface MouthRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LipOptions {
  lineId: string;
  generationId: string;
  startMs: number;
  endMs: number;
  region: MouthRegion;
}
export interface LipAnalysis {
  projectId: string;
  revision: number;
  sourcePath: string;
  language: string;
  options: LipOptions;
  startMs: number;
  durationMs: number;
  score: number;
  currentScore: number;
  reliable: boolean;
  warnings: string[];
  stepMs: number;
  mouth: number[];
  voice: number[];
}
export function applyLipAnalysis(project: Project, analysis: LipAnalysis): Project {
  const line = project.dialogues.find((l) => l.id === analysis.options.lineId);
  if (
    project.id !== analysis.projectId ||
    project.revision !== analysis.revision ||
    project.media?.path !== analysis.sourcePath ||
    project.languages.target !== analysis.language ||
    line?.selectedGenerationIds[analysis.language] !== analysis.options.generationId
  )
    throw Error('STALE_REVISION');
  if (
    !Number.isSafeInteger(analysis.startMs) ||
    !Number.isSafeInteger(analysis.durationMs) ||
    analysis.startMs < analysis.options.startMs ||
    analysis.startMs + analysis.durationMs > analysis.options.endMs ||
    analysis.durationMs < 1 ||
    analysis.durationMs > 120000
  )
    throw Error('LIPS_ANALYSIS_FAILED');
  return retimeDubbing(project, line.id, analysis.startMs - line.startMs, analysis.durationMs);
}
