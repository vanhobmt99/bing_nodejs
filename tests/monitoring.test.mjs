import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { renderMetrics } from '../src/control-api/metrics.js'
import { createAccessControl } from '../src/control-api/access.js'
import { createMonitoringRoutes } from '../dist/control-api/routes/monitoring.js'
import { createRunState, ensureAccount } from '../dist/control-api/logs/state.js'
import { applyDomainEvent } from '../dist/control-api/logs/domainEvents.js'

const email = 'one@example.com'
const endedAt = '2026-11-10T07:05:00.000Z'
const idle = { state: 'idle', run: { operation: 'rewards', accounts: [] } }

function history(account = {}, run = {}) {
    return {
        operation: 'rewards',
        startedAt: '2026-11-10T07:00:00.000Z',
        endedAt,
        accounts: [
            {
                email,
                status: 'completed',
                success: true,
                pointsKnown: true,
                collected: 25,
                currentBalance: 1025,
                durationSeconds: 300,
                bySource: { search: 25 },
                ...account
            }
        ],
        ...run
    }
}

function render(overrides = {}) {
    return renderMetrics({
        accounts: [{ index: 1, email }],
        history: [],
        status: idle,
        startedAt: 1000,
        now: 6000,
        ...overrides
    })
}

function values(output, name) {
    const prefix = `rewards_${name}`
    return output
        .split('\n')
        .filter(line => line.startsWith(`${prefix}{`) || line.startsWith(`${prefix} `))
        .map(line => Number(line.slice(line.lastIndexOf(' ') + 1)))
}

test('accounts without observations have unknown points and no invented balance', () => {
    const output = render()
    assert.deepEqual(values(output, 'api_uptime_seconds'), [5])
    assert.deepEqual(values(output, 'accounts_configured'), [1])
    assert.deepEqual(values(output, 'account_status'), [0])
    assert.deepEqual(values(output, 'account_points_known'), [0])
    assert.deepEqual(values(output, 'account_balance_points'), [])
    assert.deepEqual(values(output, 'account_collected_points'), [])
    assert.deepEqual(values(output, 'account_last_run_success'), [])
    assert.ok(output.endsWith('\n'))
})

test('persisted history survives idle startup, joins emails case-insensitively and skips session jobs', () => {
    const output = render({
        history: [
            history({ collected: 9999 }, { operation: 'session-regeneration' }),
            history({ email: email.toUpperCase() }),
            history({ email: 'removed@example.com', collected: 9000 })
        ]
    })
    assert.deepEqual(values(output, 'account_balance_points'), [1025])
    assert.deepEqual(values(output, 'account_collected_points'), [25])
    assert.deepEqual(values(output, 'account_status'), [2])
    assert.deepEqual(values(output, 'account_history_runs'), [1])
    assert.deepEqual(values(output, 'history_runs'), [2])
    assert.deepEqual(values(output, 'account_last_run_timestamp_seconds'), [Date.parse(endedAt) / 1000])
    assert.deepEqual(values(output, 'account_last_run_duration_seconds'), [300])
    assert.doesNotMatch(output, /removed@example.com/)
})

test('known zero is exported while unknown, missing and non-finite points are omitted', () => {
    const zero = render({ history: [history({ collected: 0, currentBalance: 0 })] })
    assert.deepEqual(values(zero, 'account_points_known'), [1])
    assert.deepEqual(values(zero, 'account_collected_points'), [0])
    assert.deepEqual(values(zero, 'account_balance_points'), [0])
    for (const account of [
        { collected: 0, pointsKnown: false },
        { collected: null },
        { collected: undefined },
        { collected: NaN },
        { collected: Infinity }
    ]) {
        const output = render({ history: [history(account)] })
        assert.deepEqual(values(output, 'account_points_known'), [0])
        assert.deepEqual(values(output, 'account_collected_points'), [])
    }
})

test('active rewards data overrides the previous run without duplicating history totals', () => {
    const output = render({
        history: [history()],
        status: {
            state: 'running',
            run: {
                operation: 'rewards',
                accounts: [
                    {
                        email,
                        status: 'running',
                        pointsKnown: true,
                        live: { balance: 1040, gained: 15, bySource: { dailySet: 15 }, lastUpdateTs: endedAt },
                        earnable: { mobile: 0, browser: 30, app: null },
                        streakProtection: { streakCounter: 10, remainingDays: 2 }
                    }
                ]
            }
        }
    })
    assert.deepEqual(values(output, 'run_active'), [1])
    assert.deepEqual(values(output, 'account_status'), [1])
    assert.deepEqual(values(output, 'account_balance_points'), [1040])
    assert.deepEqual(values(output, 'account_collected_points'), [15])
    assert.deepEqual(values(output, 'account_history_verified_collected_points'), [25])
    assert.deepEqual(values(output, 'account_collected_points_by_source'), [15])
    assert.deepEqual(values(output, 'account_remaining_points'), [0, 30])
    assert.deepEqual(values(output, 'account_streak_length'), [10])
    assert.deepEqual(values(output, 'account_streak_protection_remaining_seconds'), [172800])
})

