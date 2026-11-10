const ACCOUNT_STATUSES = ['never_run', 'running', 'completed', 'partial', 'skipped', 'failed', 'cancelled', 'unknown']

const METRICS = {
    api_uptime_seconds: 'Control API uptime in seconds.',
    accounts_configured: 'Number of configured account slots.',
    run_active: 'Whether a rewards run is currently active; session-generation jobs are excluded.',
    history_runs: 'Number of retained completed rewards runs, not a lifetime counter.',
    account_info: 'Configured account slot and email.',
    account_status:
        'Account state: 0 never run, 1 running, 2 completed, 3 partial, 4 skipped, 5 failed, 6 cancelled, 7 unknown.',
    account_balance_points: 'Latest observed account balance; absent when no balance has been observed.',
    account_balance_updated_timestamp_seconds: 'Unix timestamp of the exported balance observation.',
    account_points_known: 'Whether collected points are known for the current or latest account run.',
    account_collected_points: 'Verified points collected in the current or latest account run; not a counter.',
    account_collected_points_by_source: 'Attributed points by activity in the current or latest account run.',
    account_last_run_timestamp_seconds: 'Unix timestamp of the latest completed account run.',
    account_last_run_duration_seconds: 'Duration of the latest completed account run.',
    account_last_run_success: 'Whether the latest completed account run succeeded.',
    account_history_runs: 'Account runs in retained history, not a lifetime counter.',
    account_history_successes: 'Successful account runs in retained history, not a lifetime counter.',
    account_history_verified_collected_points: 'Known collected points in retained history; unknown runs are excluded.',
    account_remaining_points: 'Last observed remaining earnable points by pool: mobile, browser or app.',
    account_search_info: 'Configured account and search device.',
    account_search_points_known: 'Whether regular search points are known for the current or latest run and device.',
    account_search_collected_points:
        'Verified regular search points in the current or latest run by device; excludes bonus and API report points.',
    account_search_available_points: 'Search points available at the start of the current or latest run by device.',
    account_search_status:
        'Latest regular search activity state: 0 unobserved, 1 confirmed, 2 unconfirmed, 3 skipped, 4 failed.',
    account_streak_length: 'Last observed daily streak length in consecutive calendar days.',
    account_streak_protection_remaining_seconds: 'Last observed remaining streak protection time in seconds.'
}

