import { envStrFrom } from './env.js'

function required(sourceEnv, name) {
    const value = envStrFrom(sourceEnv, name)
    if (!value) throw new Error(`${name} is required in .env.`)
    return value
}

function dashboardSettings(sourceEnv, datasourceKey) {
    const rawUrl = required(sourceEnv, 'GRAFANA_CLOUD_URL')
    let url
    try {
        url = new URL(rawUrl)
    } catch {
        throw new Error('GRAFANA_CLOUD_URL must be a valid HTTPS Grafana stack URL.')
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('GRAFANA_CLOUD_URL must use HTTPS without embedded credentials, a query or a fragment.')
    }
    return {
        url: url.toString().replace(/\/+$/, ''),
        token: required(sourceEnv, 'GRAFANA_CLOUD_SERVICE_ACCOUNT_TOKEN'),
        datasourceUid: required(sourceEnv, datasourceKey),
        deployment: envStrFrom(sourceEnv, 'GRAFANA_CLOUD_DEPLOYMENT') ?? 'rewards'
    }
}

export function grafanaCloudSettings(sourceEnv = process.env) {
    return dashboardSettings(sourceEnv, 'GRAFANA_CLOUD_PROMETHEUS_DATASOURCE_UID')
}

export function grafanaCloudLogSettings(sourceEnv = process.env) {
    return dashboardSettings(sourceEnv, 'GRAFANA_CLOUD_LOKI_DATASOURCE_UID')
}

export function cloudDashboard(source, { datasourceUid, deployment }) {
    const dashboard = structuredClone(source)
    delete dashboard.id
    dashboard.version = 0
    const datasource = dashboard.templating.list.find(variable => variable.name === 'datasource')
    const instance = dashboard.templating.list.find(variable => variable.name === 'deployment')
    if (!datasource || !instance) throw new Error('Dashboard data source or deployment variable is missing.')
    datasource.current = { selected: true, text: datasourceUid, value: datasourceUid }
    instance.current = { selected: true, text: deployment, value: deployment }
    return dashboard
}

export async function installCloudDashboard({ settings, dashboard, datasourceType = 'prometheus', request = fetch }) {
    const headers = { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' }
    const send = async (path, options = {}) => {
        const response = await request(`${settings.url}${path}`, {
            ...options,
            headers,
            signal: AbortSignal.timeout(30000),
            redirect: 'error'
        })
        if (!response.ok) throw new Error(`Grafana request ${path} failed (HTTP ${response.status}).`)
        return response.json()
    }
    const source = await send(`/api/datasources/uid/${encodeURIComponent(settings.datasourceUid)}`)
    if (source.type !== datasourceType)
        throw new Error(
            `The selected Grafana Cloud data source must be ${datasourceType === 'loki' ? 'Loki' : 'Prometheus'}.`
        )
    return send('/api/dashboards/db', {
        method: 'POST',
        body: JSON.stringify({
            dashboard: cloudDashboard(dashboard, settings),
            overwrite: true,
            message: 'Provision Microsoft Rewards account monitoring'
        })
    })
}
