export class ProjectionError extends Error {
  constructor(public readonly code: 'event_gap' | 'foreign_run' | 'unsupported_schema' | 'unsupported_event' | 'invalid_event' | 'invalid_history' | 'invalid_timestamp') {
    super(code);
    this.name = 'ProjectionError';
  }
}
