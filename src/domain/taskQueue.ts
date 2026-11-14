import type { DubbingBatchSelection } from '../services/bridge';
export interface WorkflowSeparation {
  modelId: string;
  sourceTrackId: string;
  device: string;
  windowSeconds: number;
  vocals: boolean;
  music: boolean;
  muteSource: boolean;
}
export interface WorkflowSpec {
  name: string;
  selection: DubbingBatchSelection;
  separation: WorkflowSeparation | null;
  dubbing: boolean;
  continueOnError: boolean;
}
export interface WorkflowRow {
  lineId: string;
  startMs: number;
  endMs: number;
  status: string;
  jobId: string | null;
  error: string | null;
}
export interface WorkflowDubRun {
  id: string;
  lineIds: string[];
  jobId: string | null;
  status: string;
  error: string | null;
}
export interface WorkflowEntry {
  id: string;
  createdAt: string;
  projectId: string;
  projectName: string;
  spec: WorkflowSpec;
  status: string;
  stage: string;
  error: string | null;
  rows: WorkflowRow[];
  dubbingRuns: WorkflowDubRun[];
}
export interface WorkflowQueue {
  revision: number;
  paused: boolean;
  entries: WorkflowSummary[];
  warning: string | null;
}
export interface WorkflowSummary {
  id: string;
  name: string;
  createdAt: string;
  projectId: string;
  projectName: string;
  status: string;
  stage: string;
  error: string | null;
  separation: boolean;
  dubbing: boolean;
  total: number;
  completed: number;
  failed: number;
  currentLineId: string | null;
  currentJobId: string | null;
  problems: { lineId?: string; jobId?: string; error: string }[];
  batchIds: string[];
}
