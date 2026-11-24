import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CandidatePanel, Inspector } from './Inspector';
import { makeCandidateSnapshot } from '../state/candidateFixtures';

describe('candidate inspection navigation', () => {
  it('renders the saved revision, complete hashes and source provenance as accessible HTML', () => {
    expect(typeof CandidatePanel).toBe('function');
    const snapshot = makeCandidateSnapshot();
    const candidate = snapshot.candidate!;
    const markup = renderToStaticMarkup(<CandidatePanel snapshot={snapshot} onSelectArtifact={() => {}} onSelectAttempt={() => {}} />);
    expect(markup).toContain('data-candidate-id="candidate-one"');
    expect(markup).toContain('data-candidate-revision="3"');
    for (const hash of [candidate.profile_hash, candidate.acceptance_suite_hash, candidate.template_hash, candidate.tree_hash, candidate.manifest_hash!]) expect(markup).toContain(hash);
    expect(markup).toContain('clinic_demo/v1');
    expect(markup).toContain('QA и preview пока недоступны');
    expect(markup).toContain('Проверки Runner доступны во вкладке');
    for (const file of candidate.files) {
      expect(markup).toContain(file.relative_path);
      expect(markup).toContain(file.content_hash);
      expect(markup).toContain('data-artifact-id="' + file.artifact_id + '"');
      if (file.parent_artifact_id) expect(markup).toContain('data-artifact-id="' + file.parent_artifact_id + '"');
      if (file.producer_id) expect(markup).toContain('data-attempt-id="' + file.producer_id + '"');
    }
    expect(markup).toContain('test_injected');
    expect(markup).toContain('template');
    expect(markup).not.toContain('<iframe');
  });

  it.each(['blocked', 'conflict'] as const)('shows the stored %s reason without claiming a runnable preview', status => {
    expect(typeof CandidatePanel).toBe('function');
    const snapshot = makeCandidateSnapshot(status);
    const markup = renderToStaticMarkup(<CandidatePanel snapshot={snapshot} onSelectArtifact={() => {}} onSelectAttempt={() => {}} />);
    expect(markup).toContain(snapshot.candidate!.blocked_reason!);
    expect(markup).not.toContain('Открыть preview');
  });

  it('explains the legacy empty state without inventing files or a candidate', () => {
    expect(typeof CandidatePanel).toBe('function');
    const snapshot = makeCandidateSnapshot(); snapshot.candidate = null; snapshot.run.workflow_version = 'clinic-v1';
    const markup = renderToStaticMarkup(<CandidatePanel snapshot={snapshot} onSelectArtifact={() => {}} onSelectAttempt={() => {}} />);
    expect(markup).toContain('clinic-v1');
    expect(markup).not.toContain('data-candidate-id');
  });

  it('labels the materializing state before claiming that files are saved', () => {
    const markup = renderToStaticMarkup(<CandidatePanel snapshot={makeCandidateSnapshot('materializing')} onSelectArtifact={() => {}} onSelectAttempt={() => {}} />);
    expect(markup).toContain('Материализуется');
  });

  it('offers the candidate version alongside the existing run data without replacing other tabs', () => {
    const markup = renderToStaticMarkup(<Inspector snapshot={makeCandidateSnapshot()} events={[]} capabilities={null}
      loading={false} expanded onExpandedChange={() => {}} connected pending={false} onResolve={async () => true} />);
    expect(markup).toContain('aria-label="Кандидат Clinic Demo"');
    expect(markup).toContain('>Версия</span>');
    expect(markup).toContain('aria-label="Артефакты"');
    expect(markup).toContain('aria-label="Попытки ролей"');
  });
});
