import type { Locator, Page } from 'patchright'
import type { ParentQuest } from '../../shared/parsers/RewardsPageParser'

export const PUNCHCARD_LINKS = '#quests a[href*="/earn/quest/"]'

export interface RenderedPunchCard extends ParentQuest {
    destination: string
}

export interface RenderedPunchCardStep {
    offerId: string | null
    title: string
    description: string
    destination: string
    controlName: string
    role: 'link' | 'button'
    disabled: boolean
    complete: boolean
    headingIndex?: number
}

export interface StepControlCandidateMeta {
    disabled: boolean
    offerId: string | null
    href: string
    headingIndex: number | null
    headingTitle: string
}

export type StepControlSelection = { status: 'matched'; index: number } | { status: 'not-found' | 'ambiguous' }

/** Pick the unique enabled control for a punchcard step when multiple visible controls share its label. */
export function selectUniquePunchCardStepCandidate(
    candidates: ReadonlyArray<StepControlCandidateMeta>,
    step: Pick<RenderedPunchCardStep, 'offerId' | 'destination' | 'headingIndex' | 'title'>
): StepControlSelection {
    let pool = candidates.map((meta, index) => ({ meta, index })).filter(item => !item.meta.disabled)
    if (!pool.length) return { status: 'not-found' }
    if (pool.length === 1) return { status: 'matched', index: pool[0]!.index }

    const narrow = (predicate: (meta: StepControlCandidateMeta) => boolean): boolean => {
        const filtered = pool.filter(item => predicate(item.meta))
        if (filtered.length > 0 && filtered.length < pool.length) pool = filtered
        return pool.length === 1
    }

    if (step.offerId && narrow(meta => meta.offerId === step.offerId)) {
        return { status: 'matched', index: pool[0]!.index }
    }
    if (
        step.headingIndex !== undefined &&
        narrow(meta => meta.headingIndex === step.headingIndex && (!step.title || meta.headingTitle === step.title))
    ) {
        return { status: 'matched', index: pool[0]!.index }
    }
    if (step.destination && narrow(meta => meta.href === step.destination)) {
        return { status: 'matched', index: pool[0]!.index }
    }
    if (step.title && narrow(meta => meta.headingTitle === step.title)) {
        return { status: 'matched', index: pool[0]!.index }
    }
    return { status: 'ambiguous' }
}

