import { activityResult, activityFailure } from '../ActivityResult'
import type { BotContext } from '../../../core/BotContext'
import { executionContext } from '../../../core/ExecutionContext'
import type { Account } from '../../../core/Account'
import { SearchProgress, applyEarnSearchQuota, type SearchQuota } from './SearchProgress'
import type { RewardsState } from '../../types/RewardsState'
import { isSearchCompleted } from '../../../session/SessionStore'

export interface SearchPlan {
    mobileQuotaKnown: boolean
    desktopQuotaKnown: boolean
    quotasAvailable: boolean
    doMobile: boolean
    doDesktop: boolean
    mobileMissing: number
    desktopMissing: number
}

export class SearchManager {
    private readonly progress: SearchProgress

    constructor(private bot: BotContext) {
        this.progress = new SearchProgress(bot)
    }

    async planSearches(data?: RewardsState): Promise<SearchPlan> {
        let counters = data?.dashboard.userStatus.counters ?? (await this.progress.getCounters())
        if (counters.pcSearch === undefined || counters.mobileSearch === undefined) {
            const earnQuota = await this.bot.rewards?.getEarnSearchQuota?.(false)
            counters = applyEarnSearchQuota(counters, earnQuota)
        }
        const quotas = this.progress.calculateQuotas(counters)
        const mobileMissing = quotas.mobile.remaining
        const desktopQuota = this.combineQuotas(quotas.desktop, quotas.edge)
        const desktopMissing = desktopQuota.remaining

        const runOnZero = this.bot.config.searchSettings.runOnZeroPoints
        const email = this.bot.currentAccountEmail
        const localDate = this.bot.utils.formatDate(Date.now(), this.bot.userData.timezone)
        const mobileCachedComplete =
            !runOnZero &&
            !quotas.mobile.available &&
            Boolean(email && isSearchCompleted(this.bot.config.sessionPath, email, true, localDate))
        const desktopCachedComplete =
            !runOnZero &&
            !desktopQuota.available &&
            Boolean(email && isSearchCompleted(this.bot.config.sessionPath, email, false, localDate))

        const doMobile =
            this.bot.config.workers.doMobileSearch &&
            !mobileCachedComplete &&
            (!quotas.mobile.available || mobileMissing > 0 || runOnZero)
        const doDesktop =
            this.bot.config.workers.doDesktopSearch &&
            !desktopCachedComplete &&
            (!desktopQuota.available || desktopMissing > 0 || runOnZero)

        for (const [name, enabled, available, cachedComplete] of [
            [
                'mobile-search-quota',
                this.bot.config.workers.doMobileSearch,
                quotas.mobile.available,
                mobileCachedComplete
            ],
            [
                'desktop-search-quota',
                this.bot.config.workers.doDesktopSearch,
                desktopQuota.available,
                desktopCachedComplete
            ]
        ] as const) {
            if (enabled)
                this.bot.recordActivity(
                    name,
                    activityResult(
                        available ? 'confirmed' : cachedComplete ? 'skipped' : 'confirmed',
                        available ? 'quota-available' : cachedComplete ? 'already-complete' : 'bounded-quota-probe'
                    )
                )
        }

        this.bot.logger.debug(
            'main',
            'SEARCH-MANAGER',
            `Mobile: ${this.describeQuota(this.bot.config.workers.doMobileSearch, quotas.mobile, mobileCachedComplete)}` +
                ` | Desktop: ${this.describeQuota(this.bot.config.workers.doDesktopSearch, desktopQuota, desktopCachedComplete)}` +
                `${quotas.edge.max > 0 ? ` | Edge: ${quotas.edge.earned}/${quotas.edge.max}` : ''}`
        )

        return {
            doMobile,
            doDesktop,
            quotasAvailable: quotas.mobile.available && desktopQuota.available,
            mobileMissing,
            desktopMissing,
            mobileQuotaKnown: quotas.mobile.available,
            desktopQuotaKnown: desktopQuota.available
        }
    }

    private combineQuotas(...quotas: SearchQuota[]): SearchQuota {
        return quotas.reduce(
            (total, quota) => ({
                available: total.available && quota.available,
                earned: total.earned + quota.earned,
                max: total.max + quota.max,
                remaining: total.remaining + quota.remaining
            }),
            { available: true, earned: 0, max: 0, remaining: 0 }
        )
    }

    private describeQuota(enabled: boolean, quota: SearchQuota, cachedComplete = false): string {
        if (enabled && cachedComplete) return 'skip (cached complete today)'
        if (!quota.available)
            return enabled ? 'run (quota unavailable; bounded detection)' : 'skip (disabled, quota unavailable)'
        if (!enabled) return `skip (disabled, ${quota.earned}/${quota.max})`
        if (quota.remaining <= 0 && this.bot.config.searchSettings.runOnZeroPoints)
            return 'run (bounded zero-point searches)'
        if (quota.remaining <= 0) return `skip (complete, ${quota.earned}/${quota.max})`
        return `run (${quota.earned}/${quota.max}, missing ${quota.remaining})`
    }

    searchMobile(account: Account): Promise<number | null> {
        return this.search(account, true)
    }

    searchDesktop(account: Account): Promise<number | null> {
        return this.search(account, false)
    }

    private search(account: Account, isMobile: boolean): Promise<number | null> {
        const platform = isMobile ? 'Mobile' : 'Desktop'
        const page = isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage

        return executionContext.run({ isMobile, account }, async () => {
            try {
                return await this.bot.activities.search(page, isMobile)
            } catch (error) {
                this.bot.recordActivity('search', activityFailure(error))
                this.bot.signal.throwIfAborted()
                this.bot.logger.error(
                    'main',
                    'SEARCH-MANAGER',
                    `${platform} search failed | ${error instanceof Error ? error.message : String(error)}`
                )
                return null
            }
        })
    }

    async bonusMobile(account: Account): Promise<number | null> {
        this.bot.logger.info('main', 'SEARCH-MANAGER', 'Starting bonus searches')

        const gained = await executionContext.run({ isMobile: true, account }, async () => {
            try {
                return await this.bot.activities.searchBonus(this.bot.mainMobilePage)
            } catch (error) {
                this.bot.recordActivity('bonus-search', activityFailure(error))
                this.bot.signal.throwIfAborted()
                this.bot.logger.error(
                    'main',
                    'SEARCH-MANAGER',
                    `Bonus search failed | ${error instanceof Error ? error.message : String(error)}`
                )
                return null
            }
        })

        this.bot.logger.debug(
            'main',
            'SEARCH-MANAGER',
            `Bonus search summary | pointsGained=${gained ?? 'unknown'} | currentBalance=${this.bot.userData.currentPoints}`
        )
        return gained
    }

    logSummary(points: {
        mobile: number | null
        desktop: number | null
        bonus: number | null
        apiReport?: number | null
    }): void {
        const total = Object.values(points).every(value => value !== null)
            ? points.mobile! + points.desktop! + points.bonus! + (points.apiReport ?? 0)
            : null
        this.bot.logger[total !== null && total > 0 ? 'success' : 'info'](
            'main',
            'SEARCH-MANAGER',
            `Search summary | mobile=${points.mobile ?? 'unknown'} | desktop=${points.desktop ?? 'unknown'}` +
                ` | bonus=${points.bonus ?? 'unknown'}` +
                (points.apiReport !== undefined ? ` | apiReport=${points.apiReport ?? 'unknown'}` : '') +
                ` | total=${total ?? 'unknown'}`
        )
    }
}
