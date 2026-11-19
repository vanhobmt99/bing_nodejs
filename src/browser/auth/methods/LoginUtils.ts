import cluster, { type Worker } from 'node:cluster'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import type { Page } from 'patchright'
import { getCurrentContext } from '../../../core/ExecutionContext'

export interface PromptOptions {
    question: string
    timeoutSeconds?: number
    validate?: (input: string) => boolean
    transform?: (input: string) => string
    signal?: AbortSignal
}

export interface StdinPromptIO {
    input: NodeJS.ReadableStream & {
        isTTY?: boolean
        destroyed?: boolean
        readable?: boolean
        readableEnded?: boolean
        ref?: () => void
        unref?: () => void
    }
    output: NodeJS.WritableStream
    env?: NodeJS.ProcessEnv
}

interface PipeReaderState {
    buffer: string
    decoder: StringDecoder
}

interface StdinPromptRequestMessage {
    __stdinPrompt: {
        id: string
        question: string
        timeoutSeconds: number
    }
}

interface StdinPromptCancelMessage {
    __stdinPromptCancel: {
        id: string
    }
}

interface StdinPromptResultMessage {
    __stdinPromptResult: {
        id: string
        value: string | null
    }
}

const RELAY_ENV_KEY = 'INTERACTIVE_STDIN_RELAY'
const pipeStates = new WeakMap<NodeJS.ReadableStream, PipeReaderState>()
const promptQueues = new WeakMap<NodeJS.ReadableStream, Promise<void>>()

let activeRelayTeardown: (() => void) | null = null

export function isInteractiveStdinEnv(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.INTERACTIVE_STDIN?.trim().toLowerCase()
    return raw === 'true' || raw === '1'
}

function isInteractiveProcessStdinFd(): boolean {
    try {
        const stat = fs.fstatSync(0)
        // Exclude /dev/null (POSIX) and NUL (Windows), which report as non-TTY character devices.
        return !stat.isCharacterDevice() && !stat.isDirectory()
    } catch {
        return false
    }
}

function isWorkerRelayAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return cluster.isWorker && env[RELAY_ENV_KEY] === '1' && typeof process.send === 'function'
}

export function canPromptForInput(io?: Pick<StdinPromptIO, 'input' | 'env'>): boolean {
    const env = io?.env ?? process.env
    if (!io && isWorkerRelayAvailable(env)) return true

    const input = io?.input ?? process.stdin
    if (input.destroyed || input.readableEnded) return false
    if (input.isTTY === true) return true
    if (!isInteractiveStdinEnv(env)) return false
    if (input === process.stdin) return isInteractiveProcessStdinFd()
    return input.readable !== false
}

function formatPromptQuestion(question: string): string {
    const ctx = getCurrentContext()
    if (!ctx?.account?.email) return question
    const platform = ctx.isMobile ? 'MOBILE' : 'DESKTOP'
    return `[${ctx.account.email} | ${platform}] ${question}`
}

function serializePrompt<T>(stream: NodeJS.ReadableStream, task: () => Promise<T>): Promise<T> {
    const previous = promptQueues.get(stream) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    promptQueues.set(
        stream,
        next.then(
            () => undefined,
            () => undefined
        )
    )
    return next
}

function readTtyLine(
    input: StdinPromptIO['input'],
    output: NodeJS.WritableStream,
    question: string,
    timeoutSeconds: number,
    signal?: AbortSignal
): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null)

    return new Promise(resolve => {
        const rl = readline.createInterface({ input, output })
        let settled = false

        const cleanup = (result: string | null) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            rl.close()
            resolve(result)
        }

        const onAbort = () => cleanup(null)
        const timer = setTimeout(() => cleanup(null), timeoutSeconds * 1000)

        rl.once('close', () => cleanup(null))
        signal?.addEventListener('abort', onAbort, { once: true })
        rl.question(question, answer => cleanup(answer))
    })
}

