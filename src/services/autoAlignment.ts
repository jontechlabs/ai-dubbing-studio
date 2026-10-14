import type { Project } from '../domain/types';
import { applyAlignment, type Alignment } from '../domain/alignment';
export async function autoAlignment(
  project: Project,
  importedRole: 'source' | 'target',
): Promise<Project> {
  const worker = new Worker(new URL('../workers/alignment.ts', import.meta.url), {
    type: 'module',
  });
  try {
    const proposal = await new Promise<Alignment>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ result?: Alignment; error?: string }>) =>
        event.data.result ? resolve(event.data.result) : reject(new Error(event.data.error));
      worker.onerror = () => reject(new Error('ALIGNMENT_FAILED'));
      worker.postMessage({ project, reference: importedRole === 'target' ? 'source' : 'target' });
    });
    return applyAlignment(project, proposal);
  } finally {
    worker.terminate();
  }
}
