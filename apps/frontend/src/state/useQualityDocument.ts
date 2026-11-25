import { useCallback } from 'react';
import type { ArtifactView, QualityCycleView, Snapshot } from '../../../../packages/contracts';
import { api } from '../app/api';
import { useImmutableResource } from './useImmutableResource';
import { qualityContentError, validateQualityArtifactContent } from './qualityContent';

export function useQualityDocument(snapshot: Snapshot, artifact: ArtifactView) {
  const read = useCallback(async (id: string, signal: AbortSignal) => {
    const content = await api.artifactContent(id, signal);
    return validateQualityArtifactContent(snapshot, artifact, content);
  }, [snapshot, artifact]);
  return useImmutableResource(artifact.id, read, `${snapshot.run.id}:${artifact.content_hash}`);
}
export function useBugResolution(snapshot: Snapshot, artifact: ArtifactView) {
  const origin = snapshot.quality_cycles?.find(cycle => cycle.bug_artifact_ids?.includes(artifact.id));
  const reports = (snapshot.quality_cycles ?? []).filter(cycle => artifact.artifact_type === 'bug' && origin
    && cycle.iteration > origin.iteration && cycle.status === 'passed' && cycle.report_artifact_id);
  const version = reports.map(cycle => cycle.report_artifact_id + ':' + snapshot.artifacts.find(a => a.id === cycle.report_artifact_id)?.content_hash).join('|');
  const read = useCallback(async (_id: string, signal: AbortSignal): Promise<QualityCycleView | null> => {
    const results = await Promise.all(reports.map(async cycle => {
      const report = snapshot.artifacts.find(a => a.id === cycle.report_artifact_id);
      if (!report) throw new Error(qualityContentError);
      const content = await api.artifactContent(report.id, signal);
      const verified = await validateQualityArtifactContent(snapshot, report, content);
      return verified.kind === 'test_report' && verified.value.resolves_bug_ids?.includes(artifact.id) ? cycle : null;
    }));
    return results.find(cycle => cycle !== null) ?? null;
  }, [snapshot, artifact.id, version]);
  return useImmutableResource(reports.length ? artifact.id : null, read, `${snapshot.run.id}:${version}`);
}
