import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Inspector } from './Inspector';
import { PreviewPanel } from './PreviewPanel';
import { makeDeliverySnapshot } from '../state/previewFixtures';
import { makeQualitySnapshot } from '../state/qualityFixtures';

const state = vi.hoisted(() => ({ openedOrigin: null as string | null }));
vi.mock('../state/usePreview', () => ({ usePreview: () => ({
  ...state, canStart: false, canStop: true, canOpen: true, checking: false, phase: null,
  open: vi.fn(), close: vi.fn(), command: vi.fn(),
}) }));
const handlers = { onSelectArtifact() {}, onSelectTool() {} };

describe('preview panel', () => {
  it('shows exact sources, the archive and the latest preview in Inspector', () => {
    const snapshot = makeDeliverySnapshot();
    const inspector = renderToStaticMarkup(<Inspector snapshot={snapshot} events={[]} capabilities={null} loading={false}
      expanded onExpandedChange={() => {}} connected pending={false} onResolve={async () => true} />);
    expect(inspector).toContain('aria-label="Preview"');
    const view = renderToStaticMarkup(<PreviewPanel snapshot={snapshot} connected {...handlers} />);
    for (const id of ['artifact-package', 'artifact-runbook', 'report-1', 'artifact-smoke']) {
      expect(view).toContain(`data-artifact-id="${id}"`);
    }
    expect(view).toContain('data-tool-id="tool-1-2"');
    expect(view).toContain('data-tool-id="tool-smoke"');
    expect(view).toContain('href="/api/runs/run-one/delivery/package-run-one/archive"');
    expect(view).toContain('Скачать ZIP');
    expect(view).toContain('Готов к открытию');
    expect(view).not.toContain('<iframe');
  });

  it('mounts only the narrowly sandboxed iframe after opening', () => {
    state.openedOrigin = 'http://127.0.0.1:45670';
    try {
      const view = renderToStaticMarkup(<PreviewPanel snapshot={makeDeliverySnapshot()} connected {...handlers} />);
      expect(view).toContain('<iframe');
      expect(view).toContain('title="Clinic Demo · Preview"');
      expect(view).toContain('sandbox="allow-scripts allow-forms"');
      expect(view).toContain('referrerPolicy="no-referrer"');
      expect(view).toContain('src="http://127.0.0.1:45670"');
      expect(view).not.toContain('allow-same-origin');
      expect(view).not.toContain('allow-top-navigation');
      expect(view).not.toContain('allow-popups');
    } finally { state.openedOrigin = null; }
  });

  it('shows legacy QA scope without offering package or preview commands', () => {
    const view = renderToStaticMarkup(<PreviewPanel snapshot={makeQualitySnapshot()} connected {...handlers} />);
    expect(view).toContain('clinic-v3');
    expect(view).not.toContain('Запустить preview');
    expect(view).not.toContain('Скачать ZIP');
  });
});
