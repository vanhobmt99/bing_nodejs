/* global document */
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createRequire } from 'node:module'
import { chromium } from 'patchright'

const require = createRequire(import.meta.url)
const { BrowserReadToEarn } = require('../dist/rewards/browser/actions/BrowserReadToEarn')
let browser
before(async () => {
    browser = await chromium.launch({ headless: true })
})
after(async () => {
    await browser?.close()
})

async function fixture(t, cards) {
    const page = await browser.newPage()
    t.after(() => page.close())
    await page.route('**/*', route => route.abort())
    await page.setContent('<body></body>')
    await page.evaluate(definitions => {
        for (const card of definitions) {
            const element = document.createElement(card.legacy ? 'cs-responsive-card' : 'csm-card')
            element.id = card.id
            element.style.display = 'block'
            if (card.legacy) element.setAttribute('role', 'article')
            const root = element.attachShadow({ mode: 'open' })
            const link = document.createElement('a')
            link.className = 'heading'
            if (card.legacy) link.id = 'heading'
            link.href = card.href
            link.textContent = card.title
            root.append(link)
            document.body.append(element)
        }
    }, cards)
    const action = new BrowserReadToEarn({ signal: new AbortController().signal })
    return { page, action }
}

test('MSN mobile cards expose article links without the legacy role or heading id', async t => {
    const { page, action } = await fixture(t, [
        { id: 'video', title: 'Video', href: 'https://www.msn.com/en-us/video/vi-video' },
        { id: 'gallery', title: 'Gallery', href: 'https://www.msn.com/en-us/photos/ss-gallery' },
        { id: 'article', title: 'Mobile article', href: 'https://www.msn.com/en-us/news/story/ar-mobile' }
    ])
    assert.equal(await page.locator('cs-responsive-card[role="article"]').count(), 0)
    assert.equal(await action.hasFeedArticle(page), true)
    const article = await action.findFeedArticle(page, new Set())
    assert.equal(article.title, 'Mobile article')
    assert.equal(await article.heading.getAttribute('href'), 'https://www.msn.com/en-us/news/story/ar-mobile')
})

test('legacy MSN desktop article cards remain readable', async t => {
    const { page, action } = await fixture(t, [
        { id: 'legacy', legacy: true, title: 'Desktop article', href: 'https://www.msn.com/en-us/news/story/ar-legacy' }
    ])
    assert.equal(await action.hasFeedArticle(page), true)
    assert.equal((await action.findFeedArticle(page, new Set())).title, 'Desktop article')
})

test('duplicate cards and tracking URLs do not cause the same article to be read twice', async t => {
    const { page, action } = await fixture(t, [
        { id: 'slot-1', title: 'First', href: 'https://www.msn.com/en-us/news/story/ar-first?source=one' },
        { id: 'slot-2', title: 'Duplicate', href: 'https://www.msn.com/en-us/news/story/ar-first?source=two' },
        { id: 'slot-3', title: 'Next', href: 'https://www.msn.com/en-us/news/story/ar-next' }
    ])
    const first = await action.findFeedArticle(page, new Set())
    const next = await action.findFeedArticle(page, new Set([first.key]))
    assert.equal(first.title, 'First')
    assert.equal(next.title, 'Next')
})
