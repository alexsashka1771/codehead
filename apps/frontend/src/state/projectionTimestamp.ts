import { ProjectionError } from './projectionError';

export function normalizeTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new ProjectionError('invalid_timestamp');
  const [, date, time, fraction = '', offset] = match;
  const utc = new Date(`${date}T${time}${offset}`);
  if (Number.isNaN(utc.getTime())) throw new ProjectionError('invalid_timestamp');
  const fractionalSeconds = fraction.replace(/0+$/, '');
  return `${utc.toISOString().slice(0, -5)}${fractionalSeconds ? `.${fractionalSeconds}` : ''}Z`;
}