function readPipeLine(
    input: StdinPromptIO['input'],
    output: NodeJS.WritableStream,
    question: string,
    timeoutSeconds: number,
    signal?: AbortSignal
): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null)

    // Emit a trailing newline in non-TTY mode so line-buffered Docker logs flush the prompt immediately.
    output.write(question.endsWith('\n') ? question : `${question}\n`)

    let state = pipeStates.get(input)
    if (!state) {
        state = { buffer: '', decoder: new StringDecoder('utf8') }
        pipeStates.set(input, state)
    }

    const takeLine = (): string | null => {
        const newlineIndex = state.buffer.indexOf('\n')
        if (newlineIndex === -1) return null
        const line = state.buffer.slice(0, newlineIndex).replace(/\r$/, '')
        state.buffer = state.buffer.slice(newlineIndex + 1)
        return line
    }

    const buffered = takeLine()
    if (buffered !== null) return Promise.resolve(buffered)

    if (input.destroyed || input.readableEnded) {
        state.buffer += state.decoder.end()
        if (!state.buffer.length) return Promise.resolve(null)
        const remaining = state.buffer.replace(/\r$/, '')
        state.buffer = ''
        return Promise.resolve(remaining)
    }

    return new Promise(resolve => {
        let settled = false

        const cleanup = (result: string | null) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            input.off('data', onData)
            input.off('end', onEnd)
            input.off('close', onClose)
            input.off('error', onError)
            signal?.removeEventListener('abort', onAbort)
            if (!input.destroyed && !input.readableEnded) {
                input.pause()
                input.unref?.()
            }
            resolve(result)
        }

        const onData = (chunk: Buffer | string) => {
            state.buffer += typeof chunk === 'string' ? chunk : state.decoder.write(chunk)
            const line = takeLine()
            if (line !== null) cleanup(line)
        }

        const onEnd = () => {
            state.buffer += state.decoder.end()
            if (state.buffer.length > 0) {
                const remaining = state.buffer.replace(/\r$/, '')
                state.buffer = ''
                cleanup(remaining)
                return
            }
            cleanup(null)
        }

        const onClose = () => cleanup(null)
        const onError = () => cleanup(null)
        const onAbort = () => cleanup(null)
        const timer = setTimeout(() => cleanup(null), timeoutSeconds * 1000)

        input.on('data', onData)
        input.once('end', onEnd)
        input.once('close', onClose)
        input.once('error', onError)
        signal?.addEventListener('abort', onAbort, { once: true })
        input.ref?.()
        input.resume()
    })
}

function readRawPromptLine(
    question: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
    io?: StdinPromptIO
): Promise<string | null> {
    const input = io?.input ?? process.stdin
    const output = io?.output ?? process.stdout
    return serializePrompt(input, () => {
        if (!canPromptForInput({ input, env: io?.env })) return Promise.resolve(null)
        return input.isTTY === true
            ? readTtyLine(input, output, question, timeoutSeconds, signal)
            : readPipeLine(input, output, question, timeoutSeconds, signal)
    })
}

function isPromptResultMessage(message: unknown): message is StdinPromptResultMessage {
    if (!message || typeof message !== 'object' || !('__stdinPromptResult' in message)) return false
    const payload = (message as { __stdinPromptResult?: unknown }).__stdinPromptResult
    return Boolean(
        payload &&
        typeof payload === 'object' &&
        typeof (payload as { id?: unknown }).id === 'string' &&
        ((payload as { value?: unknown }).value === null || typeof (payload as { value?: unknown }).value === 'string')
    )
}

function isPromptRequestMessage(message: unknown): message is StdinPromptRequestMessage {
    if (!message || typeof message !== 'object' || !('__stdinPrompt' in message)) return false
    const payload = (message as { __stdinPrompt?: unknown }).__stdinPrompt
    return Boolean(
        payload &&
        typeof payload === 'object' &&
        typeof (payload as { id?: unknown }).id === 'string' &&
        typeof (payload as { question?: unknown }).question === 'string' &&
        typeof (payload as { timeoutSeconds?: unknown }).timeoutSeconds === 'number'
    )
}

function isPromptCancelMessage(message: unknown): message is StdinPromptCancelMessage {
    if (!message || typeof message !== 'object' || !('__stdinPromptCancel' in message)) return false
    const payload = (message as { __stdinPromptCancel?: unknown }).__stdinPromptCancel
    return Boolean(payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string')
}

function requestPromptViaIpc(question: string, timeoutSeconds: number, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted || typeof process.send !== 'function') return Promise.resolve(null)

    const id = randomUUID()
    return new Promise(resolve => {
        let settled = false
        const cleanup = (value: string | null) => {
            if (settled) return
            settled = true
            process.off('message', onMessage)
            process.off('disconnect', onDisconnect)
            signal?.removeEventListener('abort', onAbort)
            resolve(value)
        }

        const onMessage = (message: unknown) => {
            if (!isPromptResultMessage(message) || message.__stdinPromptResult.id !== id) return
            cleanup(message.__stdinPromptResult.value)
        }

        const onDisconnect = () => cleanup(null)
        const onAbort = () => {
            if (process.connected) {
                process.send?.({ __stdinPromptCancel: { id } }, () => undefined)
            }
            cleanup(null)
        }

        process.on('message', onMessage)
        process.once('disconnect', onDisconnect)
        signal?.addEventListener('abort', onAbort, { once: true })

        process.send?.({ __stdinPrompt: { id, question, timeoutSeconds } }, error => {
            if (error) cleanup(null)
        })
    })
}

