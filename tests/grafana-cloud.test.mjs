import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
    cloudDashboard,
    grafanaCloudSettings,
    grafanaCloudLogSettings,
    installCloudDashboard
} from '../scripts/lib/grafanaCloud.js'

const template = JSON.parse(fs.readFileSync(new URL('../monitoring/grafana/dashboards/accounts.json', import.meta.url)))
const env = {
    GRAFANA_CLOUD_URL: 'https://example.grafana.net/',
    GRAFANA_CLOUD_SERVICE_ACCOUNT_TOKEN: 'service-token',
    GRAFANA_CLOUD_PROMETHEUS_DATASOURCE_UID: 'cloud-prometheus',
    GRAFANA_CLOUD_DEPLOYMENT: 'my-server'
}

test('Cloud settings come from env with a default deployment and a normalized stack URL', () => {
    assert.deepEqual(grafanaCloudSettings(env), {
        url: 'https://example.grafana.net',
        token: 'service-token',
        datasourceUid: 'cloud-prometheus',
        deployment: 'my-server'
    })
    assert.equal(grafanaCloudSettings({ ...env, GRAFANA_CLOUD_DEPLOYMENT: '' }).deployment, 'rewards')
    for (const key of [
        'GRAFANA_CLOUD_URL',
        'GRAFANA_CLOUD_SERVICE_ACCOUNT_TOKEN',
        'GRAFANA_CLOUD_PROMETHEUS_DATASOURCE_UID'
    ]) {
        assert.throws(() => grafanaCloudSettings({ ...env, [key]: '' }), new RegExp(key))
    }
})

test('Cloud setup refuses insecure URLs, embedded credentials and ambiguous stack addresses', () => {
    for (const url of [
        'http://example.grafana.net',
        'not-a-url',
        'https://user:password@example.grafana.net',
        'https://example.grafana.net?token=secret',
        'https://example.grafana.net#fragment'
    ]) {
        assert.throws(() => grafanaCloudSettings({ ...env, GRAFANA_CLOUD_URL: url }), /GRAFANA_CLOUD_URL/)
    }
})

test('Cloud dashboard selects its configured data source and deployment without mutating local defaults', () => {
    const result = cloudDashboard(template, grafanaCloudSettings(env))
    const variables = result.templating.list
    assert.equal(variables.find(variable => variable.name === 'datasource').current.value, 'cloud-prometheus')
    assert.equal(variables.find(variable => variable.name === 'deployment').current.value, 'my-server')
    assert.equal(
        template.templating.list.find(variable => variable.name === 'datasource').current.value,
        'rewards-prometheus'
    )
    assert.equal(result.uid, 'rewards-accounts')
    assert.equal(result.version, 0)
    assert.equal(result.id, undefined)
    const account = variables.find(variable => variable.name === 'account')
    assert.equal(account.multi, true)
    assert.ok(account.query.query.includes('deployment=~"${deployment:regex}"'))
    const device = variables.find(variable => variable.name === 'device')
    assert.equal(device.multi, true)
    assert.equal(device.allValue, '.*')
    assert.deepEqual(
        device.options.map(option => option.value),
        ['mobile', 'desktop']
    )
    const searches = result.panels.filter(panel => panel.title.startsWith('Search '))
    assert.equal(searches.length, 4)
    for (const panel of searches) {
        for (const target of panel.targets) {
            assert.ok(target.expr.includes('email=~"${account}"'), panel.title)
            assert.ok(target.expr.includes('device=~"${device:regex}"'), panel.title)
        }
    }
    for (const panel of result.panels) {
        assert.equal(panel.datasource.uid, '${datasource}')
        for (const target of panel.targets) {
            assert.equal(target.datasource.uid, '${datasource}')
            assert.ok(target.expr.includes('deployment=~"${deployment:regex}"'), panel.title)
            // Let the Prometheus data source escape email regexes inside PromQL strings.
            if (target.expr.includes('email=~')) {
                assert.ok(target.expr.includes('email=~"${account}"'), panel.title)
                assert.ok(!target.expr.includes('${account:regex}'), panel.title)
            }
        }
    }
    assert.ok(!JSON.stringify(result).includes('service-token'))
})

test('Cloud installation checks the data source and posts an idempotent dashboard with the service token', async () => {
    const calls = []
    const result = await installCloudDashboard({
        settings: grafanaCloudSettings(env),
        dashboard: template,
        request: async (url, options) => {
            calls.push({ url, options })
            return Response.json(calls.length === 1 ? { type: 'prometheus' } : { status: 'success' })
        }
    })
    assert.equal(result.status, 'success')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, 'https://example.grafana.net/api/datasources/uid/cloud-prometheus')
    assert.equal(calls[1].url, 'https://example.grafana.net/api/dashboards/db')
    assert.equal(calls[1].options.method, 'POST')
    assert.equal(calls[1].options.headers.Authorization, 'Bearer service-token')
    assert.equal(calls[1].options.redirect, 'error')
    const body = JSON.parse(calls[1].options.body)
    assert.equal(body.overwrite, true)
    assert.equal(body.dashboard.uid, 'rewards-accounts')
    assert.ok(!calls[1].options.body.includes('service-token'))
})

test('Cloud setup rejects a non-Prometheus data source before creating a dashboard', async () => {
    let calls = 0
    await assert.rejects(
        installCloudDashboard({
            settings: grafanaCloudSettings(env),
            dashboard: template,
            request: async () => {
                calls++
                return Response.json({ type: 'loki' })
            }
        }),
        /must be Prometheus/
    )
    assert.equal(calls, 1)
})

test('Cloud authentication and permission errors fail without exposing returned secrets', async () => {
    for (const status of [401, 403, 500]) {
        await assert.rejects(
            installCloudDashboard({
                settings: grafanaCloudSettings(env),
                dashboard: template,
                request: async () => new Response('service-token is private', { status })
            }),
            error => error.message.includes(`HTTP ${status}`) && !error.message.includes('service-token')
        )
    }
})

test('search diagnostic dashboard provisions a Loki source without requiring Prometheus settings', async () => {
    const dashboard = JSON.parse(
        fs.readFileSync(new URL('../monitoring/grafana/dashboards/search-diagnostics.json', import.meta.url))
    )
    const settings = grafanaCloudLogSettings({
        ...env,
        GRAFANA_CLOUD_PROMETHEUS_DATASOURCE_UID: '',
        GRAFANA_CLOUD_LOKI_DATASOURCE_UID: 'cloud-loki'
    })
    const result = cloudDashboard(dashboard, settings)
    assert.equal(result.templating.list.find(variable => variable.name === 'datasource').current.value, 'cloud-loki')
    assert.equal(result.templating.list.find(variable => variable.name === 'deployment').current.value, 'my-server')
    assert.equal(result.panels.filter(panel => panel.type === 'logs').length, 1)
    const calls = []
    await installCloudDashboard({
        settings,
        dashboard,
        datasourceType: 'loki',
        request: async (_url, options) => {
            calls.push(options)
            return Response.json(calls.length === 1 ? { type: 'loki' } : { status: 'success' })
        }
    })
    assert.equal(calls.length, 2)
    assert.equal(JSON.parse(calls[1].body).dashboard.uid, 'rewards-search-diagnostics')
    await assert.rejects(
        installCloudDashboard({
            settings,
            dashboard,
            datasourceType: 'loki',
            request: async () => Response.json({ type: 'prometheus' })
        }),
        /must be Loki/
    )
})
