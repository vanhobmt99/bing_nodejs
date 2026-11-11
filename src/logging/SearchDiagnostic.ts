import type { BotContext } from '../core/BotContext'

export const SEARCH_DIAGNOSTIC_STAGES = ['signin', 'quota', 'query', 'progress', 'outcome'] as const
export const SEARCH_DIAGNOSTIC_STATUSES = [
    'started',
    'verified',
    'unverified',
    'available',
    'unavailable',
    'submitted',
    'credited',
    'no-credit',
    'unknown',
    'completed',
    'stopped',
    'failed',
    'skipped'
] as const

export interface SearchDiagnostic {
    kind: 'search-diagnostic'
    stage: (typeof SEARCH_DIAGNOSTIC_STAGES)[number]
    status: (typeof SEARCH_DIAGNOSTIC_STATUSES)[number]
    reason: string
    source?: string
    errorCode?: string
    attempt?: number
    searches?: number
    stagnant?: number
    stagnantLimit?: number
    quotaAvailable?: boolean
    earned?: number | null
    remaining?: number | null
    max?: number | null
    pointsGained?: number | null
    batchPoints?: number | null
    balance?: number | null
}

export function logSearchDiagnostic(
    bot: Pick<BotContext, 'logger'>,
    isMobile: boolean,
    data: Omit<SearchDiagnostic, 'kind'>
): void {
    const message = Object.entries(data)
        .map(([key, value]) => `${key}=${value ?? 'unknown'}`)
        .join(' | ')
    bot.logger.event(isMobile, 'SEARCH-DIAGNOSTIC', message, { kind: 'search-diagnostic', ...data })
}