export function installClusterStdinRelay(signal?: AbortSignal, io?: StdinPromptIO): void {
    if (!cluster.isPrimary) return
    teardownClusterStdinRelay()
    if (!canPromptForInput(io)) return

    const previousEnv = process.env[RELAY_ENV_KEY]
    process.env[RELAY_ENV_KEY] = '1'

    const workerCleanups = new Set<() => void>()

    const attachWorker = (worker: Worker) => {
        const controllers = new Map<string, AbortController>()

        const cancelAll = () => {
            for (const controller of controllers.values()) controller.abort()
            controllers.clear()
        }

        const onMessage = (message: unknown) => {
            if (isPromptCancelMessage(message)) {
                controllers.get(message.__stdinPromptCancel.id)?.abort()
                return
            }
            if (!isPromptRequestMessage(message)) return

            const { id, question, timeoutSeconds } = message.__stdinPrompt
            const controller = new AbortController()
            controllers.set(id, controller)

            const onParentAbort = () => controller.abort()
            if (signal?.aborted) controller.abort()
            else signal?.addEventListener('abort', onParentAbort, { once: true })

            void readRawPromptLine(question, timeoutSeconds, controller.signal, io).then(value => {
                controllers.delete(id)
                signal?.removeEventListener('abort', onParentAbort)
                if (worker.isConnected()) {
                    worker.send({ __stdinPromptResult: { id, value } }, () => undefined)
                }
            })
        }

        const detach = () => {
            cancelAll()
            worker.off('message', onMessage)
            worker.off('exit', detach)
            worker.off('disconnect', detach)
            workerCleanups.delete(detach)
        }

        worker.on('message', onMessage)
        worker.once('exit', detach)
        worker.once('disconnect', detach)
        workerCleanups.add(detach)
    }

    const onFork = (worker: Worker) => attachWorker(worker)
    cluster.on('fork', onFork)
    for (const worker of Object.values(cluster.workers ?? {})) {
        if (worker && !worker.isDead()) attachWorker(worker)
    }

    activeRelayTeardown = () => {
        cluster.off('fork', onFork)
        for (const detach of [...workerCleanups]) detach()
        if (previousEnv === undefined) delete process.env[RELAY_ENV_KEY]
        else process.env[RELAY_ENV_KEY] = previousEnv
        activeRelayTeardown = null
    }
}

export function teardownClusterStdinRelay(): void {
    activeRelayTeardown?.()
}

export async function promptInput(options: PromptOptions, io?: StdinPromptIO): Promise<string | null> {
    if (!canPromptForInput(io)) return null

    const { question, timeoutSeconds = 60, validate, transform, signal } = options
    const formattedQuestion = formatPromptQuestion(question)

    const raw =
        !io && isWorkerRelayAvailable()
            ? await requestPromptViaIpc(formattedQuestion, timeoutSeconds, signal)
            : await readRawPromptLine(formattedQuestion, timeoutSeconds, signal, io)

    if (raw === null) return null

    let value = raw.trim()
    if (transform) value = transform(value)
    if (validate && !validate(value)) return null
    return value
}

export async function getSubtitleMessage(page: Page): Promise<string | null> {
    const message = await page
        .waitForSelector('[data-testid="subtitle"], div#oneTimeCodeDescription, [data-testid="description"]', {
            state: 'visible',
            timeout: 1000
        })
        .catch(() => null)

    if (!message) return null

    const text = await message.innerText()
    return text.trim()
}

export async function getErrorMessage(page: Page): Promise<string | null> {
    const errorAlert = await page
        .waitForSelector('div[role="alert"]', { state: 'visible', timeout: 1000 })
        .catch(() => null)

    if (!errorAlert) return null

    const text = await errorAlert.innerText()
    return text.trim()
}

export async function waitForInputResponse(page: Page, selector: string, timeout: number): Promise<void> {
    await page.waitForFunction(
        inputSelector => {
            const visible = (element: Element) => {
                const style = getComputedStyle(element)
                return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
            }
            const inputVisible = [...document.querySelectorAll(inputSelector)].some(visible)
            const errorVisible = [...document.querySelectorAll('div[role="alert"]')].some(
                element => visible(element) && Boolean(element.textContent?.trim())
            )
            return !inputVisible || errorVisible
        },
        selector,
        { timeout }
    )
}
