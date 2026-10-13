import type { Project } from '../domain/types';

export interface StoredProject {
  project: Project;
  media: Blob | null;
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
      const item = operation === 'get' ? store.get(id) : store.put(value, id);
      let result: StoredProject | undefined;
      item.onsuccess = () => {
        result = item.result as StoredProject | undefined;
      };
      transaction.oncomplete = () => {
        db.close();
        resolve(operation === 'get' ? result : value);
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
