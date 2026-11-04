import type { Project } from '../domain/types';

export interface StoredProject {
  project: Project;
  media: Blob | null;
  trashedAt?: string;
  cover?: { atMs: number; source: string; url: string; durationMs: number };
}
export async function browserStore(
  operation: 'get' | 'put',
  id: string,
  value?: StoredProject,
): Promise<StoredProject | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dubbing-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(
        'projects',
        operation === 'get' ? 'readonly' : 'readwrite',
      );
      const store = transaction.objectStore('projects');
      const item = store.get(id);
      let result: StoredProject | undefined;
      item.onsuccess = () => {
        if (operation === 'put') {
          result = { ...item.result, ...value } as StoredProject;
          store.put(result, id);
        } else result = item.result as StoredProject | undefined;
      };
      transaction.oncomplete = () => {
        db.close();
        resolve(result);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}
export function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export interface StoredProjectMeta {
  trashedAt?: string;
}
/** Read catalogue metadata without changing the current editor project. */
export async function browserProjects(): Promise<(StoredProject & StoredProjectMeta)[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dubbing-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result,
        tx = db.transaction('projects', 'readonly'),
        all = tx.objectStore('projects').getAll();
      all.onsuccess = () => resolve(all.result);
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
export async function forgetBrowserProject(id: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.open('dubbing-studio', 1);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result,
        tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').delete(id);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

/** Update library-only metadata in the same transaction that reads the latest project. */
export async function browserMetadata(
  id: string,
  patch: Partial<Pick<StoredProject, 'cover' | 'trashedAt'>>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dubbing-studio', 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result,
        tx = db.transaction('projects', 'readwrite'),
        store = tx.objectStore('projects'),
        r = store.get(id);
      r.onsuccess = () => {
        if (!r.result) {
          tx.abort();
          reject(Error('PROJECT_NOT_FOUND'));
          return;
        }
        store.put({ ...r.result, ...patch }, id);
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.onabort = () => {
        db.close();
        reject(Error('PROJECT_NOT_FOUND'));
      };
    };
  });
}
