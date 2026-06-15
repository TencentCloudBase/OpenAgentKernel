export class WorkspaceSnapshotError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'WorkspaceSnapshotError'
  }
}

export class SandboxRestoreFailed extends Error {
  readonly note?: string
  constructor(message: string, opts: { note?: string; cause?: unknown } = {}) {
    super(message)
    this.name = 'SandboxRestoreFailed'
    this.note = opts.note
  }
}

export class SandboxRestoreTimeout extends Error {
  constructor(
    message: string,
    public readonly timeoutMs: number,
  ) {
    super(message)
    this.name = 'SandboxRestoreTimeout'
  }
}

export class SandboxUnavailableError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}
