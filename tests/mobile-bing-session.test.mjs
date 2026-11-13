import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { FingerprintGenerator } from 'fingerprint-generator'
import { chromium } from 'patchright'

const require = createRequire(import.meta.url)
const {
    hasDesktopBingCookieSignature,
    isDesktopBingTrackingCookie,
    isNonRewardsBingDomain,
    stripDesktopBingTrackingCookies
} = require('../dist/session/SessionState.js')
const {
    closeRewardsTaskContext,
    createRewardsTaskContext,
    filterTaskCookieChangesForSource,
    newRewardsBrowserContext,
    synchronizeRewardsCookies
} = require('../dist/browser/RewardsBrowserContext.js')
const { getBingSignInEvidence, isSignedOutBingEvidence } = require('../dist/browser/auth/LoginSession.js')

let browser
before(async () => {
    browser = await chromium.launch({ headless: true })
})
after(async () => {
    await browser?.close()
})

test('desktop Bing tracking cookie helpers isolate Bing UI cookies while preserving MSA auth', () => {
    assert.equal(isNonRewardsBingDomain('.bing.com'), true)
    assert.equal(isNonRewardsBingDomain('www.bing.com'), true)
    assert.equal(isNonRewardsBingDomain('rewards.bing.com'), false)
    assert.equal(isNonRewardsBingDomain('.live.com'), false)

    const cookies = [
        { name: 'SRCHHPGUSR', value: 'SRCHLANG=en&CW=1280&CH=720&DPR=1', domain: '.bing.com', path: '/' },
        { name: 'MUID', value: 'desktop-muid', domain: '.bing.com', path: '/' },
        { name: 'MUIDB', value: 'desktop-muidb', domain: '.bing.com', path: '/' },
        { name: '_EDGE_S', value: 'desktop-edge', domain: '.bing.com', path: '/' },
        { name: '_U', value: 'auth-u', domain: '.bing.com', path: '/' },
        { name: '.MSA.Auth', value: 'msa-auth', domain: 'www.bing.com', path: '/' },
        { name: 'MUID', value: 'rewards-muid', domain: 'rewards.bing.com', path: '/' },
        { name: 'MSPAuth', value: 'live-auth', domain: '.live.com', path: '/' }
    ]

    assert.equal(hasDesktopBingCookieSignature(cookies, 360, 2.5), true)
    assert.equal(
        hasDesktopBingCookieSignature(
            [{ name: 'SRCHHPGUSR', value: 'CW=360&CH=800&DPR=2.625', domain: '.bing.com', path: '/' }],
            360,
            2.625
        ),
        false
    )
    assert.equal(isDesktopBingTrackingCookie(cookies[4]), false)

    const stripped = stripDesktopBingTrackingCookies(cookies)
    assert.equal(stripped.removed, 4)
    assert.deepEqual(
        stripped.cookies.map(cookie => `${cookie.name}@${cookie.domain}`),
        ['_U@.bing.com', '.MSA.Auth@www.bing.com', 'MUID@rewards.bing.com', 'MSPAuth@.live.com']
    )
})

test('filterTaskCookieChangesForSource drops non-rewards bing.com deltas for mobile contexts', () => {
    const changes = new Map([
        ['.bing.com|/|MUIDB|', { name: 'MUIDB', value: 'x', domain: '.bing.com', path: '/' }],
        ['www.bing.com|/|SRCHHPGUSR|', undefined],
        ['rewards.bing.com|/|_RwBf|', { name: '_RwBf', value: 'y', domain: 'rewards.bing.com', path: '/' }],
        ['.live.com|/|MSPRequ|', { name: 'MSPRequ', value: 'z', domain: '.live.com', path: '/' }]
    ])

    const mobileFiltered = filterTaskCookieChangesForSource(changes, true)
    assert.deepEqual([...mobileFiltered.keys()], ['rewards.bing.com|/|_RwBf|', '.live.com|/|MSPRequ|'])

    const desktopFiltered = filterTaskCookieChangesForSource(changes, false)
    assert.equal(desktopFiltered.size, 4)
})

