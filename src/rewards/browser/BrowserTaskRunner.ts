import { BaseActivity } from '../shared/activities/BaseActivity'
import type { BasePromotion, RewardsState } from '../types/RewardsState'
import { browserOfferKey, browserTaskPass, markConfirmedBrowserOffers } from './BrowserTaskPass'
import { BrowserEarnTasks } from './BrowserEarnTasks'
import { activityFailure, activityResult } from '../shared/ActivityResult'
import { BrowserTaskPage } from '../../browser/BrowserTaskPage'
import { isEligiblePromotion, isPromotionComplete } from '../shared/PromotionEligibility'
import { getMorePromotions, getWebPromotions } from '../shared/Promotion'
import { detectSearchMultiplierPerk } from '../shared/SearchMultiplierPerk'
import { isTerminalHttpError, isTransientNetworkError } from '../../network/HttpError'
import { PromotionRunner } from '../shared/activities/PromotionRunner'
import { selectEarnSweepCandidates } from './EarnSweep'

const FLYOUT_PASS_ATTEMPTS = 2
const EARN_PASS_ATTEMPTS = 3
const PASS_RETRY_DELAYS_MS = [10000, 25000]

export class BrowserTaskRunner extends BaseActivity {
    async run(seed: RewardsState, confirmed = new Set<string>()): Promise<RewardsState> {
        const workers = this.bot.config.workers
        if (
            !workers.doDailySet &&
            !workers.doMorePromotions &&
            !workers.doActivateSearchPerk &&
            !workers.doPunchCards &&
            !workers.doVisualSearch
        )
            return seed
        const source = this.bot.activePage
        if (!source || source.isClosed()) throw new Error('Browser page unavailable for task passes')
        const earn = new BrowserEarnTasks(this.bot)
        let result = seed
        let flyoutCompleted = false
        let earnCompleted = false
        const pending = new Set<string>([
            ...(workers.doPunchCards ? ['punchcards'] : []),
            ...(workers.doVisualSearch && !this.bot.isMobile ? ['visual-search'] : [])
        ])
        try {
            result = await this.withPassRetry('flyout', FLYOUT_PASS_ATTEMPTS, async () => {
                const flyoutTask = await BrowserTaskPage.create(source)
                try {
                    return await browserTaskPass.run(
                        { surface: 'flyout', confirmed, page: flyoutTask.page },
                        async () => {
                            this.bot.logger.info(this.bot.isMobile, 'BROWSER-TASKS', 'Starting flyout task pass')
                            let data = this.rememberCompletedOffers(await this.bot.rewards.getTaskData(), confirmed)
                            const daily = await this.runDailySet(data)
                            data = daily.data
                            const worked = (await this.runRemainingCards(data)) || daily.worked
                            return worked
                                ? this.rememberCompletedOffers(await this.bot.rewards.getTaskData(), confirmed)
                                : data
                        }
                    )
                } finally {
                    await flyoutTask.close()
                }
            })
            flyoutCompleted = true
        } catch (error) {
            this.bot.signal.throwIfAborted()
            if (isTerminalHttpError(error)) throw error
            this.bot.logger.warn(
                this.bot.isMobile,
                'BROWSER-TASKS',
                `Flyout pass failed; checking /earn for remaining tasks | ${String(error)}`
            )
        }

        try {
            result = await this.withPassRetry('earn', EARN_PASS_ATTEMPTS, async attempt => {
                const earnTask = await BrowserTaskPage.createRewards(source, true)
                try {
                    const page = earnTask.page
                    const readEarn = () => earn.read(() => this.bot.rewards.getDashboardData(), page)
                    return await browserTaskPass.run({ surface: 'earn', confirmed, page, readEarn }, async () => {
                        const isLastAttempt = attempt >= EARN_PASS_ATTEMPTS
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'BROWSER-TASKS',
                            `Starting /earn task pass for remaining tasks | attempt=${attempt}/${EARN_PASS_ATTEMPTS}`
                        )
                        let data = this.rememberCompletedOffers(await readEarn(), confirmed)
                        await this.runSection('daily-set', isLastAttempt, async () => {
                            data = (await this.runDailySet(data)).data
                        })
                        if (workers.doPunchCards) {
                            await this.runSection('punchcards', isLastAttempt, async () => {
                                const attempted = this.bot.attemptedPunchcardChildren.size
                                if (this.bot.isMobile) await this.bot.activities.runMobilePunchCards(data)
                                else await this.bot.activities.runDesktopPunchCards()
                                if (this.bot.attemptedPunchcardChildren.size > attempted)
                                    data = markConfirmedBrowserOffers(await readEarn(), confirmed)
                            })
                            pending.delete('punchcards')
                        }
                        await this.runSection('more-promotions', isLastAttempt, async () => {
                            await this.runRemainingCards(data)
                        })
                        if (workers.doVisualSearch && !this.bot.isMobile) {
                            await this.runSection('visual-search', isLastAttempt, async () => {
                                await this.bot.activities.runVisualSearch(data)
                            })
                        }
                        pending.delete('visual-search')

                        data = this.rememberCompletedOffers(await readEarn(), confirmed)
                        await this.runSection('earn-sweep', isLastAttempt, async () => {
                            if (await this.sweepRemainingTasks(data)) {
                                data = this.rememberCompletedOffers(await readEarn(), confirmed)
                            }
                        })
                        this.logRemainingTasks(data)
                        return data
                    })
                } finally {
                    await earnTask.close()
                }
            })
            earnCompleted = true
        } catch (error) {
            this.bot.signal.throwIfAborted()
            if (isTerminalHttpError(error)) throw error
            for (const activity of ['browser-earn', ...pending]) {
                this.bot.recordActivity(activity, {
                    ...activityResult('unconfirmed', 'earn-pass-incomplete'),
                    message:
                        activity === 'visual-search'
                            ? 'Visual Search was not attempted because the earn task pass failed before it started'
                            : 'The earn pass did not finish; tasks available only on /earn remain unconfirmed'
                })
            }
            this.bot.logger.warn(
                this.bot.isMobile,
                'BROWSER-TASKS',
                `/earn pass failed; remaining earn tasks could not finish | ${String(error)}`
            )
        }

