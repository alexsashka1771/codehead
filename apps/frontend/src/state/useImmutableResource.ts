import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../app/api';

interface Resource<T> { id: string | null; versionKey: string; data: T | null; loading: boolean; error: string | null }
function empty<T>(id: string | null, versionKey: string): Resource<T> { return { id, versionKey, data: null, loading: id !== null, error: null }; }

export function useImmutableResource<T>(id: string | null, read: (id: string, signal: AbortSignal) => Promise<T>, versionKey = '') {
  const [resource, setResource] = useState<Resource<T>>(() => empty(id, versionKey));
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!id) { setResource(empty(null, versionKey)); return; }
    const controller = new AbortController();
    setResource(empty(id, versionKey));
    read(id, controller.signal).then(data => {
      if (!controller.signal.aborted) setResource({ id, versionKey, data, loading: false, error: null });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setResource({ id, versionKey, data: null, loading: false, error: errorMessage(cause) });
    });
    return () => controller.abort();
  }, [id, read, revision, versionKey]);
  return { ...(resource.id === id && resource.versionKey === versionKey ? resource : empty<T>(id, versionKey)), retry };
}
