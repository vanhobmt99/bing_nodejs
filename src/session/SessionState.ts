import type { BrowserContext, Cookie } from 'patchright'

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

const SESSION_COOKIE_DOMAINS = ['bing.com', 'live.com', 'microsoft.com', 'microsoftonline.com', 'msn.com']
const DESKTOP_BING_TRACKING_COOKIE_PATTERN = /^(?:SRCH|MUID|_SS|_RwBf|_Rwho|_EDGE_|_HPVN|WLS|USRLOC|BCP|BFBUSR)/

export function isNonRewardsBingDomain(rawDomain: string): boolean {
    const domain = rawDomain.replace(/^\./, '').toLowerCase()
    return (domain === 'bing.com' || domain.endsWith('.bing.com')) && domain !== 'rewards.bing.com'
}

export function isDesktopBingTrackingCookie(cookie: Pick<Cookie, 'domain' | 'name'>): boolean {
    return isNonRewardsBingDomain(cookie.domain) && DESKTOP_BING_TRACKING_COOKIE_PATTERN.test(cookie.name)
}

export function hasDesktopBingCookieSignature(
    cookies: readonly Pick<Cookie, 'domain' | 'name' | 'value'>[],
    mobileViewportWidth?: number,
    mobileDeviceScaleFactor?: number
): boolean {
    const minDesktopWidth = mobileViewportWidth ? Math.max(mobileViewportWidth + 100, 600) : 700
    for (const cookie of cookies) {
        if (!isNonRewardsBingDomain(cookie.domain) || cookie.name !== 'SRCHHPGUSR') continue
        const widthMatch = /(?:^|&)CW=(\d+)/i.exec(cookie.value)
        if (widthMatch && Number(widthMatch[1]) >= minDesktopWidth) return true
        const dprMatch = /(?:^|&)DPR=(\d+(?:\.\d+)?)/i.exec(cookie.value)
        if (dprMatch && mobileDeviceScaleFactor && mobileDeviceScaleFactor >= 1.5 && Number(dprMatch[1]) <= 1) {
            return true
        }
    }
    return false
}

export function stripDesktopBingTrackingCookies<T extends Pick<Cookie, 'domain' | 'name'>>(
    cookies: readonly T[]
): { cookies: T[]; removed: number } {
    const kept = cookies.filter(cookie => !isDesktopBingTrackingCookie(cookie))
    return { cookies: kept, removed: cookies.length - kept.length }
}

export function filterSessionCookies(cookies: readonly Cookie[]): Cookie[] {
    const now = Date.now() / 1000
    return cookies.filter(cookie => {
        if (cookie.expires !== -1 && Number.isFinite(cookie.expires) && cookie.expires <= now) return false
        const domain = cookie.domain.replace(/^\./, '').toLowerCase()
        return SESSION_COOKIE_DOMAINS.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`))
    })
}

export function createSessionState(cookies: readonly Cookie[]): StorageState {
    return { cookies: filterSessionCookies(cookies), origins: [] }
}
