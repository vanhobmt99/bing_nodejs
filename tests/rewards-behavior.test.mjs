import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeDashboard } from '../dist/rewards/shared/parsers/NormalizeRewards.js'

test('empty search counter lists remain unavailable instead of becoming completed zero quotas', () => {
    const dashboard = normalizeDashboard({
        userStatus: {
            availablePoints: 100,
            isRewardsUser: true,
            counters: { pcSearch: [], mobileSearch: [] }
        }
    })

    assert.equal(dashboard.userStatus.counters.pcSearch, undefined)
    assert.equal(dashboard.userStatus.counters.mobileSearch, undefined)
})

test('an incomplete quest with an unknown advertised point maximum remains eligible', async () => {
    const { isEligiblePunchCard } = await import('../dist/rewards/shared/PromotionEligibility.js')
    const quest = {
        offerId: 'weekly-quest',
        destination: 'https://rewards.bing.com/earn/quest/weekly-quest',
        pointProgressMax: 0,
        pointProgressMaxKnown: false,
        complete: false
    }

    assert.equal(isEligiblePunchCard(quest, true), true)
})

test('an incomplete quest with a known zero point maximum is skipped when configured', async () => {
    const { isEligiblePunchCard } = await import('../dist/rewards/shared/PromotionEligibility.js')
    const quest = {
        offerId: 'zero-point-quest',
        destination: 'https://rewards.bing.com/earn/quest/zero-point-quest',
        pointProgressMax: 0,
        pointProgressMaxKnown: true,
        complete: false
    }

    assert.equal(isEligiblePunchCard(quest, true), false)
})

test('isTransientNetworkError separates transient transport failures from terminal responses', async () => {
    const { HttpError, isTransientBrowserNetworkError, isTransientNetworkError } =
        await import('../dist/network/HttpError.js')

    assert.equal(isTransientBrowserNetworkError('net::ERR_CONNECTION_RESET'), true)
    assert.equal(isTransientBrowserNetworkError('net::ERR_NETWORK_ACCESS_DENIED'), true)
    assert.equal(isTransientBrowserNetworkError('net::ERR_BLOCKED_BY_CLIENT'), false)

    assert.equal(isTransientNetworkError(new Error('net::ERR_NETWORK_ACCESS_DENIED')), true)
    assert.equal(isTransientNetworkError(new Error('tcp connect error (code 10013)')), true)
    assert.equal(isTransientNetworkError(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), true)
    assert.equal(isTransientNetworkError(new HttpError(503, { status: 503, headers: {} })), true)
    assert.equal(isTransientNetworkError(new HttpError(403, { status: 403, headers: {} })), false)
    assert.equal(isTransientNetworkError(new HttpError(429, { status: 429, headers: {} })), false)
    assert.equal(
        isTransientNetworkError(
            Object.assign(new Error('CSP blocked'), {
                blockedDirective: 'connect-src',
                networkError: 'net::ERR_FAILED'
            })
        ),
        false
    )
    assert.equal(isTransientNetworkError(new AggregateError([new Error('net::ERR_CONNECTION_RESET')], 'failed')), true)
})

test('BrowserRequestClient retries transient GET in-page fetch failures but never retries POST', async () => {
    const { BrowserRequestClient } = await import('../dist/browser/BrowserRequestClient.js')

    const makeMockPage = handler => {
        const listeners = new Map()
        return {
            isClosed: () => false,
            url: () => 'https://rewards.bing.com/dashboard',
            context: () => ({}),
            on: (event, fn) => {
                const set = listeners.get(event) ?? new Set()
                set.add(fn)
                listeners.set(event, set)
            },
            off: (event, fn) => listeners.get(event)?.delete(fn),
            emit: (event, payload) => {
                for (const fn of listeners.get(event) ?? []) fn(payload)
            },
            evaluateHandle: async () => ({
                evaluate: async () => undefined,
                dispose: async () => undefined
            }),
            evaluate: handler
        }
    }

    const createBot = waits => ({
        signal: new AbortController().signal,
        isMobile: false,
        config: { globalTimeout: 30000 },
        logger: { warn() {}, debug() {} },
        utils: { wait: async ms => waits.push(ms) },
        browser: { utils: { dismissMessages: async () => undefined } },
        accountState: { defer() {} }
    })

    const getWaits = []
    let getAttempts = 0
    const getPage = makeMockPage(async () => {
        getAttempts++
        if (getAttempts === 1) {
            getPage.emit('requestfailed', {
                url: () => 'https://rewards.bing.com/dashboard',
                method: () => 'GET',
                redirectedFrom: () => null,
                failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' })
            })
            return {
                ok: false,
                error: 'Failed to fetch',
                errorName: 'TypeError',
                pageOrigin: 'https://rewards.bing.com',
                online: true
            }
        }
        return { ok: true, status: 200, headers: {}, body: '{"claimed":true}' }
    })

    const getClient = new BrowserRequestClient(createBot(getWaits), () => getPage)
    const getResult = await getClient.request(
        { url: 'https://rewards.bing.com/dashboard', method: 'GET', headers: {} },
        getPage
    )
    assert.equal(getAttempts, 2)
    assert.deepEqual(getWaits, [1000])
    assert.deepEqual(getResult.data, { claimed: true })

    const postWaits = []
    let postAttempts = 0
    const postPage = makeMockPage(async () => {
        postAttempts++
        postPage.emit('requestfailed', {
            url: () => 'https://rewards.bing.com/api/reportactivity',
            method: () => 'POST',
            redirectedFrom: () => null,
            failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' })
        })
        return {
            ok: false,
            error: 'Failed to fetch',
            errorName: 'TypeError',
            pageOrigin: 'https://rewards.bing.com',
            online: true
        }
    })

    const postClient = new BrowserRequestClient(createBot(postWaits), () => postPage)
    await assert.rejects(
        () =>
            postClient.request(
                { url: 'https://rewards.bing.com/api/reportactivity', method: 'POST', headers: {}, body: '{}' },
                postPage
            ),
        error => error instanceof Error && error.message.includes('(net::ERR_CONNECTION_RESET)')
    )
    assert.equal(postAttempts, 1)
    assert.deepEqual(postWaits, [])
})

