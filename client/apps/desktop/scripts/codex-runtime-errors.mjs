export class CodexRuntimeAssetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CodexRuntimeAssetError';
    this.code = code;
    this.details = details;
  }
}

export function failCodexRuntimeAsset(code, message, details) {
  throw new CodexRuntimeAssetError(code, message, details);
}
