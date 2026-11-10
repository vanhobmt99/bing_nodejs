import type { DomainEvent, LogEvent } from './LogEvent'

export function eventLogLevel(data?: DomainEvent): LogEvent['level'] {
    if (!data || data.kind === 'balance' || data.kind === 'account-info' || data.kind === 'punchcard') return 'debug'
    if (data.kind === 'quota') return 'info'
    if (data.kind === 'search-diagnostic') {
        if (data.status === 'failed') return 'error'
        return ['unverified', 'unavailable', 'no-credit', 'unknown'].includes(data.status) ? 'warn' : 'info'
    }
    if (data.kind === 'activity') {
        if (data.activity === 'doEnsureStreakProtection' && data.status !== 'confirmed' && data.status !== 'skipped')
            return 'warn'
        if (data.status === 'failed') return 'error'
        if (data.status === 'unconfirmed') return 'warn'
        if (data.status === 'skipped') return data.category === 'unavailable' ? 'info' : 'debug'
        return data.activity.endsWith('-data') || data.activity.endsWith('-quota') ? 'debug' : 'info'
    }
    if (data.kind === 'run') {
        if (data.status === 'interrupted') return 'error'
        return data.status === 'partial' ? 'warn' : 'info'
    }
    if (data.status === 'failed') return 'error'
    return data.status === 'completed' || data.status === 'running' ? 'info' : 'warn'
}
