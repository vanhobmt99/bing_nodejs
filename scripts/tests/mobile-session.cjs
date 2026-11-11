const assert = require('node:assert/strict')
const { test } = require('node:test')
const store = require('../../dist/session/SessionStore')
const rewardsContext = require('../../dist/browser/RewardsBrowserContext')
const BrowserManager = require('../../dist/browser/BrowserManager').default

test('mobile restores only its own cookies and starts without desktop cookies when none are saved', async () => {
    const originalLoad = store.loadSession
    const originalSave = store.saveFingerprint
    const originalContext = rewardsContext.newRewardsBrowserContext
    const fingerprint = {
        headers: { 'accept-language': 'vi-VN' },
        fingerprint: {
            navigator: { language: 'vi-VN', platform: 'Linux armv8l', userAgent: 'mobile-test' },
            screen: { width: 390, height: 844, devicePixelRatio: 3 }
        }
    }
    const cookie = value => ({ name: '_U', value, domain: '.bing.com', path: '/', expires: -1 })
    const mobileState = { cookies: [cookie('mobile-auth')], origins: [] }
    let savedState = mobileState
    let contextOptions
    store.loadSession = () => ({ storageState: savedState, fingerprint, updatedAt: Date.now() })
    store.saveFingerprint = () => undefined
    rewardsContext.newRewardsBrowserContext = async (_browser, _fingerprint, options) => {
        contextOptions = options
        return { on() {} }
    }
    try {
        const bot = {
            isMobile: true,
            config: { headless: true, proxy: {}, sessionPath: 'unused' },
            logger: { debug() {}, info() {}, warn() {}, error() {} },
            accountLocale: { locale: 'vi-VN', acceptLanguage: 'vi-VN' },
            cookies: { desktop: [cookie('desktop-auth')], mobile: [] },
            mainDesktopPage: {
                isClosed: () => false,
                context: () => ({ cookies: async () => [cookie('desktop-auth')] })
            }
        }
        const manager = new BrowserManager(bot)
        manager.rootBrowser = { isConnected: () => true, version: () => '156.0.8078.4' }
        manager.rootAccountEmail = 'test@example.invalid'
        manager.userAgentManager.matchesFingerprint = () => true
        manager.userAgentManager.updateFingerprintUserAgent = async fp => fp
        const account = { email: 'test@example.invalid', proxy: {}, saveFingerprint: { mobile: true } }
        await manager.createBrowser(account)
        assert.deepEqual(contextOptions.storageState, mobileState)
        savedState = null
        await manager.createBrowser(account)
        assert.equal(contextOptions.storageState, undefined)
    } finally {
        store.loadSession = originalLoad
        store.saveFingerprint = originalSave
        rewardsContext.newRewardsBrowserContext = originalContext
    }
})