test('synchronizeRewardsCookies keeps mobile .bing.com cookies isolated from desktop-app task context', async () => {
    const generator = new FingerprintGenerator()
    const fingerprint = generator.getFingerprint({
        devices: ['mobile'],
        operatingSystems: ['android'],
        locales: ['en-US']
    })

    const mobileContext = await newRewardsBrowserContext(browser, fingerprint, {
        isMobile: true,
        hasTouch: true
    })
    try {
        await mobileContext.addCookies([
            { name: '_U', value: 'mobile-u', domain: '.bing.com', path: '/', expires: Date.now() / 1000 + 3600 },
            {
                name: 'SRCHHPGUSR',
                value: 'CW=360&DPR=2',
                domain: '.bing.com',
                path: '/',
                expires: Date.now() / 1000 + 3600
            }
        ])

        const taskContext = await createRewardsTaskContext(mobileContext)
        assert.ok(taskContext)

        await taskContext.addCookies([
            {
                name: 'MUIDB',
                value: 'desktop-muidb',
                domain: '.bing.com',
                path: '/',
                expires: Date.now() / 1000 + 3600
            },
            {
                name: 'SRCHHPGUSR',
                value: 'CW=1280&DPR=1',
                domain: '.bing.com',
                path: '/',
                expires: Date.now() / 1000 + 3600
            },
            {
                name: 'MSPAuth',
                value: 'refreshed-live',
                domain: '.live.com',
                path: '/',
                expires: Date.now() / 1000 + 3600
            },
            {
                name: 'RewardsHost',
                value: 'rewards-val',
                domain: 'rewards.bing.com',
                path: '/',
                expires: Date.now() / 1000 + 3600
            }
        ])

        await synchronizeRewardsCookies(mobileContext)

        const mobileCookies = await mobileContext.cookies()
        assert.equal(
            mobileCookies.some(cookie => cookie.name === 'MUIDB'),
            false
        )
        assert.equal(mobileCookies.find(cookie => cookie.name === 'SRCHHPGUSR')?.value, 'CW=360&DPR=2')
        assert.equal(mobileCookies.find(cookie => cookie.name === 'MSPAuth')?.value, 'refreshed-live')
        assert.equal(mobileCookies.find(cookie => cookie.name === 'RewardsHost')?.value, 'rewards-val')
    } finally {
        await closeRewardsTaskContext(mobileContext)
        await mobileContext.close()
    }
})

async function setupMobileBingFixture(t, signedIn) {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true })
    t.after(() => context.close())
    const page = await context.newPage()
    const drawerHtml = signedIn
        ? '<span id="hb_n">Alex</span><img id="hb_p" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />'
        : '<a id="hb_s" href="https://www.bing.com/fd/auth/signin">Sign in</a>'
    await page.route('https://www.bing.com/*', async route => {
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<!doctype html><html><body>
                <button id="mHamburger" type="button">Menu</button>
                <div id="hb_menu"></div>
                <script>
                    document.getElementById('mHamburger').addEventListener('click', () => {
                        const menu = document.getElementById('hb_menu');
                        menu.innerHTML = menu.innerHTML ? '' : ${JSON.stringify(drawerHtml)};
                    });
                </script>
            </body></html>`
        })
    })
    await page.goto('https://www.bing.com/', { waitUntil: 'domcontentloaded' })
    return page
}

test('getBingSignInEvidence detects mobile hamburger signed-in and signed-out states', async t => {
    const signedInPage = await setupMobileBingFixture(t, true)
    const signedInEvidence = await getBingSignInEvidence(signedInPage, 3000)
    assert.equal(signedInEvidence, 'mobile-hamburger-avatar')
    assert.equal(isSignedOutBingEvidence(signedInEvidence), false)
    assert.equal(await signedInPage.locator('#hb_n, #hb_p').count(), 0)

    const signedOutPage = await setupMobileBingFixture(t, false)
    const signedOutEvidence = await getBingSignInEvidence(signedOutPage, 3000)
    assert.equal(signedOutEvidence, 'mobile-hamburger-signed-out')
    assert.equal(isSignedOutBingEvidence(signedOutEvidence), true)
    assert.equal(await signedOutPage.locator('#hb_s').count(), 0)
})
