import type { ActivityStatus } from '../types/ActivityResult'
import type { BasePromotion } from '../types/RewardsState'

/** Statuses that justify one more attempt during the final /earn sweep. */
const RETRYABLE_STATUSES: ReadonlySet<ActivityStatus> = new Set(['failed', 'unconfirmed'])

/**
 * Choose the still-eligible earn tasks worth a single retry: tasks never attempted in this run
 * (for example cards rendered after the first pass) and tasks whose latest outcome failed or stayed unconfirmed.
 * Tasks deliberately skipped (no points, excluded, already complete) are left alone.
 */
export function selectEarnSweepCandidates(
    pending: readonly BasePromotion[],
    latestStatus: (offerId: string) => ActivityStatus | undefined
): BasePromotion[] {
    const seen = new Set<string>()
    return pending.filter(promotion => {
        if (seen.has(promotion.offerId)) return false
        seen.add(promotion.offerId)
        const status = latestStatus(promotion.offerId)
        return status === undefined || RETRYABLE_STATUSES.has(status)
    })
}
