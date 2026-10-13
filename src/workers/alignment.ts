import { analyzeAlignment } from '../domain/alignment';
import type { Project } from '../domain/types';
import type { SubtitleRole } from '../domain/timing';
self.onmessage = (event: MessageEvent<{ project: Project; reference: SubtitleRole }>) => {
  try {
    self.postMessage({ result: analyzeAlignment(event.data.project, event.data.reference) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
