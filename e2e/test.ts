import { fileURLToPath } from 'node:url'
import { expect, test as base, type Locator, type Page } from '@playwright/test'

export { expect }

/** Hosts the app may reach for on page load. They are aborted in every test, never contacted. */
const ALLOWED_BLOCKED = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

export const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

interface Guard {
  /** Uncaught exceptions and console errors (other than blocked network loads). */
  errors: string[]
  /** Hosts of requests that were aborted because they left the preview server. */
  blocked: Set<string>
}

/**
 * Every test starts signed out in a fresh browser context (empty IndexedDB),
 * with all non-local requests aborted, and fails on uncaught page errors.
 */
export const test = base.extend<{ guard: Guard }>({
  guard: [async ({ page, baseURL }, use) => {
    const guard: Guard = { errors: [], blocked: new Set() }
    const origin = new URL(baseURL!).origin
    await page.route(url => /^https?:$/.test(url.protocol) && url.origin !== origin, route => {
      guard.blocked.add(new URL(route.request().url()).hostname)
      return route.abort()
    })
    page.on('pageerror', e => guard.errors.push(`pageerror: ${e.message}`))
    page.on('console', m => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) guard.errors.push(`console.error: ${m.text()}`)
    })
    await use(guard)
    expect(guard.errors, 'uncaught page errors').toEqual([])
    const unexpected = [...guard.blocked].filter(h => !ALLOWED_BLOCKED.has(h))
    expect(unexpected, 'requests to hosts the app should not contact').toEqual([])
  }, { auto: true }],
})

// ---------- Page helpers ----------

export async function openSample(page: Page, id = 'payments') {
  await page.goto(`/app?sample=${id}`)
  await expect(page).toHaveURL(/\/app\/p\/[\w-]+$/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Payments')
}

export async function newTeam(page: Page) {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).first().click()
  await expect(page).toHaveURL(/\/app\/p\/[\w-]+\/data$/)
}

/** Choose files through the real file input, as a user dropping an export would. */
export async function chooseFiles(page: Page, ...files: string[]) {
  await page.locator('input[type=file]').setInputFiles(files.map(fixture))
}

export function section(page: Page, tab: 'Overview' | 'Noisy alerts' | 'Rotation' | 'Pay & time off' | 'History' | 'Data & people') {
  return page.getByRole('navigation', { name: 'Team sections' }).getByRole('link', { name: tab, exact: true }).click()
}

/** The value of a KPI card on Overview, Noisy alerts or Pay. */
export const kpi = (page: Page, label: string): Locator => page.locator('.kpi', { has: page.getByText(label, { exact: true }) })

/** The cells of one row of a table, keyed by the row header. */
export const rowOf = (scope: Locator, name: string) => scope.locator('tbody tr').filter({ has: scope.page().getByRole('rowheader', { name, exact: true }) })

export const num = (s: string | null) => Number((s ?? '').replace(/[^0-9.\-]/g, ''))
