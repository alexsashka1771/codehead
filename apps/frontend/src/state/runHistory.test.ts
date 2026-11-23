import { describe, expect, it } from 'vitest';
import type { RunView } from '../../../../packages/contracts';
import { testRun } from './fixtures';
import { mergeRunHistory } from './runHistory';

describe('run history after a concurrent mutation', () => {
  it('keeps a newly committed run and the older saved history without mutating either input', () => {
    const older: RunView = { ...testRun, id: 'older-run', status: 'cancelled', last_event_seq: 9 };
    const newer: RunView = { ...testRun, id: 'newer-run', created_at: '2026-11-14T10:05:00Z', last_event_seq: 8 };
    const received = [older];
    const current = [newer];
    const before = structuredClone({ received, current });
    const result = mergeRunHistory(received, current, testRun.project_id);
    expect(result.map((run) => run.id)).toEqual(['newer-run', 'older-run']);
    expect({ received, current }).toEqual(before);
  });

  it('keeps the newest event cursor when a command and a list return different states', () => {
    const beforeCommand: RunView = { ...testRun, status: 'created', last_event_seq: 8 };
    const commandReceipt: RunView = { ...testRun, status: 'paused', last_event_seq: 9 };
    const afterAnotherCommand: RunView = { ...testRun, status: 'cancelled', last_event_seq: 10 };
    expect(mergeRunHistory([beforeCommand], [commandReceipt], testRun.project_id)).toEqual([commandReceipt]);
    expect(mergeRunHistory([afterAnotherCommand], [commandReceipt], testRun.project_id)).toEqual([afterAnotherCommand]);
  });

  it('does not mix runs from another project into the selected history', () => {
    const foreign: RunView = { ...testRun, id: 'foreign-run', project_id: 'another-project', last_event_seq: 100 };
    expect(mergeRunHistory([testRun], [foreign], testRun.project_id)).toEqual([testRun]);
  });
});
