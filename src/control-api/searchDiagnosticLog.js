import fs from 'node:fs'
import path from 'node:path'
import { isDomainEvent } from './logs/domainEvents.js'
import { sanitizeLogMessage } from '../../scripts/lib/logging.cjs'

const FIELDS = [
    'stage',
    'status',
    'reason',
    'source',
    'errorCode',
    'attempt',
    'searches',
    'stagnant',
    'stagnantLimit',
    'quotaAvailable',
    'earned',
    'remaining',
    'max',
    'pointsGained',
    'batchPoints',
    'balance'
]

/** @param {string} file @param {{ maxBytes?: number, onWarning?: (message: string) => void }} [options] */
export function createSearchDiagnosticLog(file, { maxBytes = 5 * 1024 * 1024, onWarning = () => {} } = {}) {
    let lastWarning = -Infinity
    return entry => {
        if (entry.data?.kind !== 'search-diagnostic' || !isDomainEvent(entry.data)) return
        if (!['MOBILE', 'DESKTOP'].includes(entry.platform)) return
        const record = {
            ts: entry.receivedAt ?? entry.ts,
            email: sanitizeLogMessage(String(entry.user ?? '')).slice(0, 320),
            device: entry.platform.toLowerCase(),
            runId: String(entry.runId ?? '').slice(0, 128),
            level: entry.level,
            ...Object.fromEntries(
                FIELDS.filter(key => entry.data[key] !== undefined).map(key => {
                    const value = entry.data[key]
                    return [key, typeof value === 'string' ? sanitizeLogMessage(value).slice(0, 200) : value]
                })
            )
        }
        const line = JSON.stringify(record) + '\n'
        try {
            const directory = path.dirname(file)
            if (fs.existsSync(directory) && fs.statSync(directory).mode & 0o077) fs.chmodSync(directory, 0o700)
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
            const size = fs.existsSync(file) ? fs.statSync(file).size : 0
            if (size && size + Buffer.byteLength(line) > maxBytes) {
                for (let index = 2; index >= 0; index--) {
                    const source = index === 0 ? file : `${file}.${index}`
                    if (fs.existsSync(source)) fs.renameSync(source, `${file}.${index + 1}`)
                }
            }
            fs.appendFileSync(file, line, { mode: 0o600 })
        } catch {
            if (Date.now() - lastWarning >= 60000) {
                lastWarning = Date.now()
                onWarning(
                    'Could not persist search diagnostics; check diagnostics directory permissions and disk space.'
                )
            }
        }
    }
}
