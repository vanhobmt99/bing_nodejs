import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { chromium } from 'patchright'

const require = createRequire(import.meta.url)
const { rewardUrlIdentity } = require('../dist/rewards/browser/parsers/RewardCardParser.js')
const {
    correlateQuestStepOfferIds,
    readPunchCardPage,
    readPunchCardParents
} = require('../dist/rewards/browser/parsers/PunchCardPageParser.js')
const { BrowserRewardNavigator } = require('../dist/rewards/browser/actions/BrowserRewardNavigator.js')
const { BrowserPunchCards } = require('../dist/rewards/browser/actions/BrowserPunchCards.js')
const { BrowserUrlReward } = require('../dist/rewards/browser/actions/BrowserUrlReward.js')
const { BrowserEarnTasks } = require('../dist/rewards/browser/BrowserEarnTasks.js')
const { ClaimBonusPoints } = require('../dist/rewards/shared/activities/ClaimBonusPoints.js')
const { ServerActions } = require('../dist/rewards/shared/http/ServerActions.js')
const RewardsPageParser = require('../dist/rewards/shared/parsers/RewardsPageParser.js').default

const noop = () => {}

function makeBot(overrides = {}) {
    const activities = []
    const bot = {
        isMobile: false,
        signal: new AbortController().signal,
        config: {
            rewardsMode: 'browser',
            globalTimeout: '5s',
            skipNonPointTasks: true,
            autoClaimPunchcardRewards: true,
            taskDelay: { min: '10ms', max: '20ms' },
            workers: {
                doDailySet: true,
                doMorePromotions: true,
                doPunchCards: true,
                doClaimBonusPoints: true
            }
        },
        logger: {
            debug: noop,
            info: noop,
            warn: noop,
            error: noop,
            event: noop
        },
        utils: {
            wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 50))),
            stringToMs: () => 5000,
            randomNumber: () => 0,
            randomDelay: () => 0,
            formatDate: () => '11/19/2026'
        },
        browser: {
            utils: {
                dismissMessages: async () => {}
            }
        },
        accountLocale: {
            acceptLanguage: 'en-US,en;q=0.9',
            market: 'en-US'
        },
        accountState: {
            backgroundRewardsActive: false,
            taskReadyAt: new Map(),
            results: []
        },
        mode: {
            allowClosedBrowserHttp: false
        },
        userData: {
            currentPoints: 1000,
            timezone: 'UTC'
        },
        sessionState: {
            getCachedCookies: () => [],
            applyResponseCookies: async () => {}
        },
        rewards: {
            getCurrentPoints: async () => bot.userData.currentPoints
        },
        nextActions: {},
        nextRouterStateTree: '',
        reactSnapshot: null,
        reactSnapshots: {},
        attemptedPunchcardChildren: new Set(),
        activityResults: activities,
        recordActivity: (activity, result) => {
            activities.push({ activity, ...result })
        },
        observePunchCard: noop,
        ...overrides
    }
    bot.pageParser = overrides.pageParser ?? new RewardsPageParser(bot)
    return bot
}

let browser
before(async () => {
    browser = await chromium.launch({ headless: true })
})
after(async () => {
    await browser?.close()
})

