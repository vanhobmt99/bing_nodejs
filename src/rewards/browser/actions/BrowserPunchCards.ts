import { OfferVerifier, type OfferReport } from '../../shared/OfferVerifier'
import { ActivitySkipError, activityFailure, activityResult } from '../../shared/ActivityResult'
import { browserTimeout } from '../../../browser/BrowserTiming'
import { BrowserTaskPage } from '../../../browser/BrowserTaskPage'
import type { Locator, Page } from 'patchright'

import { URLs } from '../../../constants/urls'
import { BaseActivity } from '../../shared/activities/BaseActivity'
import { isEligiblePunchCard, isSkippedOffer } from '../../shared/PromotionEligibility'
import { runTaskWithDelay } from '../../shared/TaskPacing'
import { browserOfferKey, browserTaskPass } from '../BrowserTaskPass'
import {
    PUNCHCARD_LINKS,
    readPunchCardParents,
    readPunchCardPage,
    readPunchCardStepCandidateMeta,
    selectUniquePunchCardStepCandidate,
    type RenderedPunchCard,
    type RenderedPunchCardStep
} from '../parsers/PunchCardPageParser'
import { BrowserRewardNavigator } from './BrowserRewardNavigator'
import { observePunchCard } from '../../shared/PunchCardProgress'
import { HttpError, isTransientNetworkError } from '../../../network/HttpError'

const QUEST_LOAD_ATTEMPTS = 3
const PUNCHCARD_RETRY_DELAY_MS = 10000

export class BrowserPunchCards extends BaseActivity {
    private readonly navigator = new BrowserRewardNavigator(this.bot)