test('session regeneration and stale idle state cannot replace rewards observations', () => {
    for (const status of [
        {
            state: 'running',
            run: { operation: 'session-regeneration', accounts: [{ email, live: { balance: 9999 } }] }
        },
        { state: 'idle', run: { operation: 'rewards', accounts: [{ email, live: { balance: 9999 } }] } }
    ]) {
        const output = render({ history: [history()], status })
        assert.deepEqual(values(output, 'run_active'), [0])
        assert.deepEqual(values(output, 'account_balance_points'), [1025])
        assert.deepEqual(values(output, 'account_collected_points'), [25])
    }
})

test('a failed run keeps the last verified balance and does not claim unknown credit', () => {
    const output = render({
        history: [
            history({ status: 'failed', success: false, pointsKnown: false, collected: null, currentBalance: null }),
            history()
        ]
    })
    assert.deepEqual(values(output, 'account_status'), [5])
    assert.deepEqual(values(output, 'account_last_run_success'), [0])
    assert.deepEqual(values(output, 'account_points_known'), [0])
    assert.deepEqual(values(output, 'account_balance_points'), [1025])
    assert.deepEqual(values(output, 'account_collected_points'), [])
    assert.deepEqual(values(output, 'account_history_verified_collected_points'), [25])
})

test('failed domain events preserve observed balances and do not introduce placeholder zeroes', () => {
    for (const observed of [false, true]) {
        const state = createRunState()
        const account = ensureAccount(state, email)
        if (observed) {
            applyDomainEvent(
                state,
                { ts: endedAt, data: { kind: 'balance', initialPoints: 1000, currentBalance: 1040 } },
                account
            )
        }
        applyDomainEvent(
            state,
            {
                ts: endedAt,
                data: {
                    kind: 'account',
                    email,
                    status: 'failed',
                    pointsKnown: false,
                    initialPoints: 0,
                    currentBalance: 0,
                    pointsGained: 0,
                    durationSeconds: 10
                }
            },
            account
        )
        const output = render({
            history: [history()],
            status: { state: 'running', run: { operation: 'rewards', accounts: [account] } }
        })
        assert.deepEqual(values(output, 'account_balance_points'), [observed ? 1040 : 1025])
        assert.deepEqual(values(output, 'account_points_known'), [0])
        assert.deepEqual(values(output, 'account_collected_points'), [])
    }
})

test('an observed historical balance is independent of unknown collected points', () => {
    const output = render({ history: [history({ currentBalance: 1040, collected: null, pointsKnown: false })] })
    assert.deepEqual(values(output, 'account_balance_points'), [1040])
    assert.deepEqual(values(output, 'account_points_known'), [0])
    assert.deepEqual(values(output, 'account_collected_points'), [])
})

test('labels escape quotes, backslashes and newlines and exclude account credentials', () => {
    const output = render({
        accounts: [{ index: 4, email: 'a"b\\c\n@example.com', password: 'secret-password', proxy: 'secret-proxy' }]
    })
    assert.ok(output.includes('rewards_account_info{account="4",email="a\\"b\\\\c\\n@example.com"} 1\n'))
    assert.doesNotMatch(output, /secret-password|secret-proxy/)
})

