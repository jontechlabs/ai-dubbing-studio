export interface AudioToolboxOptions {
  modelId: string;
  sourceTrackId: string;
  startMs: number;
  endMs: number;
  device: string;
  prompt: string;
  windowSeconds: number;
}
export interface AudioToolboxDestination {
  outputId: string;
  trackId: string | null;
  role: string | null;
}
export interface AudioToolboxModel {
  id: string;
  name: string;
  family: string;
  installed: boolean;
  modelBytes: number;
  requiredBytes: number;
  outputs: string[];
  license: string;
  source: string;
}
export interface AudioToolboxStatus {
  availableBytes: number | null;
  models: AudioToolboxModel[];
  devices: { id: string; name: string }[];
}
export interface AudioToolboxResult {
  id: string;
  options: AudioToolboxOptions;
  outputs: string[];
  commonGain: number;
  deviceName: string;
  stale: boolean;
  applied: boolean;
}