        result = this.rememberCompletedOffers(result, confirmed)
        const latest = new Map((this.bot.activityResults ?? []).map(activity => [activity.offerId, activity]))
        for (const [offerId, previous] of latest) {
            if (offerId && confirmed.has(offerId) && ['failed', 'unconfirmed'].includes(previous.status)) {
                this.bot.recordActivity(previous.activity, {
                    ...previous,
                    status: 'confirmed',
                    reason: 'offer-state-confirmed',
                    message: undefined,
                    errorCode: undefined
                })
            }
        }
        this.bot.logger[earnCompleted ? 'info' : 'warn'](
            this.bot.isMobile,
            'BROWSER-TASKS',
            earnCompleted
                ? flyoutCompleted
                    ? 'Completed flyout and earn task passes'
                    : 'Completed /earn fallback after flyout pass failed'
                : flyoutCompleted
                  ? 'Finished flyout; /earn pass remains unconfirmed'
                  : 'Browser task passes remain unconfirmed'
        )
        return result
    }

    /** Re-run a whole task pass on a fresh page when it fails because of a transient network problem. */
    private async withPassRetry<T>(
        pass: 'flyout' | 'earn',
        maxAttempts: number,
        run: (attempt: number) => Promise<T>
    ): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await run(attempt)
            } catch (error) {
                this.bot.signal.throwIfAborted()
                if (isTerminalHttpError(error) || attempt >= maxAttempts || !isTransientNetworkError(error)) throw error
                const delayMs = PASS_RETRY_DELAYS_MS[attempt - 1] ?? PASS_RETRY_DELAYS_MS.at(-1)!
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BROWSER-TASKS',
                    `${pass === 'earn' ? '/earn' : 'Flyout'} pass hit a transient network error; retrying` +
                        ` | attempt=${attempt}/${maxAttempts} | retryInMs=${delayMs} | ${String(error).split(/\r?\n/, 1)[0]}`
                )
                await this.bot.utils.wait(delayMs)
            }
        }
    }

    /**
     * Run one /earn section so that a failure does not cancel the sections after it.
     * Transient network errors are rethrown (except on the final attempt) so the whole pass can retry on a fresh page.
     */
    private async runSection(name: string, isLastAttempt: boolean, run: () => Promise<void>): Promise<void> {
        try {
            await run()
        } catch (error) {
            this.bot.signal.throwIfAborted()
            if (isTerminalHttpError(error)) throw error
            if (!isLastAttempt && isTransientNetworkError(error)) throw error
            this.bot.recordActivity(name, activityFailure(error))
            this.bot.logger.warn(
                this.bot.isMobile,
                'BROWSER-TASKS',
                `/earn section failed; continuing with the remaining sections | section=${name} | ${String(error).split(/\r?\n/, 1)[0]}`
            )
        }
    }

    private pendingEarnTasks(data: RewardsState): { daily: BasePromotion[]; more: BasePromotion[] } {
        const workers = this.bot.config.workers
        const skipNonPointTasks = this.bot.config.skipNonPointTasks
        const today = this.bot.utils.formatDate(Date.now(), this.bot.userData.timezone)
        return {
            daily: workers.doDailySet
                ? (data.dashboard.dailySetPromotions[today] ?? []).filter(item =>
                      isEligiblePromotion(item, skipNonPointTasks)
                  )
                : [],
            more: workers.doMorePromotions
                ? getMorePromotions(data.dashboard).filter(item => isEligiblePromotion(item, skipNonPointTasks))
                : []
        }
    }

    /** Give every still-incomplete earn task that failed, stayed unconfirmed or was never attempted one more try. */
    private async sweepRemainingTasks(data: RewardsState): Promise<boolean> {
        const latest = new Map<string, (typeof this.bot.activityResults)[number]>()
        for (const result of this.bot.activityResults ?? []) {
            if (result.offerId) latest.set(result.offerId, result)
        }
        const latestStatus = (offerId: string) => latest.get(offerId)?.status
        const pending = this.pendingEarnTasks(data)
        const daily = selectEarnSweepCandidates(pending.daily, latestStatus)
        const more = selectEarnSweepCandidates(
            pending.more.filter(item => !daily.some(task => task.offerId === item.offerId)),
            latestStatus
        )
        if (!daily.length && !more.length) return false

        this.bot.logger.info(
            this.bot.isMobile,
            'BROWSER-TASKS',
            `Retrying earn tasks left incomplete after the first pass | dailySet=${daily.length} | more=${more.length}` +
                ` | tasks=${[...daily, ...more].map(item => `"${item.title}"`).join(', ')}`
        )
        const runner = new PromotionRunner(this.bot)
        if (daily.length) await runner.run(daily, 'daily-set')
        if (more.length) await runner.run(more, 'more-promotions')
        return true
    }

    private logRemainingTasks(data: RewardsState): void {
        const pending = this.pendingEarnTasks(data)
        const remaining = [...pending.daily, ...pending.more]
        if (!remaining.length) {
            this.bot.logger.info(this.bot.isMobile, 'BROWSER-TASKS', 'No eligible earn tasks remain incomplete')
            return
        }
        this.bot.logger.warn(
            this.bot.isMobile,
            'BROWSER-TASKS',
            `Earn tasks still incomplete after retry | count=${remaining.length}` +
                ` | tasks=${remaining.map(item => `"${item.title}" (${item.offerId})`).join(', ')}`
        )
    }

    private rememberCompletedOffers(data: RewardsState, confirmed: Set<string>): RewardsState {
        for (const offer of getWebPromotions(data.dashboard)) {
            if (!isPromotionComplete(offer)) continue
            confirmed.add(offer.offerId)
            confirmed.add(browserOfferKey(offer))
        }
        return markConfirmedBrowserOffers(data, confirmed)
    }

    private async runDailySet(data: RewardsState): Promise<{ data: RewardsState; worked: boolean }> {
        const workers = this.bot.config.workers
        const today = this.bot.utils.formatDate(Date.now(), this.bot.userData.timezone)
        const hasDaily = Boolean(
            workers.doDailySet &&
            data.dashboard.dailySetPromotions[today]?.some(item =>
                isEligiblePromotion(item, this.bot.config.skipNonPointTasks)
            )
        )

        if (hasDaily) {
            data = markConfirmedBrowserOffers(
                await this.bot.activities.runDailySet(data),
                browserTaskPass.getStore()!.confirmed
            )
        }
        return { data, worked: hasDaily }
    }

    private async runRemainingCards(data: RewardsState): Promise<boolean> {
        const workers = this.bot.config.workers
        const hasMore = Boolean(
            workers.doMorePromotions &&
            [...data.dashboard.morePromotions, ...data.dashboard.morePromotionsWithoutPromotionalItems].some(item =>
                isEligiblePromotion(item, this.bot.config.skipNonPointTasks)
            )
        )
        if (workers.doActivateSearchPerk) await this.bot.activities.activateSearchPerk(data)
        if (workers.doMorePromotions) await this.bot.activities.runMorePromotions(data)
        return hasMore || (workers.doActivateSearchPerk && !!detectSearchMultiplierPerk(data.dashboard))
    }
}
