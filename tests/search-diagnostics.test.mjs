import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createSearchDiagnosticLog } from '../dist/control-api/searchDiagnosticLog.js'
import { isDomainEvent } from '../dist/control-api/logs/domainEvents.js'
import { ProcessManager } from '../dist/control-api/processManager.js'

const require = createRequire(import.meta.url)
const { Logger } = require('../dist/logging/Logger.js')
const { logSearchDiagnostic } = require('../dist/logging/SearchDiagnostic.js')
const { LoginSession } = require('../dist/browser/auth/LoginSession.js')
const { SearchProgress } = require('../dist/rewards/shared/search/SearchProgress.js')
const { BrowserSearch } = require('../dist/rewards/browser/search/BrowserSearch.js')

function entry(data = {}) {
    return {
        ts: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        user: 'diagnostic@example.test',
        platform: 'MOBILE',
        level: 'warn',
        runId: 'diagnostic-run',
        data: { kind: 'search-diagnostic', stage: 'progress', status: 'no-credit', reason: 'batch-measured', ...data }
    }
}

function directory(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-search-diagnostics-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

test('diagnostic log whitelists fields, preserves null versus zero, and redacts credential-shaped values', t => {
    const file = path.join(directory(t), 'events.jsonl')
    const write = createSearchDiagnosticLog(file)
    write(
        entry({
            pointsGained: 0,
            remaining: null,
            password: 'never-export',
            cookie: '_U=private',
            source: 'https://user:secret@proxy.test/?token=private'
        })
    )
    const text = fs.readFileSync(file, 'utf8')
    const record = JSON.parse(text)
    assert.equal(record.pointsGained, 0)
    assert.equal(record.remaining, null)
    assert.equal(record.device, 'mobile')
    assert.equal(record.runId, 'diagnostic-run')
    assert.doesNotMatch(text, /never-export|_U=private|user:secret|token=private/)
    assert.equal(record.password, undefined)
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('diagnostic log rotates and retains only three archives', t => {
    const dir = directory(t)
    const file = path.join(dir, 'events.jsonl')
    const write = createSearchDiagnosticLog(file, { maxBytes: 1 })
    for (let attempt = 1; attempt <= 8; attempt++) write(entry({ attempt }))
    assert.deepEqual(fs.readdirSync(dir).sort(), ['events.jsonl', 'events.jsonl.1', 'events.jsonl.2', 'events.jsonl.3'])
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).attempt, 8)
    assert.equal(JSON.parse(fs.readFileSync(`${file}.3`, 'utf8')).attempt, 5)
})

test('invalid events are excluded and disk errors are nonfatal with bounded warnings', t => {
    const dir = directory(t)
    const file = path.join(dir, 'events.jsonl')
    const write = createSearchDiagnosticLog(file)
    for (const data of [{ stage: 'unknown-stage' }, { batchPoints: -1 }, { attempt: 0.5 }]) {
        assert.equal(isDomainEvent(entry(data).data), false)
        write(entry(data))
    }
    write({ ...entry(), platform: 'MAIN' })
    assert.equal(fs.existsSync(file), false)
    fs.writeFileSync(file, 'not a directory')
    const warnings = []
    const blocked = createSearchDiagnosticLog(path.join(file, 'child'), {
        onWarning: message => warnings.push(message)
    })
    assert.doesNotThrow(() => {
        blocked(entry())
        blocked(entry())
    })
    assert.equal(warnings.length, 1)
})

test('diagnostic events reach the Control API log file while debug logging and console output are disabled', t => {
    const cwd = directory(t)
    const manager = new ProcessManager({ command: process.execPath, cwd })
    const logger = new Logger({
        config: {
            debugLogs: false,
            errorDiagnostics: false,
            consoleLogFilter: { enabled: true, mode: 'whitelist', levels: ['error'] },
            webhook: { webhookLogFilter: { enabled: false } }
        },
        currentAccountEmail: 'diagnostic@example.test',
        userData: {},
        isMobile: true
    })
    const oldControl = process.env.REWARDS_CONTROL_EVENTS
    const oldRun = process.env.REWARDS_RUN_ID
    const original = console.log
    process.env.REWARDS_CONTROL_EVENTS = '1'
    process.env.REWARDS_RUN_ID = 'diagnostic-run'
    console.log = line => manager._handleLine('stdout', line)
    try {
        logSearchDiagnostic({ logger }, true, { stage: 'signin', status: 'unverified', reason: 'no-signin-evidence' })
    } finally {
        console.log = original
        if (oldControl === undefined) delete process.env.REWARDS_CONTROL_EVENTS
        else process.env.REWARDS_CONTROL_EVENTS = oldControl
        if (oldRun === undefined) delete process.env.REWARDS_RUN_ID
        else process.env.REWARDS_RUN_ID = oldRun
    }
    const record = JSON.parse(fs.readFileSync(path.join(cwd, 'diagnostics/search/events.jsonl'), 'utf8'))
    assert.equal(record.stage, 'signin')
    assert.equal(record.status, 'unverified')
    assert.equal(record.level, 'warn')
    assert.equal(record.email, 'diagnostic@example.test')
    assert.equal(manager.getLogs().logs.at(-1).consoleAllowed, false)
})

function diagnosticBot() {
    const events = []
    const bot = {
        isMobile: true,
        signal: new AbortController().signal,
        config: { globalTimeout: 10, searchSettings: { runOnZeroPoints: false } },
        userData: { currentPoints: 100 },
        logger: Object.fromEntries(['debug', 'info', 'warn', 'error', 'success'].map(level => [level, () => {}])),
        browser: { userAgentManager: { isRealEdge: () => false }, utils: { dismissMessages: async () => {} } },
        utils: { wait: async () => {} },
        rewards: {
            getDashboardData: async () => ({ dashboard: { userStatus: { availablePoints: 100, counters: {} } } }),
            getEarnSearchQuota: async () => null
        },
        recordActivity: () => {}
    }
    bot.logger.event = (_mobile, _title, _message, data) => events.push(data)
    return { bot, events }
}

test('unsuccessful Bing verification is visible without exposing cookies', async () => {
    const { bot, events } = diagnosticBot()
    const page = {
        goto: async () => {},
        url: () => 'https://www.bing.com/',
        isClosed: () => false,
        waitForFunction: async () => {
            throw new Error('No profile')
        },
        context: () => ({ cookies: async () => [] })
    }
    assert.equal(await new LoginSession(bot, async () => {}).verifyBingSession(page, {}), false)
    assert.equal(events[0].status, 'started')
    assert.equal(events.filter(event => event.status === 'unverified').length, 5)
    assert.ok(events.every(isDomainEvent))
})

test('unknown quotas and zero-point probe outcomes stay distinct from verified completion in diagnostics', async () => {
    const { bot, events } = diagnosticBot()
    const missing = await new SearchProgress(bot).getMissing(true)
    assert.equal(missing.available, false)
    const quota = events.find(event => event.stage === 'quota')
    assert.equal(quota.status, 'unavailable')
    assert.equal(quota.remaining, null)
    const search = new BrowserSearch(bot)
    search.runSearchSession = async (_page, _mobile, tracker) => {
        await tracker.prepare()
        return { performed: 5, stagnant: 2, totalGained: 0 }
    }
    await search.search({}, true)
    const outcome = events.find(event => event.stage === 'outcome' && event.status !== 'started')
    assert.equal(outcome.status, 'stopped')
    assert.equal(outcome.reason, 'quota-probe-no-credit')
    assert.equal(outcome.pointsGained, 0)
    assert.equal(outcome.quotaAvailable, false)
    assert.ok(events.every(isDomainEvent))
})

test('failed quota reads are recorded and keep the original exception', async () => {
    const { bot, events } = diagnosticBot()
    const failure = new Error('backend unavailable')
    bot.rewards.getDashboardData = async () => {
        throw failure
    }
    await assert.rejects(new SearchProgress(bot).getMissing(true), error => error === failure)
    assert.equal(events.at(-1).reason, 'quota-read-error')
    assert.equal(events.at(-1).quotaAvailable, false)
    assert.ok(isDomainEvent(events.at(-1)))
})
