export class CoreError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = 'CoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details = undefined, options = undefined) {
  throw new CoreError(code, message, details, options);
}

export function asCoreError(error, code, message, details = undefined) {
  if (error instanceof CoreError) return error;
  return new CoreError(code, message, details, { cause: error });
}