test('AccountData.getDashboardData performs backoff retry round only for transient failures', async () => {
    const { AccountData } = await import('../dist/rewards/shared/data/AccountData.js')
    const { HttpError } = await import('../dist/network/HttpError.js')

    const makeBot = (waits, responder) => ({
        signal: new AbortController().signal,
        isMobile: false,
        activePage: null,
        config: { globalTimeout: 30000 },
        accountLocale: { acceptLanguage: 'en-US,en;q=0.9' },
        reactSnapshot: undefined,
        userData: { currentPoints: 0, initialPoints: 0, timezone: 'UTC' },
        browser: { userAgentManager: { getRequestHeaders: () => ({ 'user-agent': 'UA' }) } },
        sessionState: {
            getCachedCookies: () => [],
            synchronize: async () => undefined,
            browserRequest: responder
        },
        requestClient: {
            request: async () => {
                throw new Error('Unexpected in-page call')
            }
        },
        accountState: { observe() {}, initialBalance: 100, defer() {} },
        logger: { warn() {}, error() {}, debug() {}, event() {} },
        utils: { wait: async ms => waits.push(ms) }
    })

    const transientWaits = []
    let transientCalls = 0
    const transientAccountData = new AccountData(
        makeBot(transientWaits, async () => {
            transientCalls++
            if (transientCalls <= 2) throw new Error('tcp connect error (code 10013)')
            return {
                status: 200,
                data: { dashboard: { userStatus: { availablePoints: 120, isRewardsUser: true, counters: {} } } },
                headers: {}
            }
        }),
        {}
    )
    const recovered = await transientAccountData.getDashboardData()
    assert.equal(transientCalls, 3)
    assert.deepEqual(transientWaits, [1500])
    assert.equal(recovered.dashboard.userStatus.availablePoints, 120)

    const terminalWaits = []
    let terminalCalls = 0
    const terminalAccountData = new AccountData(
        makeBot(terminalWaits, async () => {
            terminalCalls++
            throw new HttpError(403, { status: 403, headers: {} })
        }),
        {}
    )
    await assert.rejects(() => terminalAccountData.getDashboardData(), AggregateError)
    assert.equal(terminalCalls, 2)
    assert.deepEqual(terminalWaits, [])
})

test('selectUniquePunchCardStepCandidate resolves shared control labels without false ambiguity', async () => {
    const { selectUniquePunchCardStepCandidate } =
        await import('../dist/rewards/browser/parsers/PunchCardPageParser.js')

    const disabledSibling = [
        {
            disabled: false,
            offerId: null,
            href: 'https://www.bing.com/search?q=1',
            headingIndex: 1,
            headingTitle: 'Search to complete'
        },
        {
            disabled: true,
            offerId: null,
            href: 'https://www.bing.com/search?q=2',
            headingIndex: 2,
            headingTitle: 'Follow-up search'
        }
    ]
    assert.deepEqual(
        selectUniquePunchCardStepCandidate(disabledSibling, {
            offerId: null,
            destination: 'https://www.bing.com/search?q=1',
            headingIndex: 1,
            title: 'Search to complete'
        }),
        { status: 'matched', index: 0 }
    )

    const twoEnabledSameButton = [
        {
            disabled: false,
            offerId: null,
            href: 'https://www.bing.com/search?q=sea-1',
            headingIndex: 0,
            headingTitle: 'Search to complete'
        },
        {
            disabled: false,
            offerId: null,
            href: 'https://www.bing.com/search?q=sea-2',
            headingIndex: 1,
            headingTitle: 'Search to complete'
        }
    ]
    assert.deepEqual(
        selectUniquePunchCardStepCandidate(twoEnabledSameButton, {
            offerId: null,
            destination: 'https://www.bing.com/search?q=sea-2',
            headingIndex: 1,
            title: 'Search to complete'
        }),
        { status: 'matched', index: 1 }
    )

    const genuinelyAmbiguous = [
        {
            disabled: false,
            offerId: null,
            href: 'https://www.bing.com/search?q=same',
            headingIndex: 0,
            headingTitle: 'Search to complete'
        },
        {
            disabled: false,
            offerId: null,
            href: 'https://www.bing.com/search?q=same',
            headingIndex: 0,
            headingTitle: 'Search to complete'
        }
    ]
    assert.deepEqual(
        selectUniquePunchCardStepCandidate(genuinelyAmbiguous, {
            offerId: null,
            destination: 'https://www.bing.com/search?q=same',
            headingIndex: 0,
            title: 'Search to complete'
        }),
        { status: 'ambiguous' }
    )
})