test('rewardUrlIdentity extracts sid and WQOskey stable filter keys and matches cross-locale dashboard cards', async () => {
    const viUrl =
        'https://www.bing.com/search?q=Chuy%E1%BA%BFn+%C4%91i+%C4%91%E1%BA%BFn+Hobart&filters=sid:%22e1998a39-1234-5678-90ab-abcdef012345%22&form=ML2XYZ'
    const enUrl =
        'https://www.bing.com/search?q=Trip+to+Hobart&filters=sid:%22e1998a39-1234-5678-90ab-abcdef012345%22&form=ML2ABC'
    const quizUrl =
        'https://www.bing.com/search?q=Chimamanda&filters=WQOskey:%22Adichie_Quiz_2026%22+IsDarkTheme:%220%22'

    assert.deepEqual(rewardUrlIdentity(viUrl, 'https://rewards.bing.com').stableKeys, [
        'sid:e1998a39-1234-5678-90ab-abcdef012345'
    ])
    assert.deepEqual(rewardUrlIdentity(quizUrl, 'https://rewards.bing.com').stableKeys, ['wqoskey:adichie_quiz_2026'])

    const context = await browser.newContext()
    try {
        const page = await context.newPage()
        await page.route('https://rewards.bing.com/**', async route => {
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `<!doctype html><html><body><main>
                    <section id="dailyset">
                        <a href="${enUrl}">
                            <h3>Hobart Tasmanian Spring Fresh</h3>
                            <p>Explore the coastline</p>
                        </a>
                        <a href="${quizUrl}">
                            <h3>Adichie Insights?</h3>
                            <p>Test your knowledge</p>
                        </a>
                    </section>
                </main></body></html>`
            })
        })
        await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded' })

        const navigator = new BrowserRewardNavigator(makeBot())
        const matchedDaily = await navigator.findDashboardCard(page, {
            offerId: 'Global_DailySet_20261119_Child2',
            title: 'Khám phá Hobart mùa xuân',
            destination: viUrl
        })
        assert.ok(matchedDaily, 'Vietnamese daily set card should match English /dashboard card by sid filter')
        assert.equal(await matchedDaily.getAttribute('href'), enUrl)

        const matchedQuiz = await navigator.findDashboardCard(page, {
            offerId: 'Global_DailySet_20261119_Child3',
            title: 'Kiến thức Adichie?',
            destination: 'https://www.bing.com/search?q=Adichie+vi&filters=WQOskey:%22Adichie_Quiz_2026%22'
        })
        assert.ok(matchedQuiz, 'Localized quiz card should match English /dashboard card by WQOskey filter')
        assert.equal(await matchedQuiz.getAttribute('href'), quizUrl)
    } finally {
        await context.close()
    }
})

test('readPunchCardParents, readPunchCardPage, and correlateQuestStepOfferIds handle claim CTAs and multi-control steps', async () => {
    const context = await browser.newContext()
    try {
        const page = await context.newPage()
        await page.route('https://rewards.bing.com/earn', async route => {
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `<!doctype html><html><body><main>
                    <section id="quests">
                        <a href="/earn/quest/TEST_pcparent_unclaimed">
                            <h3>Monthly Bonus Quest</h3>
                            <span class="text-metadata">4/4 tasks</span>
                            <div class="rounded-cornerCircular"><p>+100</p></div>
                            <span>Claim reward</span>
                        </a>
                        <a href="/earn/quest/TEST_pcparent_done">
                            <h3>Completed Quest</h3>
                            <span class="text-metadata">4/4 tasks</span>
                            <div class="bg-statusSuccessRewardsBg">Done</div>
                        </a>
                    </section>
                </main></body></html>`
            })
        })
        await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded' })
        const parents = await readPunchCardParents(page)
        assert.equal(parents.length, 2)
        assert.equal(parents[0].offerId, 'TEST_pcparent_unclaimed')
        assert.equal(parents[0].complete, false, '4/4 quest with visible Claim CTA and no success badge stays open')
        assert.equal(parents[1].offerId, 'TEST_pcparent_done')
        assert.equal(parents[1].complete, true, 'Quest with success badge is marked complete')

        await page.route('https://rewards.bing.com/earn/quest/TEST_pcparent_steps', async route => {
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `<!doctype html><html><body><main>
                    <p>1/3 tasks</p>
                    <section>
                        <h3>Terms and conditions</h3>
                        <span role="link">Read more</span>
                    </section>
                    <div class="step-row">
                        <h3>Activate this quest</h3>
                        <p>Start earning</p>
                        <a href="https://rewards.bing.com/terms">Learn more</a>
                        <a href="https://rewards.bing.com/earn/quest/TEST_pcparent_steps?step=1">Activate</a>
                    </div>
                    <div class="step-row">
                        <h3>Search on Bing</h3>
                        <p>Locked until step 1</p>
                        <span role="link" aria-disabled="true" href="https://www.bing.com/search?q=test">Search</span>
                    </div>
                    <div class="quest-banner">
                        <button type="button">Claim reward</button>
                    </div>
                </main></body></html>`
            })
        })
        await page.goto('https://rewards.bing.com/earn/quest/TEST_pcparent_steps', { waitUntil: 'domcontentloaded' })
        const quest = await readPunchCardPage(page)
        assert.equal(quest.completed, 1)
        assert.equal(quest.total, 3)
        assert.equal(quest.steps.length, 3, 'Terms h3 ignored, multi-control step kept, standalone Claim discovered')
        assert.equal(quest.steps[0].title, 'Activate this quest')
        assert.equal(quest.steps[0].controlName, 'Activate')
        assert.equal(quest.steps[1].title, 'Search on Bing')
        assert.equal(quest.steps[1].disabled, true)
        assert.equal(quest.steps[2].controlName, 'Claim reward')
        assert.equal(quest.steps[2].role, 'button')
        assert.equal(quest.steps[2].headingIndex, undefined)

        const correlated = correlateQuestStepOfferIds(quest.steps, [
            {
                offerId: 'WW_pcchild1_test',
                hash: 'h1',
                title: '',
                destination: '',
                points: 0,
                isCompleted: false,
                isLocked: false,
                isDisabled: false,
                reportable: true
            },
            {
                offerId: 'WW_pcchild2_test',
                hash: 'h2',
                title: '',
                destination: '',
                points: 0,
                isCompleted: false,
                isLocked: true,
                isDisabled: false,
                reportable: false
            }
        ])
        assert.equal(correlated[0].offerId, 'WW_pcchild1_test')
        assert.equal(correlated[1].offerId, 'WW_pcchild2_test')
        assert.equal(correlated[2].offerId, null)
    } finally {
        await context.close()
    }
})

