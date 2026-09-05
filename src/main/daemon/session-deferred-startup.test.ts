import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'

const operationId = 'composer-create-operation'
const submission = "codex 'explain this project'\r"
const readyMarker = '\x1b]777;orca-shell-ready\x07$ '

function recordingSubprocess() {
  let onData: ((data: string) => void) | undefined
  let onExit: ((code: number) => void) | undefined
  const written: string[] = []
  const write = vi.fn((data: string) => {
    written.push(data)
  })
  const handle: SubprocessHandle = {
    pid: 12345,
    getForegroundProcess: () => 'bash',
    write,
    resize: vi.fn(),
    kill: vi.fn(),
    forceKill: vi.fn(),
    signal: vi.fn(),
    terminateOwnedTree: () => 'unavailable',
    onData: (callback) => {
      onData = callback
    },
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn()
  }
  return {
    handle,
    written,
    write,
    emit: (data: string) => onData?.(data),
    exit: () => onExit?.(0)
  }
}

describe('Session deferred startup command', () => {
  let session: Session
  let subprocess: ReturnType<typeof recordingSubprocess>

  beforeEach(() => {
    vi.useFakeTimers()
    subprocess = recordingSubprocess()
  })

  afterEach(() => {
    session?.dispose()
    vi.useRealTimers()
  })

  function createSession(shellReadySupported = true, deferred = true): void {
    session = new Session({
      sessionId: 'composer-shell',
      cols: 80,
      rows: 24,
      subprocess: subprocess.handle,
      shellReadySupported,
      shellReadyTimeoutMs: 1_000,
      ...(deferred ? { deferredStartup: { operationId, submission } } : {})
    })
  }

  function release() {
    return session.releaseStartupCommand(session.incarnationId, operationId)
  }

  async function becomeReady(): Promise<void> {
    subprocess.emit(readyMarker)
    await vi.advanceTimersByTimeAsync(250)
  }

  it('keeps the command held after shell readiness until Create releases it', async () => {
    createSession()
    await becomeReady()
    expect(session.shellState).toBe('ready')
    expect(subprocess.written).toEqual([])

    expect(release()).toBe('accepted')
    expect(subprocess.written).toEqual([submission])
    expect(release()).toBe('accepted')
    expect(subprocess.written).toEqual([submission])
  })

  it('accepts Create before readiness and queues exactly one command through the existing gate', async () => {
    createSession()
    expect(release()).toBe('accepted')
    expect(release()).toBe('accepted')
    expect(subprocess.written).toEqual([])

    await becomeReady()
    expect(subprocess.written).toEqual([submission])
    expect(release()).toBe('accepted')
    subprocess.emit(readyMarker)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(subprocess.written).toEqual([submission])
  })

  it('does not launch on the readiness timeout without Create', async () => {
    createSession()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(session.shellState).toBe('timed_out')
    expect(subprocess.written).toEqual([])
    expect(release()).toBe('accepted')
    expect(subprocess.written).toEqual([submission])
  })

  it('flushes an already accepted Create once when the readiness marker is missing', async () => {
    createSession()
    expect(release()).toBe('accepted')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(subprocess.written).toEqual([submission])
    expect(release()).toBe('accepted')
    expect(subprocess.written).toEqual([submission])
  })

  it('releases immediately on shells without a readiness marker', () => {
    createSession(false)
    expect(subprocess.written).toEqual([])
    expect(release()).toBe('accepted')
    expect(release()).toBe('accepted')
    expect(subprocess.written).toEqual([submission])
  })

  it('rejects stale incarnation and operation identities without consuming the valid release', async () => {
    createSession()
    await becomeReady()
    expect(session.releaseStartupCommand('previous-incarnation', operationId)).toBe(
      'identity-mismatch'
    )
    expect(session.releaseStartupCommand(session.incarnationId, 'previous-operation')).toBe(
      'identity-mismatch'
    )
    expect(subprocess.written).toEqual([])
    expect(release()).toBe('accepted')
    expect(subprocess.written).toEqual([submission])
  })

  it('returns unavailable for an ordinary shell without a deferred command', () => {
    createSession(false, false)
    expect(release()).toBe('unavailable')
    expect(subprocess.written).toEqual([])
  })

  it.each([false, true])(
    'manual input retires the unreleased command (ready=%s)',
    async (ready) => {
      createSession()
      if (ready) {
        await becomeReady()
      }
      session.write('echo manual\r')
      expect(release()).toBe('retired')
      if (!ready) {
        await becomeReady()
      }
      expect(subprocess.written).toEqual(['echo manual\r'])
      expect(release()).toBe('retired')
    }
  )

  it('empty input and terminal query replies do not retire the command', async () => {
    createSession()
    session.write('')
    session.write('\x1b]10;rgb:ffff/ffff/ffff\x07')
    await becomeReady()
    expect(release()).toBe('accepted')
    expect(subprocess.written.filter((data) => data === submission)).toEqual([submission])
  })

  it.each(['\x1b[1;1R', '\x1b[?1;2c'])(
    'a non-user terminal reply %j does not retire the command',
    async (reply) => {
      createSession()
      session.write(reply)
      await becomeReady()
      expect(release()).toBe('accepted')
      expect(subprocess.written).toEqual([reply, submission])
    }
  )

  it('retains the command across resize, detach and reattach without running it', async () => {
    createSession()
    const client = { onData: vi.fn(), onExit: vi.fn() }
    const first = session.attachClient(client)
    session.resize(120, 40)
    session.detachClient(first)
    await becomeReady()
    session.attachClient(client)
    session.detachAllClients()
    session.attachClient(client)
    expect(subprocess.written).toEqual([])
    expect(release()).toBe('accepted')
    expect(subprocess.written).toEqual([submission])
  })

  it.each(['exit', 'dispose', 'termination'] as const)(
    'prevents release after %s',
    async (stop) => {
      createSession()
      if (stop === 'exit') {
        subprocess.exit()
      }
      if (stop === 'dispose') {
        session.dispose()
      }
      if (stop === 'termination') {
        session.beginTermination()
      }
      expect(release()).not.toBe('accepted')
      await becomeReady()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(subprocess.written).toEqual([])
    }
  )

  it.each(['exit', 'dispose', 'termination'] as const)(
    'does not send an accepted but queued command after %s',
    async (stop) => {
      createSession()
      expect(release()).toBe('accepted')
      if (stop === 'exit') {
        subprocess.exit()
      }
      if (stop === 'dispose') {
        session.dispose()
      }
      if (stop === 'termination') {
        session.beginTermination()
      }
      await becomeReady()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(subprocess.written).toEqual([])
    }
  )

  it('claims release before a subprocess write can synchronously reenter', () => {
    createSession(false)
    const replies: string[] = []
    subprocess.write.mockImplementation((data) => {
      subprocess.written.push(data)
      replies.push(release())
    })
    expect(release()).toBe('accepted')
    expect(replies).toEqual(['accepted'])
    expect(subprocess.written).toEqual([submission])
  })

  it.each(['marker', 'timeout'] as const)(
    'retires an accepted queued launch after a signal before %s',
    async (readiness) => {
      createSession()
      expect(release()).toBe('accepted')
      session.signal('SIGINT')
      expect(subprocess.handle.signal).toHaveBeenCalledWith('SIGINT')
      if (readiness === 'marker') {
        await becomeReady()
      }
      await vi.advanceTimersByTimeAsync(2_000)
      expect(subprocess.written).toEqual([])
      expect(release()).toBe('retired')
      session.write('echo recovered\r')
      expect(subprocess.written).toEqual(['echo recovered\r'])
    }
  )

  it('does not revoke or repeat a command already delivered before a signal', () => {
    createSession(false)
    expect(release()).toBe('accepted')
    session.signal('SIGINT')
    expect(release()).toBe('accepted')
    expect(subprocess.written).toEqual([submission])
  })

  it('does not retry a command when the subprocess writes and then throws', async () => {
    createSession()
    await becomeReady()
    subprocess.write.mockImplementation((data) => {
      subprocess.written.push(data)
      throw new Error('transport reply lost after delivery')
    })
    expect(release()).toBe('unverifiable')
    expect(release()).toBe('unverifiable')
    expect(subprocess.written).toEqual([submission])
  })

  it('records an ambiguous queued write without throwing from the readiness callback or retrying', async () => {
    createSession()
    expect(release()).toBe('accepted')
    subprocess.write.mockImplementation((data) => {
      subprocess.written.push(data)
      throw new Error('transport reply lost after queued delivery')
    })
    await becomeReady()
    expect(release()).toBe('unverifiable')
    expect(release()).toBe('unverifiable')
    expect(subprocess.written).toEqual([submission])
  })
})
