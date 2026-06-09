/**
 * 错误类型
 */

export class KernelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'KernelError'
  }
}

export class NotImplementedError extends KernelError {
  constructor(feature: string) {
    super('E_NOT_IMPLEMENTED', `${feature} is not implemented yet in this alpha version`)
    this.name = 'NotImplementedError'
  }
}

export class InvalidConfigError extends KernelError {
  constructor(message: string) {
    super('E_INVALID_CONFIG', message)
    this.name = 'InvalidConfigError'
  }
}

export class ResourceError extends KernelError {
  constructor(message: string, cause?: unknown) {
    super('E_RESOURCE', message, cause)
    this.name = 'ResourceError'
  }
}

export class StorageError extends KernelError {
  constructor(message: string, cause?: unknown) {
    super('E_STORAGE', message, cause)
    this.name = 'StorageError'
  }
}

export class SandboxError extends KernelError {
  constructor(message: string, cause?: unknown) {
    super('E_SANDBOX', message, cause)
    this.name = 'SandboxError'
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}