test('BrowserPunchCards claims standalone Claim button at 4/4 tasks, confirms dialog, and obeys autoClaimPunchcardRewards', async () => {
    const context = await browser.newContext()
    try {
        let claimed = false
        let nextActionReceived = false
        const page = await context.newPage()
        await page.route('https://rewards.bing.com/earn/quest/TEST_pcparent_claim', async route => {
            const req = route.request()
            if (req.method() === 'POST' && req.headers()['next-action']) {
                nextActionReceived = true
                claimed = true
                await route.fulfill({ status: 200, contentType: 'text/x-component', body: '0:{}\n1:true\n' })
                return
            }
            const buttonMarkup = claimed
                ? '<div class="bg-statusSuccessRewardsBg">Claimed</div>'
                : `<button id="claim-open" type="button">Claim reward</button>
                   <div id="claim-modal" role="dialog" style="display:none">
                       <button id="claim-confirm" type="button">Claim now</button>
                   </div>
                   <script>
                       document.getElementById('claim-open').addEventListener('click', () => {
                           document.getElementById('claim-modal').style.display = 'block'
                       })
                       document.getElementById('claim-confirm').addEventListener('click', () => {
                           fetch('/earn/quest/TEST_pcparent_claim', {
                               method: 'POST',
                               headers: { 'next-action': 'action_claim_quest', 'content-type': 'text/plain;charset=UTF-8' },
                               body: '[]'
                           })
                       })
                   </script>`
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `<!doctype html><html><body><main>
                    <h1>Bonus Quest</h1>
                    <p>4/4 tasks</p>
                    ${buttonMarkup}
                </main></body></html>`
            })
        })

        const parent = {
            offerId: 'TEST_pcparent_claim',
            title: 'Bonus Quest',
            destination: 'https://rewards.bing.com/earn/quest/TEST_pcparent_claim',
            pointProgressMax: 100,
            pointProgressMaxKnown: true,
            complete: false
        }

        // autoClaimPunchcardRewards=false must leave the claim untouched
        const manualBot = makeBot()
        manualBot.config.autoClaimPunchcardRewards = false
        const manualRunner = new BrowserPunchCards(manualBot)
        await manualRunner.solveChildren(page, parent)
        assert.equal(claimed, false)
        assert.equal(nextActionReceived, false)

        // autoClaimPunchcardRewards=true must click Claim reward -> confirm dialog -> await Next-Action
        const autoBot = makeBot()
        const autoRunner = new BrowserPunchCards(autoBot)
        await autoRunner.solveChildren(page, parent)
        assert.equal(claimed, true)
        assert.equal(nextActionReceived, true)
        assert.ok(
            autoBot.activityResults.some(item => item.activity === 'punchcard-child' && item.status === 'confirmed'),
            'Claim step should be recorded as confirmed'
        )
    } finally {
        await context.close()
    }
})

