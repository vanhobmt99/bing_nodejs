import { pointDelta, pointValue } from '../PointAccounting'
import type { Locator, Page, Request } from 'patchright'
import { randomUUID } from 'node:crypto'
import { BrowserTaskPage } from '../../../browser/BrowserTaskPage'
import { ghostClick } from '../../../browser/GhostClick'
import { browserTimeout } from '../../../browser/BrowserTiming'
import { URLs } from '../../../constants/urls'
import { buildCookieHeader } from '../../../network/CookieUtils'
import { localeRequestHeaders } from '../../../network/RequestHeaders'
import { ActivitySkipError, activityResult, activityFailure, type ActivityResult } from '../ActivityResult'
import { BaseActivity } from './BaseActivity'
import { ServerActions } from '../http/ServerActions'

export class ClaimBonusPoints extends BaseActivity {
    async run(): Promise<ActivityResult> {
        const operationId = randomUUID()
        let task: BrowserTaskPage | undefined
        try {
            const source = this.bot.activePage
            if (source && !source.isClosed()) task = await BrowserTaskPage.createRewards(source)
            const page = task?.page
            const before = await this.readClaimPage(page)
            const oldBalance = before.balance ?? this.bot.userData.currentPoints
            const expectedPoints = pointValue(before.claimable)
            this.bot.userData.currentPoints = oldBalance
            if (before.claimable === 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Nothing to claim | claimablePoints=0 | pointsGained=0 | currentBalance=${oldBalance}`
                )
                return activityResult('skipped', 'no-claimable-bonus')
            }

            if (expectedPoints === null || expectedPoints <= 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    'Claimable bonus points could not be verified; skipping claim request'
                )
                return activityResult('unconfirmed', 'claimable-bonus-unknown')
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Starting ClaimBonusPoints | transport=api | rewardsMode=${this.bot.config.rewardsMode}` +
                    ` | claimablePoints=${before.claimable ?? 'unknown'} | currentBalance=${oldBalance}`
            )
            const backgroundActive = this.bot.accountState.backgroundRewardsActive
            const server = new ServerActions(this.bot)
            let response: { status: number; acknowledged: boolean; availablePoints: number | null } | undefined
            let shouldTryUiFallback = false
            try {
                response = await server.reportClaimAllPoints(before.html, page)
                if (!response.acknowledged || response.status < 200 || response.status >= 300) {
                    shouldTryUiFallback = true
                }
            } catch (error) {
                this.bot.signal.throwIfAborted()
                if (error instanceof ActivitySkipError && error.reason === 'action-id-unavailable') {
                    shouldTryUiFallback = true
                }
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Claim submission uncertain; ${shouldTryUiFallback && page && !page.isClosed() ? 'falling back to dashboard UI' : 'verifying without resubmitting'} | ${String(error)}`
                )
            }

            let uiFallbackUsed = false
            if (shouldTryUiFallback && page && !page.isClosed()) {
                try {
                    uiFallbackUsed = await this.claimViaDashboardUi(page)
                } catch (error) {
                    this.bot.signal.throwIfAborted()
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'CLAIM-BONUS-POINTS',
                        `Dashboard UI claim fallback failed | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }

            let after: typeof before | undefined
            let verifiedBalance: number | null = response?.availablePoints ?? null
            let balanceDelta: number | null = pointDelta(oldBalance, verifiedBalance)
            const stateConfirmed = () => before.claimable !== null && before.claimable > 0 && after?.claimable === 0
            const balanceConfirmed = () => {
                if (balanceDelta === null || balanceDelta <= 0) return false
                const backgroundRewardsActive = backgroundActive || this.bot.accountState.backgroundRewardsActive
                if (expectedPoints !== null && expectedPoints > 0) {
                    if (balanceDelta < expectedPoints) return false
                    return !backgroundRewardsActive || response?.acknowledged === true || stateConfirmed()
                }
                return !backgroundRewardsActive
            }

            for (let attempt = 0; attempt < 4; attempt++) {
                if (attempt) await this.bot.utils.wait(1500)
                this.bot.signal.throwIfAborted()

                try {
                    after = await this.readClaimPage(page)
                    if (after.balance !== null) verifiedBalance = after.balance
                } catch (error) {
                    this.bot.signal.throwIfAborted()
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'CLAIM-BONUS-POINTS',
                        `Claim verification read failed | attempt=${attempt + 1} | acknowledged=${response?.acknowledged ?? false}` +
                            ` | message=${error instanceof Error ? error.message : String(error)}`
                    )
                }

                try {
                    const refreshedBalance = await this.bot.rewards.getCurrentPoints()
                    if (Number.isFinite(refreshedBalance)) verifiedBalance = refreshedBalance
                } catch (error) {
                    this.bot.signal.throwIfAborted()
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'CLAIM-BONUS-POINTS',
                        `Claim balance verification failed | attempt=${attempt + 1}` +
                            ` | message=${error instanceof Error ? error.message : String(error)}`
                    )
                }

                balanceDelta = pointDelta(oldBalance, verifiedBalance)
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Claim verification | attempt=${attempt + 1}/4 | previousBalance=${oldBalance}` +
                        ` | currentBalance=${verifiedBalance ?? 'unknown'} | balanceDelta=${balanceDelta ?? 'unknown'}` +
                        ` | claimableAfter=${after?.claimable ?? 'unknown'} | stateConfirmed=${stateConfirmed()}` +
                        ` | balanceConfirmed=${balanceConfirmed()}`
                )

                if (stateConfirmed() || balanceConfirmed()) break
            }

            const confirmedByState = stateConfirmed()
            const confirmedByBalance = balanceConfirmed()
            const confirmed = confirmedByState || confirmedByBalance
            const failed = !confirmed && response !== undefined && (response.status < 200 || response.status >= 300)
            const newBalance = verifiedBalance ?? after?.balance ?? response?.availablePoints ?? oldBalance

            let gainedPoints: number | null = null
            if (confirmedByState && expectedPoints !== null && expectedPoints > 0) gainedPoints = expectedPoints
            else if (confirmedByBalance && expectedPoints !== null && expectedPoints > 0) gainedPoints = expectedPoints
            else if (confirmedByBalance && balanceDelta !== null) gainedPoints = balanceDelta

            const pointsKnown = gainedPoints !== null
            this.bot.userData.currentPoints = newBalance

            const reason = confirmedByState
                ? 'claim-state-confirmed'
                : confirmedByBalance
                  ? 'claim-balance-confirmed'
                  : failed
                    ? 'claim-request-failed'
                    : 'claim-not-confirmed'
            const message =
                `${confirmed ? 'Completed ClaimBonusPoints' : 'Nothing claimed'}` +
                ` | status=${response?.status ?? 'unknown'} | acknowledged=${response?.acknowledged ?? false}` +
                `${uiFallbackUsed ? ' | uiFallback=true' : ''}` +
                ` | claimableBefore=${before.claimable ?? 'unknown'} | claimableAfter=${after?.claimable ?? 'unknown'}` +
                ` | previousBalance=${oldBalance} | currentBalance=${newBalance}` +
                ` | balanceDelta=${balanceDelta ?? 'unknown'} | verification=${confirmedByState ? 'claim-state' : confirmedByBalance ? 'balance' : 'unconfirmed'}` +
                ` | pointsGained=${pointsKnown ? gainedPoints : 'unknown'}`
            if (confirmed) this.bot.logger.debug(this.bot.isMobile, 'CLAIM-BONUS-POINTS', message)
            else this.bot.logger.warn(this.bot.isMobile, 'CLAIM-BONUS-POINTS', message)
            return {
                ...activityResult(
                    confirmed ? 'confirmed' : failed ? 'failed' : 'unconfirmed',
                    reason,
                    undefined,
                    gainedPoints
                ),
                operationId,
                pointsKnown,
                balanceBefore: before.balance,
                balanceAfter: verifiedBalance
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Error in claimBonusPoints | message=${error instanceof Error ? error.message : String(error)}`
            )
            return activityFailure(error)
        } finally {
            await task?.close()
        }
    }

    private async claimViaDashboardUi(page: Page): Promise<boolean> {
        if (page.isClosed()) return false
        if (page.url().split(/[?#]/)[0] !== URLs.rewards.dashboard) {
            await page.goto(URLs.rewards.dashboard, {
                waitUntil: 'domcontentloaded',
                timeout: browserTimeout(this.bot, 'navigation')
            })
        }
        await this.bot.browser.utils.dismissMessages(page).catch(() => undefined)

        const trigger = page
            .locator('main button, main [role="button"]')
            .filter({ hasText: /ready to claim/i })
            .first()
        const visible = await trigger
            .waitFor({ state: 'visible', timeout: Math.min(browserTimeout(this.bot, 'optional'), 5000) })
            .then(() => true)
            .catch(() => false)
        if (!visible) return false

        const triggerDisabled = await trigger
            .evaluate(el => Boolean(el.closest('[disabled], [aria-disabled="true"], [data-disabled], [inert]')))
            .catch(() => true)
        if (triggerDisabled) return false

        const context = page.context()
        const nextActionReports: Promise<void>[] = []
        let actionTimeout: ReturnType<typeof setTimeout> | undefined
        const observeNextAction = (request: Request): void => {
            if (request.method() !== 'POST') return
            try {
                const url = new URL(request.url())
                if (url.origin !== URLs.rewards.origin) return
                if (!request.headers()['next-action']) return
                nextActionReports.push(
                    request
                        .response()
                        .then(async response => {
                            await response?.text().catch(() => undefined)
                        })
                        .catch(() => undefined)
                )
            } catch {
                // Ignore
            }
        }
        context.on('request', observeNextAction)
        try {
            await ghostClick(page, trigger, browserTimeout(this.bot), this.bot.signal, { scroll: 'direct' })
            this.bot.logger.debug(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'Clicked dashboard "Ready to claim" button')

            const dialog = page.locator('[role="dialog"]').first()
            const dialogOpened = await dialog
                .waitFor({ state: 'visible', timeout: Math.min(browserTimeout(this.bot, 'optional'), 3000) })
                .then(() => true)
                .catch(() => false)
            if (dialogOpened) {
                const buttons = page.locator('[role="dialog"] button, [role="dialog"] [role="button"]')
                const count = await buttons.count().catch(() => 0)
                const matches: Locator[] = []
                for (let index = 0; index < count; index++) {
                    const button = buttons.nth(index)
                    if (!(await button.isVisible().catch(() => false))) continue
                    const meta = await button
                        .evaluate(el => ({
                            disabled: Boolean(
                                el.closest('[disabled], [aria-disabled="true"], [data-disabled], [inert]')
                            ),
                            label: (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
                        }))
                        .catch(() => null)
                    if (!meta || meta.disabled) continue
                    if (/^claim(?:\s+(?:all|points?|now))?$/i.test(meta.label)) {
                        matches.push(button)
                    }
                }
                if (matches.length === 1) {
                    await ghostClick(page, matches[0]!, browserTimeout(this.bot), this.bot.signal, { scroll: 'direct' })
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'CLAIM-BONUS-POINTS',
                        'Clicked "Claim" button inside dashboard bonus points dialog'
                    )
                }
            }

            await this.bot.utils.wait(500)
            if (nextActionReports.length) {
                await Promise.race([
                    Promise.allSettled(nextActionReports),
                    new Promise<void>(resolve => {
                        actionTimeout = setTimeout(resolve, Math.min(browserTimeout(this.bot, 'optional'), 5000))
                    })
                ])
            }
            return true
        } finally {
            context.off('request', observeNextAction)
            if (actionTimeout) clearTimeout(actionTimeout)
        }
    }

    private async readClaimPage(page?: Page) {
        const url = URLs.rewards.dashboard
        const response = await this.bot.requestClient.request<string>(
            {
                url,
                method: 'GET',
                responseType: 'text',
                pageOwnership: 'own',
                headers: {
                    ...localeRequestHeaders(this.bot.accountLocale.acceptLanguage),
                    'Cache-Control': 'no-cache',
                    Referer: url,
                    Cookie: buildCookieHeader(this.bot.sessionState.getCachedCookies(undefined, url))
                },
                allowNodeFallback: this.bot.mode.allowClosedBrowserHttp
            },
            page
        )
        if (response.via !== 'in-page')
            await this.bot.sessionState.applyResponseCookies(url, response.headers['set-cookie'])
        if (response.status < 200 || response.status >= 300)
            throw new Error(`Claim state request failed | status=${response?.status ?? 'unknown'}`)
        return {
            html: response.data,
            claimable: this.bot.pageParser.claimablePointsFromPayload(response.data),
            balance: this.bot.pageParser.availablePointsFromPayload(response.data)
        }
    }
}
