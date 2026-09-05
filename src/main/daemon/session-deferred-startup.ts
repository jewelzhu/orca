import type {
  DeferredStartupStatus,
  StartupCommandReleaseResult
} from '../../shared/deferred-startup-release'
export type { StartupCommandReleaseResult } from '../../shared/deferred-startup-release'

export type DeferredSessionStartup = {
  operationId: string
  submission: string
}

/** Keeps Create authorization separate from the shell readiness timeout. */
export class SessionDeferredStartup {
  private state: DeferredStartupStatus = 'pending'
  private submission: string | null
  private readonly operationId: string

  constructor(startup: DeferredSessionStartup) {
    this.operationId = startup.operationId
    this.submission = startup.submission
  }

  get isPending(): boolean {
    return this.state === 'pending'
  }

  get status(): DeferredStartupStatus {
    return this.state
  }

  retire(acceptedButUndelivered = false): void {
    if (this.state === 'pending' || (acceptedButUndelivered && this.state === 'accepted')) {
      this.state = 'retired'
      this.submission = null
    }
  }

  markUnverifiable(): void {
    if (this.state === 'accepted') {
      this.state = 'unverifiable'
    }
  }

  release(operationId: string, write: (submission: string) => void): StartupCommandReleaseResult {
    if (!operationId || operationId !== this.operationId) {
      return 'identity-mismatch'
    }
    if (this.state !== 'pending') {
      return this.state
    }
    const submission = this.submission
    this.submission = null
    this.state = 'accepted'
    try {
      if (submission) {
        write(submission)
      }
    } catch {
      // A throwing write can already have delivered bytes; never replay it.
      this.state = 'unverifiable'
    }
    return this.state
  }
}