test('ServerActions.bootstrap accepts /earn without #dailyset and BrowserEarnTasks preserves seeded daily set', async () => {
    const context = await browser.newContext()
    try {
        const earnHtml = `<!doctype html><html><body><main>
            <section id="quests"><a href="/earn/quest/TEST_pcparent_1"><h3>Quest 1</h3><p>0/2 tasks</p></a></section>
            <section id="moreactivities">
                <a href="https://www.bing.com/search?q=Quote+of+the+day">
                    <h3>Quote of the day</h3>
                    <div class="rounded-cornerCircular"><p class="text-metadata">+5</p></div>
                </a>
            </section>
        </main></body></html>`
        const dashHtml = `<!doctype html><html><body><main>
            <section id="dailyset"><a href="https://www.bing.com/search?q=Daily1"><h3>Daily 1</h3></a></section>
        </main></body></html>`

        const page = await context.newPage()
        await context.route('https://rewards.bing.com/**', async route => {
            const url = route.request().url()
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: url.includes('/dashboard') ? dashHtml : earnHtml
            })
        })

        const bot = makeBot({
            activePage: page,
            mainDesktopPage: page,
            requestClient: {
                request: async config => ({
                    status: 200,
                    headers: {},
                    via: 'in-page',
                    data: config.url.includes('/dashboard') ? dashHtml : earnHtml
                })
            }
        })

        const server = new ServerActions(bot)
        await server.bootstrap(page)

        const seededDaily = [
            {
                offerId: 'Daily_1',
                name: 'Daily_1',
                title: 'Daily 1',
                description: '',
                destinationUrl: 'https://www.bing.com/search?q=Daily1',
                promotionType: 'urlreward',
                promotionSubtype: '',
                attributes: {},
                complete: false,
                isHidden: false,
                priority: 1,
                pointProgress: 0,
                pointProgressMax: 10,
                activityProgress: 0,
                activityProgressMax: 1,
                exclusiveLockedFeatureStatus: ''
            }
        ]
        const earnTasks = new BrowserEarnTasks(bot)
        const state = await earnTasks.read({
            account: { availablePoints: 1000, level: 2, pointsProgress: 0, pointsRemaining: 0, lifetimeEarn: 1000 },
            dashboard: {
                userStatus: { level: 2, counters: { pcSearch: [], mobileSearch: [] } },
                dailySetPromotions: { '11/19/2026': seededDaily },
                morePromotions: [],
                morePromotionsWithoutPromotionalItems: [],
                promotionalItem: null,
                promotionalItems: [],
                punchCards: []
            },
            sourceInfo: { source: 'flyout', activities: [], missingSections: [] },
            raw: { source: 'flyout', payload: {} }
        })
        assert.deepEqual(
            state.dashboard.dailySetPromotions['11/19/2026'],
            seededDaily,
            'Seeded daily set promotions must be preserved when /earn renders no #dailyset section'
        )
        assert.equal(state.dashboard.morePromotions.length, 1)
    } finally {
        await context.close()
    }
})

