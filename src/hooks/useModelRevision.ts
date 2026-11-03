import { useEffect, useState } from 'react';
/** Refresh metadata after an explicit native model removal, including MCP calls. */
export function useModelRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((n) => n + 1);
    document.addEventListener('studio-models-changed', update);
    return () => document.removeEventListener('studio-models-changed', update);
  }, []);
  return revision;
}