export async function readPunchCardParents(page: Page): Promise<RenderedPunchCard[]> {
    return page.locator(PUNCHCARD_LINKS).evaluateAll(elements => {
        const text = (value: string | null | undefined) =>
            (value ?? '')
                .replace(/[\u200b-\u200d\ufeff]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
        const cards = new Map<string, RenderedPunchCard>()
        for (const element of elements) {
            const style = getComputedStyle(element)
            if (
                !element.getClientRects().length ||
                style.visibility === 'hidden' ||
                style.display === 'none' ||
                element.closest('[aria-disabled="true"], [data-disabled], [inert]')
            )
                continue
            const heading = element.querySelector('h3')
            if (!heading) continue
            let destination: URL
            let offerId: string
            try {
                destination = new URL(element.getAttribute('href') ?? '', location.href)
                const match = destination.pathname.match(/^\/earn\/quest\/([^/]+)\/?$/)
                if (destination.origin !== location.origin || !match) continue
                offerId = decodeURIComponent(match[1]!)
            } catch {
                continue
            }
            const progress = [...element.querySelectorAll('.text-metadata, p, span')]
                .map(node => text(node.textContent).match(/^(\d+)\s*\/\s*(\d+)\s+tasks?$/i))
                .find(match => match !== null)
            const points = [...element.querySelectorAll('.rounded-cornerCircular p')]
                .map(node => text(node.textContent))
                .find(value => /^\+?\s*\d[\d,]*$/.test(value))
            cards.set(offerId, {
                offerId,
                title: text(heading.textContent),
                destination: destination.href,
                pointProgressMax: points ? Number(points.replace(/[^0-9]/g, '')) : 0,
                pointProgressMaxKnown: points !== undefined,
                completedSteps: progress ? Number(progress[1]) : null,
                totalSteps: progress ? Number(progress[2]) : null,
                complete: Boolean(
                    element.querySelector('.bg-statusSuccessRewardsBg') ||
                    (progress && Number(progress[2]) > 0 && Number(progress[1]) >= Number(progress[2]))
                )
            })
        }
        return [...cards.values()]
    })
}

export async function readPunchCardPage(page: Page) {
    return page.locator('main').evaluate(main => {
        const text = (value: string | null | undefined) =>
            (value ?? '')
                .replace(/[\u200b-\u200d\ufeff]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
        const visible = (element: Element) => {
            const style = getComputedStyle(element)
            return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        }
        const progress = [...main.querySelectorAll('p, span')]
            .filter(visible)
            .map(node => text(node.textContent).match(/^(\d+)\s*\/\s*(\d+)\s+tasks?$/i))
            .find(match => match !== null)
        const steps: RenderedPunchCardStep[] = []
        for (const [headingIndex, heading] of [...main.querySelectorAll('h3')].entries()) {
            if (!visible(heading)) continue
            let container = heading.parentElement

            while (container && container !== main && container.querySelectorAll('h3').length === 1) {
                const controls = [
                    ...container.querySelectorAll('a[href], [role="link"], button, [role="button"]')
                ].filter(visible)
                if (controls.length) {
                    if (controls.length !== 1) break
                    const control = controls[0]!
                    const row =
                        container.parentElement?.querySelectorAll('h3').length === 1
                            ? container.parentElement
                            : container
                    const disabled = Boolean(
                        control.closest('[disabled], [aria-disabled="true"], [data-disabled], [inert]')
                    )
                    const complete = Boolean(
                        row?.matches('[data-completed="true"], [data-complete="true"]') ||
                        row?.querySelector(
                            '[data-completed="true"], [data-complete="true"], .bg-statusSuccessRewardsBg, [aria-label="Completed"]'
                        )
                    )
                    steps.push({
                        offerId:
                            control.getAttribute('data-offerid') ??
                            control.getAttribute('data-offer-id') ??
                            container.getAttribute('data-offerid') ??
                            container.getAttribute('data-offer-id'),
                        title: text(heading.textContent),
                        description: text(heading.nextElementSibling?.textContent),
                        destination: control.getAttribute('href') ?? '',
                        controlName: text(control.getAttribute('aria-label') ?? control.textContent),
                        role: control.matches('button, [role="button"]') ? 'button' : 'link',
                        disabled,
                        complete,
                        headingIndex
                    })
                    break
                }
                container = container.parentElement
            }
        }
        return {
            steps,
            completed: progress ? Number(progress[1]) : null,
            total: progress ? Number(progress[2]) : null
        }
    })
}

/** Read DOM metadata for visible step controls inside main so duplicate control labels can be disambiguated. */
export async function readPunchCardStepCandidateMeta(
    candidates: ReadonlyArray<Locator>
): Promise<StepControlCandidateMeta[]> {
    return Promise.all(
        candidates.map(candidate =>
            candidate.evaluate(el => {
                const text = (value: string | null | undefined) =>
                    (value ?? '')
                        .replace(/[\u200b-\u200d\ufeff]/g, '')
                        .replace(/\s+/g, ' ')
                        .trim()
                const main = el.closest('main')
                let container: Element | null = el
                while (container && container !== main && container.querySelectorAll('h3').length === 0) {
                    container = container.parentElement
                }
                const singleHeading =
                    container && container !== main && container.querySelectorAll('h3').length === 1
                        ? container.querySelector('h3')
                        : null
                const headingIndex =
                    main && singleHeading ? [...main.querySelectorAll('h3')].indexOf(singleHeading) : -1
                return {
                    disabled: Boolean(el.closest('[disabled], [aria-disabled="true"], [data-disabled], [inert]')),
                    offerId:
                        el.getAttribute('data-offerid') ??
                        el.getAttribute('data-offer-id') ??
                        container?.getAttribute('data-offerid') ??
                        container?.getAttribute('data-offer-id') ??
                        null,
                    href: el.getAttribute('href') ?? '',
                    headingIndex: headingIndex >= 0 ? headingIndex : null,
                    headingTitle: singleHeading ? text(singleHeading.textContent) : ''
                }
            })
        )
    )
}