    async run(): Promise<void> {
        const sourcePage = browserTaskPass.getStore()?.page ?? this.navigator.getActivePage()
        if (!sourcePage || sourcePage.isClosed()) {
            this.bot.recordActivity('punchcards', activityResult('unconfirmed', 'browser-unavailable'))
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD-BROWSER', 'Browser page unavailable')
            return
        }

        let task: BrowserTaskPage | undefined
        try {
            await this.navigator.openEarn(sourcePage)
            const observedParents = await readPunchCardParents(sourcePage)
            for (const parent of observedParents) observePunchCard(this.bot, parent)
            const parents = observedParents.filter(parent =>
                isEligiblePunchCard(parent, this.bot.config.skipNonPointTasks)
            )
            if (!parents.length) {
                this.bot.logger.debug(this.bot.isMobile, 'PUNCHCARD-BROWSER', 'No eligible incomplete punchcards')
                return
            }

            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD-BROWSER', `Found ${parents.length} incomplete quest(s)`)

            task = await BrowserTaskPage.createRewards(sourcePage)
            const retry: RenderedPunchCard[] = []
            for (const parent of parents) {
                try {
                    await this.solveParent(task.page, parent)
                } catch (error) {
                    this.bot.signal.throwIfAborted()
                    if (isTransientNetworkError(error)) {
                        retry.push(parent)
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'PUNCHCARD-BROWSER',
                            `Quest hit a transient network error; it will be retried after the other quests | offerId=${parent.offerId} | ${String(error).split(/\r?\n/, 1)[0]}`
                        )
                        continue
                    }
                    this.recordQuestFailure(parent, error)
                }
            }
            if (retry.length) {
                await this.bot.utils.wait(PUNCHCARD_RETRY_DELAY_MS)
                if (task.page.isClosed()) {
                    await task.close()
                    task = await BrowserTaskPage.createRewards(sourcePage)
                }
                for (const parent of retry) {
                    try {
                        await this.solveParent(task.page, parent)
                    } catch (error) {
                        this.bot.signal.throwIfAborted()
                        this.recordQuestFailure(parent, error)
                    }
                }
            }
        } catch (error) {
            this.bot.recordActivity('punchcards', activityFailure(error))
            this.bot.signal.throwIfAborted()
            this.bot.logger.error(
                this.bot.isMobile,
                'PUNCHCARD-BROWSER',
                `Browser punchcards failed | ${String(error)}`
            )
        } finally {
            await task?.close()
        }
    }

    private recordQuestFailure(parent: RenderedPunchCard, error: unknown): void {
        this.bot.recordActivity('punchcard', activityFailure(error, parent.offerId))
        this.bot.logger.error(
            this.bot.isMobile,
            'PUNCHCARD-BROWSER',
            `Quest failed | offerId=${parent.offerId} | ${String(error)}`
        )
    }

    private async gotoQuest(page: Page, questUrl: string): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            this.bot.signal.throwIfAborted()
            try {
                const response = await page.goto(questUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: browserTimeout(this.bot, 'navigation')
                })
                if (!response) {
                    throw Object.assign(new Error('Quest returned no response'), { code: 'NO_RESPONSE' })
                }
                if (!response.ok()) {
                    const status = response.status()
                    throw new HttpError(
                        status,
                        { status, headers: response.headers() },
                        `Quest returned status ${status}`
                    )
                }
                return
            } catch (error) {
                this.bot.signal.throwIfAborted()
                if (attempt >= QUEST_LOAD_ATTEMPTS || page.isClosed() || !isTransientNetworkError(error)) throw error
                const delayMs = 2000 * attempt
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'PUNCHCARD-BROWSER',
                    `Quest page load failed; retrying | attempt=${attempt}/${QUEST_LOAD_ATTEMPTS} | retryInMs=${delayMs} | ${String(error).split(/\r?\n/, 1)[0]}`
                )
                await this.bot.utils.wait(delayMs)
            }
        }
    }

    private async solveParent(page: Page, parent: RenderedPunchCard): Promise<void> {
        await this.navigator.openEarn(page)
        const link = await this.navigator.findControl(
            page,
            {
                destination: parent.destination,
                offerId: parent.offerId,
                title: parent.title
            },
            PUNCHCARD_LINKS
        )
        if (!link) {
            this.bot.recordActivity(
                'punchcard',
                activityResult('unconfirmed', 'rendered-control-not-found', parent.offerId)
            )
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD-BROWSER',
                `Quest card disappeared before it could be opened | offerId=${parent.offerId}`
            )
            return
        }

        const opened = await this.navigator.click(page, link)
        try {
            await this.solveChildren(opened.page, parent)
        } finally {
            await opened.close()
        }

        const newBalance = await this.bot.rewards.getCurrentPoints()
        this.bot.logger.debug(
            this.bot.isMobile,
            'PUNCHCARD-BROWSER',
            `Quest processed | offerId=${parent.offerId} | currentBalance=${newBalance}`
        )
    }

    private async readQuest(page: Page, parent: RenderedPunchCard, refresh = false) {
        await page.bringToFront()
        const questUrl = URLs.rewards.quest(parent.offerId)
        if (refresh || page.url().split(/[?#]/)[0] !== questUrl) {
            await this.gotoQuest(page, questUrl)
        }
        await this.bot.browser.utils.dismissMessages(page)
        await page.locator('main').waitFor({ state: 'attached', timeout: browserTimeout(this.bot) })
        await page.waitForFunction(
            () => {
                const main = document.querySelector('main')
                return (
                    Boolean(
                        main?.querySelector('h3') ||
                        [...(main?.querySelectorAll('p') ?? [])].some(element =>
                            /\d+\s*\/\s*\d+\s+tasks?/i.test(element.textContent ?? '')
                        )
                    ) &&
                    ![...(main?.querySelectorAll('.animate-pulse, [aria-busy="true"]') ?? [])].some(
                        element => element.getClientRects().length > 0
                    )
                )
            },
            undefined,
            { timeout: browserTimeout(this.bot, 'navigation'), polling: 250 }
        )
        const state = await readPunchCardPage(page)
        try {
            this.bot.pageParser.snapshotQuestPage(await page.content(), parent)
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'PUNCHCARD-BROWSER',
                `Quest metadata unavailable | ${String(error)}`
            )
        }
        observePunchCard(
            this.bot,
            { ...parent, completedSteps: state.completed, totalSteps: state.total ?? parent.totalSteps },
            state.steps.map(step => ({ complete: step.complete, locked: step.disabled }))
        )
        return state
    }

    private stepKey(child: RenderedPunchCardStep): string {
        return (
            child.offerId ??
            browserOfferKey({
                title: child.title,
                description: '',
                destinationUrl: child.destination
            })
        )
    }

    private async solveChildren(page: Page, parent: RenderedPunchCard): Promise<void> {
        const seen = new Set<string>()
        let state = await this.readQuest(page, parent)
        for (let pass = 0; pass < 30; pass++) {
            const progress = `${state.completed ?? '?'}/${state.total ?? '?'}`
            if (state.total && state.completed !== null && state.completed >= state.total) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD-BROWSER',
                    `Quest complete | offerId=${parent.offerId} | progress=${progress}`
                )
                return
            }
            const child = state.steps.find(step => {
                const key = this.stepKey(step)
                return (
                    !step.complete &&
                    !step.disabled &&
                    !isSkippedOffer(step.offerId, step.destination) &&
                    !seen.has(key) &&
                    !this.bot.attemptedPunchcardChildren.has(`${parent.offerId}:${key}`)
                )
            })
            if (!child) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD-BROWSER',
                    `No further available steps | offerId=${parent.offerId} | progress=${progress}` +
                        ` | lockedOrDisabled=${state.steps.filter(step => !step.complete && step.disabled).length}` +
                        ' | remaining steps will be checked on the next run'
                )
                return
            }

            const key = this.stepKey(child)
            seen.add(key)
            if (this.isClaimChild(child) && !this.bot.config.autoClaimPunchcardRewards) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD-BROWSER',
                    `Reward is ready for manual redemption | quest=${parent.offerId} | step="${child.title}"`
                )
                continue
            }
            const control = await this.resolveStepControl(page, child).catch((error: unknown) => {
                if (!(error instanceof ActivitySkipError)) throw error
                // Skip only this step; the remaining steps of the quest can still be completed.
                this.bot.recordActivity('punchcard-child', activityFailure(error, key))
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'PUNCHCARD-BROWSER',
                    `Step skipped; continuing with the next step | quest=${parent.offerId} | step="${child.title}" | ${error.message}`
                )
                return undefined
            })
            if (control === undefined) continue
            if (!control) {
                this.bot.recordActivity(
                    'punchcard-child',
                    activityResult('unconfirmed', 'rendered-control-not-found', key)
                )
                continue
            }

            const before = state.completed
            const verifier = new OfferVerifier(this.bot, child.offerId ?? key)
            if (await verifier.capture()) {
                this.bot.recordActivity(
                    'punchcard-child',
                    activityResult('skipped', 'already-complete', child.offerId ?? key)
                )
                continue
            }
            const confirmed = () =>
                (before !== null && state.completed !== null && state.completed > before) ||
                state.steps.some(step => this.stepKey(step) === key && step.complete)
            const result = await runTaskWithDelay(
                this.bot,
                async () => {
                    let report: OfferReport | undefined
                    this.bot.attemptedPunchcardChildren.add(`${parent.offerId}:${key}`)
                    try {
                        const clicked = await this.navigator.click(page, control, child.offerId ?? undefined)
                        report = clicked.activityReport ?? undefined
                        await clicked.close()
                    } catch (error) {
                        this.bot.signal.throwIfAborted()
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'PUNCHCARD-BROWSER',
                            `Step click failed; refreshing its state | step="${child.title}" | ${String(error)}`
                        )
                    }

                    state = await this.readQuest(page, parent, true)
                    for (let check = 0; check < 2 && !confirmed(); check++) {
                        await this.bot.utils.wait(1500)
                        state = await this.readQuest(page, parent, true)
                    }
                    return verifier.verify(
                        activityResult(
                            confirmed() ? 'confirmed' : 'unconfirmed',
                            confirmed() ? 'step-complete' : 'step-incomplete',
                            child.offerId ?? key
                        ),
                        report
                    )
                },
                'punchcard-child'
            )
            this.bot.recordActivity('punchcard-child', result)
            this.bot.logger.debug(
                this.bot.isMobile,
                'PUNCHCARD-BROWSER',
                `Step ${confirmed() ? 'confirmed' : 'completion not yet confirmed'} | quest=${parent.offerId}` +
                    ` | step="${child.title}" | progress=${state.completed ?? '?'}/${state.total ?? '?'}` +
                    ` | pointsGained=${result.pointsKnown ? result.pointsGained : 'unknown'}`
            )
        }
        this.bot.logger.warn(
            this.bot.isMobile,
            'PUNCHCARD-BROWSER',
            `Stopped at the step limit | offerId=${parent.offerId}`
        )
    }

    private async resolveStepControl(page: Page, child: RenderedPunchCardStep): Promise<Locator | null> {
        const candidates = page.locator('main').getByRole(child.role, { name: child.controlName, exact: true })
        const count = await candidates.count()
        const visible: Locator[] = []
        for (let index = 0; index < count; index++) {
            const candidate = candidates.nth(index)
            if (await candidate.isVisible()) visible.push(candidate)
        }
        if (!visible.length) return null

        const metadata = await readPunchCardStepCandidateMeta(visible)
        const selection = selectUniquePunchCardStepCandidate(metadata, child)
        if (selection.status === 'matched') return visible[selection.index]!
        if (selection.status === 'not-found') return null
        throw new ActivitySkipError(
            'ambiguous-target',
            `Multiple visible controls match punchcard step "${child.title}"; no control was clicked`
        )
    }

    private isClaimChild(child: RenderedPunchCardStep): boolean {
        return /\/redeem(?:\/|\?|$)/i.test(child.destination) || /^(claim|redeem)\b/i.test(child.controlName)
    }
}
