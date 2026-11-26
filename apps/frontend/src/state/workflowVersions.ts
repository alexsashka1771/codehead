export function hasCandidateWorkflow(version: string | undefined) {
  return version === 'clinic-v2' || hasQualityWorkflow(version);
}

export function hasQualityWorkflow(version: string | undefined) {
  return version === 'clinic-v3' || version === 'clinic-v4';
}
