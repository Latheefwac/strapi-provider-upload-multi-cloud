/**
 * Typed error hierarchy for the multi-cloud upload provider.
 *
 * Every error carries a stable `code` so callers (and tests) can branch on it
 * without string-matching messages. Messages are written to be actionable:
 * they name the offending configuration key or object key where relevant.
 */

export type ProviderErrorCode =
  | 'CONFIG_INVALID'
  | 'DRIVER_UNSUPPORTED'
  | 'AUTH_UNAVAILABLE'
  | 'SIGNING_UNSUPPORTED'
  | 'OBJECT_EXISTS'
  | 'OBJECT_NOT_FOUND'
  | 'KEY_INVALID'
  | 'COLLISION_LIMIT'
  | 'UPLOAD_FAILED'
  | 'DELETE_FAILED'
  | 'COPY_FAILED';

export class ProviderError extends Error {
  public readonly code: ProviderErrorCode;
  public readonly cause?: unknown;

  constructor(code: ProviderErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.cause = cause;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Configuration failed validation at init() time. */
export class ConfigError extends ProviderError {
  constructor(message: string, cause?: unknown) {
    super('CONFIG_INVALID', message, cause);
    this.name = 'ConfigError';
  }
}

/**
 * A conditional ("if-none-match") write failed because the object already
 * exists. This is the signal that drives collision-safe key allocation.
 */
export class ObjectExistsError extends ProviderError {
  public readonly key: string;
  constructor(key: string, cause?: unknown) {
    super('OBJECT_EXISTS', `Object already exists at key "${key}".`, cause);
    this.name = 'ObjectExistsError';
    this.key = key;
  }
}

/** Signing was requested but the configured credentials cannot produce it. */
export class SigningUnsupportedError extends ProviderError {
  constructor(message: string, cause?: unknown) {
    super('SIGNING_UNSUPPORTED', message, cause);
    this.name = 'SigningUnsupportedError';
  }
}

/** An object key failed safety validation (traversal, control chars, etc.). */
export class InvalidKeyError extends ProviderError {
  constructor(message: string) {
    super('KEY_INVALID', message);
    this.name = 'InvalidKeyError';
  }
}

/** Returns true when the error signals an existing object on a conditional write. */
export function isObjectExistsError(err: unknown): err is ObjectExistsError {
  return err instanceof ProviderError && err.code === 'OBJECT_EXISTS';
}
