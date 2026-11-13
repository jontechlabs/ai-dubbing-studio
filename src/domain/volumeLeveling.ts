export interface VolumeLevelingOptions {
  mediaId: string;
  trackId: string;
  startMs: number;
  endMs: number;
  mode: 'low' | 'high';
}
export interface VolumeLevelingResult {
  id: string;
  projectId: string;
  revision: number;
  options: VolumeLevelingOptions;
  stats: {
    targetDb: number;
    quietDb: number;
    loudDb: number;
    safetyDb: number;
    gainLimited: boolean;
    activeWindows: number;
  };
}
