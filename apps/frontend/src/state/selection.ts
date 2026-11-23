export interface Selection { projectId: string | null; runId: string | null }
const storageKey = 'codehead.selection.v1';

export function readSelection(): Selection {
  const url = new URL(window.location.href);
  if (url.searchParams.has('project')) return { projectId: url.searchParams.get('project'), runId: url.searchParams.get('run') };
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Selection | null;
    if (value && typeof value.projectId === 'string') return { projectId: value.projectId, runId: typeof value.runId === 'string' ? value.runId : null };
  } catch { /* Storage can be unavailable in private browsing. URL selection still works. */ }
  return { projectId: null, runId: null };
}

export function saveSelection(selection: Selection) {
  const url = new URL(window.location.href);
  for (const [key, value] of [['project', selection.projectId], ['run', selection.runId]]) {
    if (value) url.searchParams.set(key!, value);
    else url.searchParams.delete(key!);
  }
  window.history.replaceState(null, '', url);
  try { localStorage.setItem(storageKey, JSON.stringify(selection)); }
  catch { /* The URL remains the source of truth when browser storage is unavailable. */ }
}
