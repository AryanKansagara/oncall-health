import { readFileSync } from 'node:fs'
import { chooseFiles, expect, fixture, kpi, newTeam, num, openSample, rowOf, section, test } from './test.ts'

// All data in these tests is synthetic: the built-in sample teams and the files in e2e/fixtures.
// The browser has no network: anything that leaves the preview server is aborted (see test.ts).

test.describe('sample team', () => {
  test('shows load per person, fairness and noise', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Open the sample team' }).click()
    await expect(page).toHaveURL(/\/app\/p\/[\w-]+$/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Payments platform')

    // Load per person, in the people table.
    const people = page.getByRole('table').first()
    const priya = rowOf(people, 'Priya Raman')
    await expect(priya).toBeVisible()
    await expect(priya.getByText('severe', { exact: true })).toBeVisible()
    expect(num(await priya.locator('td').nth(1).textContent())).toBeGreaterThan(20)
    await expect(page.getByRole('img', { name: /^Priya Raman: \d+ pages by weekday and local hour$/ })).toBeVisible()
    await expect(page.locator('.banner.warn')).toContainText('Priya Raman carries')

    // Fairness.
    const gini = await kpi(page, 'Load fairness (Gini)').locator('b').textContent()
    expect(num(gini)).toBeGreaterThan(0.15)
    expect(num(gini)).toBeLessThan(1)

    // Noise: the flapping disk alert tops the ranked list.
    await section(page, 'Noisy alerts')
    await expect(kpi(page, 'Removable pages per month').locator('b')).not.toHaveText('0')
    const first = page.locator('.fix-card').first()
    await expect(first).toContainText('Disk usage')
    await expect(first.locator('.fix-rank')).toHaveText('1')
    await expect(first.locator('.fix-impact b')).toHaveText(/^−[\d.,]+$/)
    expect(num(await first.locator('.fix-impact b').textContent())).toBeGreaterThan(10)
  })

  test('every team section renders without errors', async ({ page }) => {
    await openSample(page)
    for (const [tab, heading] of [['Noisy alerts', 'Tune these alerts first'], ['Rotation', 'Proposed rotation'], ['Pay & time off', 'Policy'], ['History', 'Compare'], ['Data & people', 'People and working hours'], ['Overview', 'People']] as const) {
      await section(page, tab)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    }
    await page.getByRole('link', { name: 'Report' }).click()
    await expect(page).toHaveURL(/\/report/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('the sample CSV downloads and imports into a new team with the same page count', async ({ page }) => {
    await openSample(page)
    await section(page, 'Data & people')
    const pages = num(await page.locator('.panel-head', { hasText: 'Imported data' }).locator('.muted').textContent())
    expect(pages).toBeGreaterThan(100)
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download the sample as CSV' }).click()])
    const path = test.info().outputPath('payments-incidents.csv')
    await download.saveAs(path)

    // Samples are read-only, so importing starts a new team.
    await page.locator('input[type=file]').setInputFiles(path)
    await expect(page.getByText(`${pages.toLocaleString('en-US')} pages ready of ${pages.toLocaleString('en-US')} rows`)).toBeVisible()
    await page.getByRole('button', { name: /^Import [\d,]+ pages$/ }).click()
    await expect(page).toHaveURL(/\/app\/p\/[\w-]+\/data$/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('My team')
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText(`${pages.toLocaleString('en-US')} pages`)
  })
})

test.describe('importing', () => {
  test('a PagerDuty CSV, then a PagerDuty REST JSON export, land in one team with the right numbers', async ({ page }) => {
    await newTeam(page)

    await chooseFiles(page, 'pagerduty-incidents.csv')
    await expect(page.locator('select').filter({ hasText: 'PagerDuty incidents CSV' }).first()).toHaveValue('pagerduty-csv')
    await expect(page.getByText('8 pages ready of 8 rows. People found: 3. Range 2026-10-05 to 2026-10-12.')).toBeVisible()
    await page.getByRole('button', { name: 'Import 8 pages' }).click()
    await expect(page.getByText('Imported 8 pages', { exact: true })).toBeVisible()
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('8 pages')

    await chooseFiles(page, 'pagerduty-rest-incidents.json')
    await expect(page.locator('select').filter({ hasText: 'PagerDuty REST API /incidents' }).first()).toHaveValue('pagerduty-json')
    await expect(page.getByText('2 pages ready of 2 rows. People found: 2. Range 2026-10-06 to 2026-10-07.')).toBeVisible()
    await page.getByRole('button', { name: 'Import 2 pages' }).click()
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('10 pages')
    const imports = page.getByRole('table').last()
    await expect(rowOf(imports, 'pagerduty-incidents.csv')).toContainText('PagerDuty incidents CSV')
    await expect(rowOf(imports, 'pagerduty-rest-incidents.json')).toContainText('PagerDuty REST API /incidents')

    // The JSON export had no assignee for the first incident; the person who resolved it is used.
    const peopleCfg = page.getByRole('table').nth(0)
    for (const n of ['Ann Lee', 'Bob Ng', 'Cy Diaz', 'Earline Greenholt', 'Dana Rivers']) await expect(rowOf(peopleCfg, n)).toBeVisible()

    await section(page, 'Overview')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Team 1')
    const people = page.getByRole('table').first()
    // [pages, sleep pages, nights in a row, days off hit]
    const expected: Record<string, [string, string, string, string]> = {
      'Ann Lee': ['3', '3', '3', '0'], 'Bob Ng': ['3', '2', '2', '0'], 'Cy Diaz': ['2', '0', '0', '1'],
      'Earline Greenholt': ['1', '0', '0', '0'], 'Dana Rivers': ['1', '1', '1', '0'],
    }
    for (const [name, [pages, sleep, nights, off]] of Object.entries(expected)) {
      const cells = rowOf(people, name).locator('td')
      expect([name, await cells.nth(1).textContent(), await cells.nth(3).textContent(), await cells.nth(4).textContent(), await cells.nth(5).textContent()]).toEqual([name, pages, sleep, nights, off])
    }
  })

  test('re-importing the same file updates by ID instead of duplicating', async ({ page }) => {
    await newTeam(page)
    for (let i = 0; i < 2; i++) {
      await chooseFiles(page, 'pagerduty-incidents.csv')
      await page.getByRole('button', { name: 'Import 8 pages' }).click()
      await expect(page.getByText('Imported 8 pages', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Dismiss' }).click()
    }
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('8 pages')
  })

  test('fairness and load numbers for a known three-person team', async ({ page }) => {
    await newTeam(page)
    await chooseFiles(page, 'pagerduty-incidents.csv')
    await page.getByRole('button', { name: 'Import 8 pages' }).click()
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('8 pages')
    await section(page, 'Overview')
    // Pages 3, 3 and 2 across three people: Gini 0.083.
    await expect(kpi(page, 'Load fairness (Gini)').locator('b')).toHaveText('0.08')
    await expect(kpi(page, 'Load fairness (Gini)')).toContainText('even; 0 is perfectly even')
    const people = page.getByRole('table').first()
    await expect(rowOf(people, 'Ann Lee').locator('td').nth(6)).toContainText('38%')
    await expect(rowOf(people, 'Cy Diaz').locator('td').nth(6)).toContainText('25%')
  })
})

test.describe('what-if and pay', () => {
  test('toggling a noise fix changes the numbers, and clearing restores them', async ({ page }) => {
    await openSample(page)
    await section(page, 'Overview')
    const pagesKpi = kpi(page, 'Pages per month')
    const sleepKpi = kpi(page, 'Sleep interruptions per month')
    const before = { pages: num(await pagesKpi.locator('b').textContent()), sleep: num(await sleepKpi.locator('b').textContent()) }
    await expect(page.locator('.banner.good')).toHaveCount(0)

    await section(page, 'Noisy alerts')
    const toggle = page.getByRole('checkbox', { name: /^Apply .* to Disk usage.* as a what-if$/ }).first()
    // The switch is driven by an async store write, so wait for the state rather than trusting the click.
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect(page.locator('.banner.good')).toContainText('1 fix applied as a what-if')
    await expect(page.locator('.fix-card.on')).toHaveCount(1)

    await section(page, 'Overview')
    await expect(page.locator('.banner.good')).toContainText('fewer pages a month')
    const after = { pages: num(await pagesKpi.locator('b').textContent()), sleep: num(await sleepKpi.locator('b').textContent()) }
    expect(after.pages).toBeLessThan(before.pages)
    expect(after.sleep).toBeLessThan(before.sleep)
    // The card keeps the old value next to the new one.
    expect(num(await pagesKpi.locator('.was').textContent())).toBe(before.pages)
    expect(num(await sleepKpi.locator('.was').textContent())).toBe(before.sleep)

    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(page.locator('.banner.good')).toHaveCount(0)
    expect(num(await pagesKpi.locator('b').textContent())).toBe(before.pages)
    expect(num(await sleepKpi.locator('b').textContent())).toBe(before.sleep)
  })

  test('detection thresholds re-rank the list', async ({ page }) => {
    await openSample(page)
    await section(page, 'Noisy alerts')
    const removable = () => kpi(page, 'Removable pages per month').locator('b').textContent().then(num)
    const before = await removable()
    // Treating only the very quick auto-resolves as blips drops the pages the delay fix would remove.
    await page.getByLabel('Auto-resolved under (min)').fill('1')
    await expect.poll(removable).toBeLessThan(before)
  })

  test('changing the pay policy changes what each person is owed', async ({ page }) => {
    await newTeam(page)
    await chooseFiles(page, 'pagerduty-incidents.csv')
    await page.getByRole('button', { name: 'Import 8 pages' }).click()
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('8 pages')
    await section(page, 'Pay & time off')

    const table = page.getByRole('table')
    const total = kpi(page, 'Total payout').locator('b')
    // Default policy: $300 a week, $25 per evening or weekend page, $75 per sleep-hours page.
    // Ann: 1 week, 3 sleep pages. Bob: 1 week, 2 sleep pages. Cy: 2 weeks, 1 weekend page.
    await expect(rowOf(table, 'Ann Lee')).toContainText('$525')
    await expect(rowOf(table, 'Bob Ng')).toContainText('$450')
    await expect(rowOf(table, 'Cy Diaz')).toContainText('$625')
    await expect(total).toHaveText('$1,600')
    // Time off in lieu: 5 sleep pages x 2 h, plus 1 day off interrupted x 4 h.
    await expect(kpi(page, 'Time off in lieu').locator('b')).toHaveText('14 h')

    await page.getByLabel('Per sleep-hours page').fill('100')
    await expect(rowOf(table, 'Ann Lee')).toContainText('$600')
    await expect(rowOf(table, 'Bob Ng')).toContainText('$500')
    await expect(rowOf(table, 'Cy Diaz')).toContainText('$625')
    await expect(total).toHaveText('$1,725')

    await page.getByLabel('Currency').selectOption('EUR')
    await expect(total).toHaveText('€1,725')

    // An override for on-call weeks beats the weeks inferred from pages.
    await page.getByLabel('On-call weeks for Cy Diaz').fill('4')
    await expect(rowOf(table, 'Cy Diaz')).toContainText('€1,225')
    await expect(total).toHaveText('€2,325')
  })
})

test.describe("each person's time zone decides sleep-hour counts", () => {
  // Six pages, all at 11:30 UTC: three before the US clocks go back on 2026-11-01, three after.
  // In New York that is 07:30 (EDT, awake) before and 06:30 (EST, asleep) after.
  const sleepOf = async (page: import('@playwright/test').Page, name: string) => {
    await section(page, 'Overview')
    return rowOf(page.getByRole('table').first(), name).locator('td').nth(3).textContent()
  }
  const setZone = async (page: import('@playwright/test').Page, name: string, tz: string) => {
    await section(page, 'Data & people')
    const input = page.getByLabel(`Timezone for ${name}`)
    await input.fill(tz)
    await input.blur()
    await expect(input).toHaveValue(tz)
  }

  test('New York: only the pages after the fall-back count, and they move on the heatmap', async ({ page }) => {
    await newTeam(page)
    await chooseFiles(page, 'dst-new-york.csv')
    await page.getByRole('button', { name: 'Import 6 pages' }).click()
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('6 pages')

    // The team default is UTC here, so 11:30 is mid-morning for everyone.
    expect(await sleepOf(page, 'Nia NY')).toBe('0')

    await setZone(page, 'Nia NY', 'America/New_York')
    expect(await sleepOf(page, 'Nia NY')).toBe('3')
    const heat = page.getByRole('img', { name: 'Nia NY: 6 pages by weekday and local hour' })
    // Mon 26, Tue 27, Wed 28 Oct (EDT) land in the 07:00 hour; Tue 3, Wed 4, Thu 5 Nov (EST) in the 06:00 hour.
    for (const d of ['Mon', 'Tue', 'Wed']) await expect(heat.locator(`[title^="${d} 07:00 · 1 page"]`)).toHaveCount(1)
    for (const d of ['Tue', 'Wed', 'Thu']) await expect(heat.locator(`[title^="${d} 06:00 · 1 page"]`)).toHaveCount(1)
  })

  for (const [tz, sleep, why] of [
    ['Europe/London', '0', '11:30 GMT all period (UK clocks went back on 25 Oct)'],
    ['Asia/Kolkata', '0', '17:00 IST all period, no daylight saving'],
    ['Pacific/Auckland', '6', '00:30 NZDT all period (daylight saving began 27 Sep)'],
    ['Australia/Sydney', '6', '22:30 AEDT all period (daylight saving began 4 Oct)'],
  ] as const) {
    test(`${tz}: ${sleep} sleep-hour pages (${why})`, async ({ page }) => {
      await newTeam(page)
      await chooseFiles(page, 'dst-new-york.csv')
      await page.getByRole('button', { name: 'Import 6 pages' }).click()
      await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('6 pages')
      await setZone(page, 'Nia NY', tz)
      expect(await sleepOf(page, 'Nia NY')).toBe(sleep)
    })
  }

  test('an invalid zone name is refused and the old zone stays', async ({ page }) => {
    await newTeam(page)
    await chooseFiles(page, 'dst-new-york.csv')
    await page.getByRole('button', { name: 'Import 6 pages' }).click()
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('6 pages')
    await setZone(page, 'Nia NY', 'America/New_York')
    const input = page.getByLabel('Timezone for Nia NY')
    await input.fill('Mars/Olympus')
    await input.blur()
    await expect(page.getByText('"Mars/Olympus" is not a timezone')).toBeVisible()
    await expect(input).toHaveValue('America/New_York')
    expect(await sleepOf(page, 'Nia NY')).toBe('3')
  })
})

test.describe('bad files', () => {
  /** Nothing was imported: the team is still empty, no person has a risk score, and the Teams list shows none. */
  async function expectNothingScored(page: import('@playwright/test').Page) {
    await expect(page.getByText('Start here.')).toBeVisible()
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toHaveCount(0)
    await expect(page.locator('.badge.low, .badge.moderate, .badge.high, .badge.severe')).toHaveCount(0)
    await expect(page.locator('.score-ring, svg[aria-label*="risk" i]')).toHaveCount(0)
    await section(page, 'Overview')
    await expect(page.getByText('Start here.')).toBeVisible()
    await page.goto('/app')
    const card = page.locator('.project-card')
    await expect(card).toHaveCount(1)
    await expect(card.locator('div', { has: page.getByText('Worst risk', { exact: true }) }).locator('dd').last()).toHaveText('—')
    await expect(card.getByText('None yet')).toBeVisible()
  }

  for (const [file, message] of [
    ['empty.csv', 'empty.csv has no data rows.'],
    ['header-only.csv', 'header-only.csv has no data rows.'],
    ['wrong-shape.json', 'wrong-shape.json has no incidents in it.'],
    ['truncated.json', /^truncated\.json: .*JSON/],
  ] as const) {
    test(`${file} is refused with a message`, async ({ page }) => {
      await newTeam(page)
      await chooseFiles(page, file)
      await expect(page.getByRole('status').locator('.toast.error')).toContainText(message)
      await expect(page.getByRole('button', { name: /^Import \d+/ })).toHaveCount(0)
      await expectNothingScored(page)
    })
  }

  for (const file of ['wrong-file.txt', 'wrong-columns.csv']) {
    test(`${file} explains which columns are missing and cannot be imported`, async ({ page }) => {
      await newTeam(page)
      await chooseFiles(page, file)
      const issues = page.getByRole('log', { name: 'Validation issues' })
      await expect(issues).toContainText('line 1')
      await expect(issues).toContainText('Required column "Created / triggered at" is not mapped')
      await expect(issues).toContainText('Required column "Title" is not mapped')
      await expect(page.getByText('0 pages ready of 1 rows, 1 skipped.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Import 0 pages' })).toBeDisabled()
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expectNothingScored(page)
    })
  }

  test('a wrong file does not disturb a team that already has data', async ({ page }) => {
    await newTeam(page)
    await chooseFiles(page, 'pagerduty-incidents.csv')
    await page.getByRole('button', { name: 'Import 8 pages' }).click()
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('8 pages')
    await chooseFiles(page, 'truncated.json')
    await expect(page.locator('.toast.error')).toContainText('truncated.json')
    await chooseFiles(page, 'wrong-columns.csv')
    await expect(page.getByRole('button', { name: 'Import 0 pages' })).toBeDisabled()
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('8 pages')
  })

  // KNOWN APP BUG, filed rather than fixed here (issue #2): a CSV cut off mid-row is read as if the row were complete.
  // test.fail() keeps CI green while the bug exists and turns red as soon as it is fixed, so remove it then.
  test('a CSV cut off mid-row is flagged', async ({ page }) => {
    test.fail(true, 'App bug #2: a truncated final row imports without any warning.')
    expect(readFileSync(fixture('truncated.csv'), 'utf8').endsWith('\n')).toBe(false)
    await newTeam(page)
    await chooseFiles(page, 'truncated.csv')
    await expect(page.getByText(/pages? ready of \d+ rows/)).toBeVisible()
    // Either a warning or a skipped row is a fair way to say the last row is incomplete.
    await expect(page.getByRole('log', { name: 'Validation issues' })).toBeVisible({ timeout: 2000 })
  })
})

test.describe('persistence', () => {
  test('a sample team, its what-if and its pay policy survive a reload', async ({ page }) => {
    await openSample(page)
    await section(page, 'Noisy alerts')
    const toggle = page.getByRole('checkbox', { name: /^Apply .* to Disk usage.* as a what-if$/ }).first()
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect(page.locator('.banner.good')).toBeVisible()
    await section(page, 'Pay & time off')
    await page.getByLabel('Per sleep-hours page').fill('120')
    const total = kpi(page, 'Total payout').locator('b')
    const shown = await total.textContent()
    await expect(page.getByLabel('Per sleep-hours page')).toHaveValue('120')

    await page.reload()
    await expect(page).toHaveURL(/\/pay$/)
    await expect(page.getByLabel('Per sleep-hours page')).toHaveValue('120')
    await expect(total).toHaveText(shown!)
    await expect(page.locator('.banner.good')).toContainText('1 fix applied as a what-if')

    // And it is listed on the Teams page, once.
    await page.goto('/app')
    await expect(page.locator('.project-card')).toHaveCount(1)
    await expect(page.locator('.project-card')).toContainText('Payments platform')
  })

  test('imported data, edited people and a saved snapshot survive a reload', async ({ page }) => {
    await newTeam(page)
    await chooseFiles(page, 'pagerduty-incidents.csv')
    await page.getByRole('button', { name: 'Import 8 pages' }).click()
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('8 pages')
    const zone = page.getByLabel('Timezone for Bob Ng')
    await zone.fill('Asia/Kolkata')
    await zone.blur()
    await page.getByLabel('New person name').fill('Eve Quiet')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByLabel('Timezone for Eve Quiet')).toBeVisible()

    await section(page, 'Overview')
    await page.getByRole('button', { name: 'Save snapshot' }).click()
    await expect(page.getByText(/^Saved a snapshot of /)).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Team 1')
    const people = page.getByRole('table').first()
    await expect(rowOf(people, 'Ann Lee').locator('td').nth(1)).toHaveText('3')
    await expect(rowOf(people, 'Eve Quiet')).toBeVisible()
    await section(page, 'Data & people')
    await expect(page.getByLabel('Timezone for Bob Ng')).toHaveValue('Asia/Kolkata')
    await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('8 pages')
    await section(page, 'History')
    await expect(page.getByRole('heading', { name: 'Snapshots' })).toBeVisible()
    await expect(page.getByRole('table').last().locator('tbody tr')).toHaveCount(1)
  })

  test('deleting a team removes it for good after a reload', async ({ page }) => {
    await openSample(page)
    await page.goto('/app')
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete team' }).click()
    await expect(page.getByText('Deleted Payments platform')).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Try the sample' })).toBeVisible()
    await expect(page.locator('.project-card')).toHaveCount(0)
  })
})

test.describe('the site itself', () => {
  test('landing, docs, settings and unknown routes load; deep links work on a fresh load', async ({ page, guard }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('really')
    await page.goto('/docs')
    await expect(page).toHaveTitle(/Docs/)
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    await page.goto('/no/such/page')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nobody is on call for this page')
    await page.goto('/app/p/00000000-0000-0000-0000-000000000000')
    await expect(page.getByText('Team not found')).toBeVisible()
    // Only fonts were ever attempted off-box, and they were blocked.
    expect([...guard.blocked].every(h => /^fonts\.g/.test(h))).toBe(true)
  })

  test('signed out: no account is created and nothing is sent to a backend', async ({ page }) => {
    const sent: string[] = []
    page.on('request', r => { if (!r.url().startsWith('http://127.0.0.1')) sent.push(new URL(r.url()).hostname) })
    await openSample(page)
    await expect(page.getByRole('button', { name: /sign in/i }).first()).toBeVisible()
    expect(sent.filter(h => /supabase/.test(h))).toEqual([])
  })
})