test('metrics use gauges for retained history and omit invalid observation timestamps', () => {
    const output = render({ history: [history({}, { endedAt: 'invalid' })] })
    assert.doesNotMatch(output, /^# TYPE .* counter$/m)
    assert.deepEqual(values(output, 'account_last_run_timestamp_seconds'), [])
    assert.deepEqual(values(output, 'account_balance_updated_timestamp_seconds'), [])
})

test('search summaries export separate devices without counting bonus or API reports as regular searches', () => {
    const output = render({
        history: [
            history({
                pointsKnown: false,
                searchSummary: { mobile: 60, desktop: 90, bonus: 100, apiReport: 50, total: 300 },
                earnable: { mobile: 70, browser: 100, app: 10 }
            })
        ]
    })
    assert.deepEqual(values(output, 'account_search_collected_points'), [60, 90])
    assert.deepEqual(values(output, 'account_search_points_known'), [1, 1])
    assert.deepEqual(values(output, 'account_search_available_points'), [70, 100])
    assert.match(
        output,
        /rewards_account_search_collected_points\{account="1",email="one@example.com",device="mobile"\} 60/
    )
    assert.match(
        output,
        /rewards_account_search_collected_points\{account="1",email="one@example.com",device="desktop"\} 90/
    )
})

test('search rows preserve unknown versus zero and omit invalid summary values', () => {
    const empty = render()
    assert.deepEqual(values(empty, 'account_search_info'), [1, 1])
    assert.deepEqual(values(empty, 'account_search_status'), [0, 0])
    assert.deepEqual(values(empty, 'account_search_points_known'), [0, 0])
    assert.deepEqual(values(empty, 'account_search_collected_points'), [])
    assert.deepEqual(values(empty, 'account_search_available_points'), [])
    for (const unknown of [null, NaN, Infinity, -1]) {
        const output = render({ history: [history({ searchSummary: { mobile: 0, desktop: unknown } })] })
        assert.deepEqual(values(output, 'account_search_collected_points'), [0])
        assert.deepEqual(values(output, 'account_search_points_known'), [1, 0])
    }
})

test('live device searches use verified activity outcomes and do not reuse earlier run results', () => {
    const state = createRunState()
    const account = ensureAccount(state, email)
    const activity = (platform, operationId, pointsGained, pointsKnown = true, status = 'confirmed') => {
        applyDomainEvent(
            state,
            {
                ts: endedAt,
                platform,
                data: {
                    kind: 'activity',
                    activity: 'search',
                    operationId,
                    pointsGained,
                    pointsKnown,
                    status,
                    reason: 'quota-complete'
                }
            },
            account
        )
    }
    activity('MOBILE', 'mobile-operation', 12)
    activity('MOBILE', 'mobile-operation', 12)
    activity('MOBILE', 'mobile-retry', 3)
    activity('DESKTOP', 'desktop-operation', 0, false, 'failed')
    const status = { state: 'running', run: { operation: 'rewards', accounts: [account] } }
    const output = render({ history: [history({ searchSummary: { mobile: 60, desktop: 90 } })], status })
    assert.deepEqual(values(output, 'account_search_collected_points'), [15])
    assert.deepEqual(values(output, 'account_search_points_known'), [1, 0])
    assert.deepEqual(values(output, 'account_search_status'), [1, 4])
    account.searchSummary = { mobile: 16, desktop: null }
    assert.deepEqual(values(render({ status }), 'account_search_collected_points'), [16])
})

test('an unknown regular search operation makes the device subtotal unknown; unrelated activities are excluded', () => {
    const output = render({
        history: [
            history({
                activities: [
                    {
                        activity: 'search',
                        platform: 'MOBILE',
                        operationId: 'a',
                        pointsGained: 10,
                        pointsKnown: true,
                        status: 'confirmed'
                    },
                    {
                        activity: 'search',
                        platform: 'mobile',
                        operationId: 'b',
                        pointsGained: 0,
                        pointsKnown: false,
                        status: 'unconfirmed'
                    },
                    {
                        activity: 'bonus-search',
                        platform: 'DESKTOP',
                        pointsGained: 100,
                        pointsKnown: true,
                        status: 'confirmed'
                    },
                    { activity: 'search', platform: 'DESKTOP', pointsGained: 0, pointsKnown: true, status: 'skipped' }
                ]
            })
        ]
    })
    assert.deepEqual(values(output, 'account_search_points_known'), [0, 1])
    assert.deepEqual(values(output, 'account_search_collected_points'), [0])
    assert.deepEqual(values(output, 'account_search_status'), [2, 3])
})

test('HTTP metrics require API authentication and use Prometheus content type', async t => {
    const key = 'ACCOUNT_987654321_EMAIL'
    const original = process.env[key]
    process.env[key] = 'http@example.com'
    t.after(() => {
        if (original === undefined) delete process.env[key]
        else process.env[key] = original
    })
    const authorize = createAccessControl({ token: 'monitoring-test-token', corsOrigin: '*' })
    const monitoring = createMonitoringRoutes({
        projectRoot: process.cwd(),
        pm: { getHistory: () => [], getStatus: () => idle },
        name: 'test',
        version: '1',
        token: 'monitoring-test-token',
        startedAt: Date.now(),
        logBuffer: 10,
        historySize: 10
    })
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost')
        if (!authorize(req, res, url)) return
        void monitoring(req, res, url, req.method, url.pathname).catch(error => {
            res.writeHead(500)
            res.end(error.message)
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise(resolve => server.close(resolve)))
    const base = `http://127.0.0.1:${server.address().port}`
    for (const [suffix, headers] of [
        ['', {}],
        ['', { Authorization: 'Bearer wrong' }],
        ['?token=monitoring-test-token', {}]
    ]) {
        const response = await fetch(`${base}/metrics${suffix}`, { headers })
        assert.equal(response.status, 401)
        await response.text()
    }
    for (const headers of [
        { Authorization: 'Bearer monitoring-test-token' },
        { 'X-API-Key': 'monitoring-test-token' }
    ]) {
        const response = await fetch(`${base}/metrics`, { headers })
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8')
        assert.equal(response.headers.get('cache-control'), 'no-store')
        assert.match(await response.text(), /rewards_account_info\{account="987654321",email="http@example.com"\} 1/)
    }
    const index = await fetch(`${base}/`, { headers: { Authorization: 'Bearer monitoring-test-token' } })
    assert.ok((await index.json()).endpoints.includes('GET /metrics'))
})