test('ClaimBonusPoints falls back to dashboard Ready to claim UI when reportClaimAllPoints action ID is unavailable', async () => {
    const context = await browser.newContext()
    try {
        let claimable = 50
        let balance = 1000
        let uiNextActionFired = false

        const dashboardHtml = () => {
            const payload = JSON.stringify({
                availablePoints: balance,
                pointClaim: claimable > 0 ? { points: claimable } : null
            })
            return `<!doctype html><html><body>
                <script>window.__DATA__ = ${payload};</script>
                <main>
                    <button id="ready-btn" type="button">Ready to claim ${claimable} Claim</button>
                    <div id="claim-drawer" role="dialog" style="display:none">
                        <button id="drawer-claim" type="button">Claim</button>
                    </div>
                </main>
                <script>
                    document.getElementById('ready-btn').addEventListener('click', () => {
                        document.getElementById('claim-drawer').style.display = 'block'
                    })
                    document.getElementById('drawer-claim').addEventListener('click', () => {
                        fetch('/dashboard', {
                            method: 'POST',
                            headers: { 'next-action': 'ui_claim_all_action', 'content-type': 'text/plain;charset=UTF-8' },
                            body: '[]'
                        })
                    })
                </script>
            </body></html>`
        }

        const sourcePage = await context.newPage()
        await context.route('https://rewards.bing.com/dashboard', async route => {
            const req = route.request()
            if (req.method() === 'POST' && req.headers()['next-action']) {
                uiNextActionFired = true
                balance += claimable
                claimable = 0
                await route.fulfill({ status: 200, contentType: 'text/x-component', body: '0:{}\n1:true\n' })
                return
            }
            await route.fulfill({ status: 200, contentType: 'text/html', body: dashboardHtml() })
        })

        const logs = []
        const bot = makeBot({
            activePage: sourcePage,
            mainDesktopPage: sourcePage,
            logger: {
                debug: (...args) => logs.push(['debug', ...args]),
                info: (...args) => logs.push(['info', ...args]),
                warn: (...args) => logs.push(['warn', ...args]),
                error: (...args) => logs.push(['error', ...args]),
                event: noop
            },
            requestClient: {
                request: async () => ({
                    status: 200,
                    headers: {},
                    via: 'in-page',
                    data: dashboardHtml()
                })
            },
            rewards: {
                getCurrentPoints: async () => balance
            }
        })

        const result = await new ClaimBonusPoints(bot).run()
        assert.equal(
            uiNextActionFired,
            true,
            `Dashboard UI fallback should click Ready to claim -> dialog Claim (result=${JSON.stringify(result)}, logs=${JSON.stringify(logs)})`
        )
        assert.equal(result.status, 'confirmed')
        assert.equal(result.reason, 'claim-state-confirmed')
        assert.equal(result.pointsGained, 50)
        assert.equal(bot.userData.currentPoints, 1050)
    } finally {
        await context.close()
    }
})

test('BrowserUrlReward resolves localized daily-set target on /dashboard via reactSnapshot offerId fallback', async () => {
    const context = await browser.newContext()
    try {
        const enUrl = 'https://www.bing.com/search?q=Spring+in+Tasmania&form=ML2EN'
        const viUrl = 'https://www.bing.com/search?q=M%C3%B9a+xu%C3%A2n+%E1%BB%9F+Tasmania&form=ML2VI'
        const page = await context.newPage()
        await context.route('https://rewards.bing.com/dashboard', async route => {
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `<!doctype html><html><body><main>
                    <section id="dailyset">
                        <a href="${enUrl}">
                            <h3>Spring in Tasmania</h3>
                            <p>Discover the season</p>
                        </a>
                    </section>
                </main></body></html>`
            })
        })

        const bot = makeBot({
            mainDesktopPage: page,
            reactSnapshot: {
                offers: [
                    {
                        offerId: 'Global_DailySet_20261119_Child1',
                        title: 'Spring in Tasmania',
                        description: 'Discover the season',
                        destination: enUrl
                    }
                ],
                reportable: [],
                streaks: [],
                streakProtection: null,
                account: { availablePoints: 1000, level: 2, pointsProgress: 0, pointsRemaining: 0, lifetimeEarn: 1000 }
            }
        })
        const urlReward = new BrowserUrlReward(bot)
        const target = {
            offerId: 'Global_DailySet_20261119_Child1',
            title: 'Mùa xuân ở Tasmania',
            description: 'Khám phá mùa xuân',
            destination: viUrl
        }
        const control = await urlReward.findRenderedCard(page, target, 'dashboard')
        assert.ok(control, 'Localized daily-set target should match English /dashboard card using reactSnapshot offer')
        assert.equal(await control.getAttribute('href'), enUrl)
    } finally {
        await context.close()
    }
})