function escapeLabel(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function timestamp(value) {
    if (typeof value !== 'string' || !value) return null
    const milliseconds = Date.parse(value)
    return Number.isFinite(milliseconds) ? milliseconds / 1000 : null
}

function balanceOf(account, historical = false) {
    if (historical) return account?.currentBalance
    if (Number.isFinite(account?.live?.balance)) return account.live.balance
    if (account?.pointsKnown === false) return null
    return account?.finalPoints
}

function searchObservation(account, device) {
    const activities = (account?.activities ?? []).filter(
        activity => activity.activity === 'search' && activity.platform?.toLowerCase() === device
    )
    const latest = activities.at(-1)
    const statuses = ['unobserved', 'confirmed', 'unconfirmed', 'skipped', 'failed']
    const status = Math.max(0, statuses.indexOf(latest?.status))
    if (account?.searchSummary && Object.hasOwn(account.searchSummary, device)) {
        return { points: account.searchSummary[device], status }
    }
    if (!activities.length) return { points: null, status }
    const operations = new Map()
    for (const activity of activities) operations.set(activity.operationId ?? 'legacy', activity)
    const results = [...operations.values()]
    const known = results.every(
        result => result.pointsKnown !== false && Number.isFinite(result.pointsGained) && result.pointsGained >= 0
    )
    return { points: known ? results.reduce((total, result) => total + result.pointsGained, 0) : null, status }
}

export function renderMetrics({ accounts, history, status, startedAt, now = Date.now() }) {
    const samples = new Map(Object.keys(METRICS).map(name => [name, /** @type {string[]} */ ([])]))
    const add = (name, value, labels = {}) => {
        if (!Number.isFinite(value)) return
        const entries = Object.entries(labels)
        const suffix = entries.length
            ? `{${entries.map(([key, label]) => `${key}="${escapeLabel(label)}"`).join(',')}}`
            : ''
        samples.get(name)?.push(`rewards_${name}${suffix} ${value}`)
    }

    const runs = history.filter(run => run.operation !== 'session-regeneration')
    const resultsByEmail = new Map()
    for (const run of runs) {
        for (const account of run.accounts ?? []) {
            const key = account.email.toLowerCase()
            if (!resultsByEmail.has(key)) resultsByEmail.set(key, [])
            resultsByEmail.get(key).push({ ...account, when: run.endedAt ?? run.startedAt })
        }
    }

    const active = status.state !== 'idle' && status.run.operation === 'rewards'
    const liveByEmail = new Map(
        (active ? status.run.accounts : []).map(account => [account.email.toLowerCase(), account])
    )
    add('api_uptime_seconds', Math.max(0, (now - startedAt) / 1000))
    add('accounts_configured', accounts.length)
    add('run_active', Number(active))
    add('history_runs', runs.length)

    for (const account of accounts) {
        const labels = { account: account.index, email: account.email }
        const results = resultsByEmail.get(account.email.toLowerCase()) ?? []
        const last = results[0]
        const live = liveByEmail.get(account.email.toLowerCase())
        const current = live ?? last
        const state = current
            ? (current.status ??
              (live
                  ? 'running'
                  : current.success === true
                    ? 'completed'
                    : current.success === false
                      ? 'failed'
                      : 'unknown'))
            : 'never_run'
        const stateCode = ACCOUNT_STATUSES.indexOf(state)
        add('account_info', 1, labels)
        add('account_status', stateCode < 0 ? 7 : stateCode, labels)
        const collected = live ? (live.collectedPoints ?? live.live?.gained) : last?.collected
        const pointsKnown = current?.pointsKnown !== false && Number.isFinite(collected)
        add('account_points_known', Number(pointsKnown), labels)
        add('account_history_runs', results.length, labels)
        add('account_history_successes', results.filter(result => result.success === true).length, labels)
        add(
            'account_history_verified_collected_points',
            results.reduce(
                (total, result) =>
                    total + (result.pointsKnown !== false && Number.isFinite(result.collected) ? result.collected : 0),
                0
            ),
            labels
        )

        const balanceResult = results.find(result => Number.isFinite(balanceOf(result, true)))
        const liveBalance = balanceOf(live)
        add(
            'account_balance_points',
            Number.isFinite(liveBalance) ? liveBalance : balanceOf(balanceResult, true),
            labels
        )
        add(
            'account_balance_updated_timestamp_seconds',
            timestamp(
                Number.isFinite(liveBalance)
                    ? (live.live?.lastUpdateTs ?? live.accountUpdatedAt)
                    : (balanceResult?.accountUpdatedAt ?? balanceResult?.when)
            ),
            labels
        )

        if (pointsKnown) add('account_collected_points', collected, labels)
        for (const [source, points] of Object.entries((live ? live.live?.bySource : last?.bySource) ?? {})) {
            add('account_collected_points_by_source', points, { ...labels, source })
        }
        add('account_last_run_timestamp_seconds', timestamp(last?.when), labels)
        add('account_last_run_duration_seconds', last?.durationSeconds, labels)
        if (typeof last?.success === 'boolean') add('account_last_run_success', Number(last.success), labels)

        const quota = live?.earnable ?? last?.earnable
        for (const pool of ['mobile', 'browser', 'app']) {
            add('account_remaining_points', quota?.[pool], { ...labels, pool })
        }
        for (const device of ['mobile', 'desktop']) {
            const deviceLabels = { ...labels, device }
            const observation = searchObservation(current, device)
            const known = Number.isFinite(observation.points) && observation.points >= 0
            add('account_search_info', 1, deviceLabels)
            add('account_search_points_known', Number(known), deviceLabels)
            add('account_search_status', observation.status, deviceLabels)
            if (known) add('account_search_collected_points', observation.points, deviceLabels)
            add(
                'account_search_available_points',
                current?.earnable?.[device === 'desktop' ? 'browser' : 'mobile'],
                deviceLabels
            )
        }
        const protection = live?.streakProtection ?? results.find(result => result.streakProtection)?.streakProtection
        add('account_streak_length', protection?.streakCounter, labels)
        add(
            'account_streak_protection_remaining_seconds',
            typeof protection?.remainingDays === 'number' ? protection.remainingDays * 86400 : null,
            labels
        )
    }

    return (
        Object.entries(METRICS)
            .flatMap(([name, help]) => [
                `# HELP rewards_${name} ${help}`,
                `# TYPE rewards_${name} gauge`,
                ...(samples.get(name) ?? [])
            ])
            .join('\n') + '\n'
    )
}
