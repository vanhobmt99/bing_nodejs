export function retryAfterMs(value: string | string[] | undefined, now = Date.now()): number | undefined {
    const text = Array.isArray(value) ? value[0] : value
    if (!text?.trim()) return undefined
    if (/^\d+(?:\.\d+)?$/.test(text.trim())) return Math.ceil(Number(text) * 1000)
    const date = Date.parse(text)
    return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export class HttpError extends Error {
    readonly retryAfterMs: number | undefined

    constructor(
        readonly status: number,
        readonly response: { status: number; headers: Record<string, string | string[]> },
        message = `Request failed with status code ${status}`
    ) {
        super(message)
        this.name = 'HttpError'
        this.retryAfterMs = retryAfterMs(response.headers['retry-after'])
    }
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 500, 502, 503, 504])
const TRANSIENT_BROWSER_NET_ERROR_RE =
    /net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_ABORTED|CONNECTION_REFUSED|TIMED_OUT|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|HTTP2_PROTOCOL_ERROR)\b/i
const TRANSIENT_NODE_ERROR_CODES = new Set([
    'NO_RESPONSE',
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN'
])
const TRANSIENT_TRANSPORT_MESSAGE_RE = /\btcp connect error\b|\bsocket hang up\b|\bconnection reset\b/i

export function isTerminalHttpError(error: unknown): boolean {
    const status = (error as { status?: number })?.status
    return status === 401 || status === 403 || status === 429
}

/** Whether a browser network error string indicates a transient transport failure safe to retry. */
export function isTransientBrowserNetworkError(value: string): boolean {
    return TRANSIENT_BROWSER_NET_ERROR_RE.test(value)
}

/** Whether an error represents a transient transport or server failure rather than a terminal rejection. */
export function isTransientNetworkError(error: unknown): boolean {
    if (error instanceof AggregateError) return error.errors.some(isTransientNetworkError)
    if (error instanceof HttpError) return TRANSIENT_HTTP_STATUSES.has(error.status)
    if (isTerminalHttpError(error)) return false
    if (!error || typeof error !== 'object') {
        return typeof error === 'string' && isTransientBrowserNetworkError(error)
    }
    const candidate = error as {
        blockedDirective?: unknown
        transientFetch?: unknown
        code?: unknown
        name?: unknown
        message?: unknown
        networkError?: unknown
    }
    if (candidate.blockedDirective) return false
    if (candidate.transientFetch === true) return true
    if (typeof candidate.code === 'string' && TRANSIENT_NODE_ERROR_CODES.has(candidate.code)) return true
    if (candidate.name === 'TimeoutError') return true
    if (typeof candidate.networkError === 'string' && isTransientBrowserNetworkError(candidate.networkError))
        return true
    const message =
        error instanceof Error ? error.message : typeof candidate.message === 'string' ? candidate.message : ''
    return isTransientBrowserNetworkError(message) || TRANSIENT_TRANSPORT_MESSAGE_RE.test(message)
}
