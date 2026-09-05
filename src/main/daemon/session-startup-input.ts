import type { SessionOptions } from './session-options'
import type { SessionOutputPlane } from './session-output-plane'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { DeferredStartupStatus } from '../../shared/deferred-startup-release'
import { extractOnlyTerminalQueryReplies } from '../../shared/terminal-query-reply'
import {
  SessionDeferredStartup,
  type DeferredSessionStartup,
  type StartupCommandReleaseResult
} from './session-deferred-startup'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'

type SessionStartupInputOptions = {
  incarnationId: string
  isAlive(): boolean
  isTerminating(): boolean
  subprocess: Pick<SubprocessHandle, 'write'>
  ingress: Pick<PtyStartupIngress, 'answerLiveQueryReply'>
  shellReady: Pick<SessionShellReadyBarrier, 'tryEnqueue'>
  deferredStartup?: DeferredSessionStartup
}

export class SessionStartupInput {
  private awaitingDelivery = false
  private readonly deferred: SessionDeferredStartup | undefined
  private readonly options: Omit<SessionStartupInputOptions, 'deferredStartup'>

  constructor({ deferredStartup, ...options }: SessionStartupInputOptions) {
    this.options = options
    this.deferred = deferredStartup ? new SessionDeferredStartup(deferredStartup) : undefined
  }

  get deferredStartupStatus(): DeferredStartupStatus | undefined {
    return this.deferred?.status
  }

  write(data: string): void {
    if (!this.options.isAlive() || this.options.ingress.answerLiveQueryReply(data)) {
      return
    }
    if (this.deferred?.isPending && data.length > 0 && !extractOnlyTerminalQueryReplies(data)) {
      this.deferred.retire()
    }
    // Preserve the post-marker queue until its flush gate opens.
    if (!this.options.shellReady.tryEnqueue(data)) {
      this.options.subprocess.write(data)
    }
  }

  retire(): void {
    this.deferred?.retire(this.awaitingDelivery)
    this.awaitingDelivery = false
  }

  release(expectedIncarnationId: string, operationId: string): StartupCommandReleaseResult {
    if (expectedIncarnationId !== this.options.incarnationId) {
      return 'identity-mismatch'
    }
    if (!this.options.isAlive() || this.options.isTerminating()) {
      return 'unavailable'
    }
    return this.deferred?.release(operationId, (data) => this.deliver(data)) ?? 'unavailable'
  }

  private deliver(data: string): void {
    this.awaitingDelivery = true
    const write = (): void => {
      if (!this.awaitingDelivery) {
        return
      }
      this.awaitingDelivery = false
      if (!this.options.isAlive() || this.options.isTerminating()) {
        return
      }
      try {
        this.options.subprocess.write(data)
      } catch {
        this.deferred?.markUnverifiable()
      }
    }
    if (!this.options.shellReady.tryEnqueue(write)) {
      write()
    }
  }
}

export function createSessionStartupInput(args: {
  opts: SessionOptions
  output: SessionOutputPlane
  recoveryBarrier: TerminalShellRecoveryBarrier
  isAlive(): boolean
  isTerminating(): boolean
  incarnationId: string
}): {
  shellReady: SessionShellReadyBarrier
  startupIngress: PtyStartupIngress
  input: SessionStartupInput
} {
  const { opts, output, recoveryBarrier } = args
  const subprocess = opts.subprocess
  const shellReady = new SessionShellReadyBarrier({
    sessionId: opts.sessionId,
    subprocess,
    responderParser: output.responderParser,
    shellReadySupported: opts.shellReadySupported,
    ...(opts.reportReadinessEvent ? { reportReadinessEvent: opts.reportReadinessEvent } : {}),
    shellReadyTimeoutMs: opts.shellReadyTimeoutMs,
    installDeviceAttributesFilter: () => output.installDeviceAttributesFilter(),
    releaseDeviceAttributesFilter: () => output.releaseDeviceAttributesFilter(),
    acceptStartupIngress: (data) => startupIngress.accept(data)
  })

  const startupIngress = new PtyStartupIngress({
    ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
    ...(opts.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
    write: (data) => subprocess.write(data),
    onEmission: (emission) => recoveryBarrier.accept(emission)
  })
  const input = new SessionStartupInput({
    incarnationId: args.incarnationId,
    isAlive: args.isAlive,
    isTerminating: args.isTerminating,
    subprocess,
    ingress: startupIngress,
    shellReady,
    deferredStartup: opts.deferredStartup
  })
  return { shellReady, startupIngress, input }
}
