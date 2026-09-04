export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeJson(value, stream = process.stdout) {
  stream.write(json(value));
}

export function formatOperationResults(results, { dryRun = false } = {}) {
  if (results.length === 0) return 'No changes needed.\n';
  const prefix = dryRun ? 'would ' : '';
  return `${results.map((result) => {
    const status = result.changed ? `${prefix}${result.action}` : 'unchanged';
    return `${status.padEnd(13)} ${result.path}`;
  }).join('\n')}\n`;
}
