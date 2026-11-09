import type { Bucket, CompPolicy, Config, Incident, PersonCfg } from './types.ts'

const HOUR = 3600_000
const DAY = 24 * HOUR
const MONTH_DAYS = 30.44

// ---------- Local time ----------

const fmts = new Map<string, Intl.DateTimeFormat>()
const offsets = new Map<string, number>()

export function validTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

/** Offset of tz from UTC at time t, in ms. Cached per tz per UTC hour (offsets only change on hour boundaries). */
export function tzOffset(t: number, tz: string): number {
  const h = Math.floor(t / HOUR)
  const key = tz + '|' + h
  let o = offsets.get(key)
  if (o !== undefined) return o
  let f = fmts.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: validTz(tz) ? tz : 'UTC', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    fmts.set(tz, f)
  }
  const p: Record<string, number> = {}
  for (const x of f.formatToParts(h * HOUR)) if (x.type !== 'literal') p[x.type] = Number(x.value)
  o = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - h * HOUR
  if (offsets.size > 200_000) offsets.clear()
  offsets.set(key, o)
  return o
}

export interface Local { ms: number; dow: number; hour: number; date: string }
/** Local wall-clock time as a fake-UTC timestamp plus convenient parts. dow: 0 = Sunday. */
export function local(t: number, tz: string): Local {
  const ms = t + tzOffset(t, tz)
  const d = new Date(ms)
  return { ms, dow: d.getUTCDay(), hour: d.getUTCHours() + d.getUTCMinutes() / 60, date: d.toISOString().slice(0, 10) }
}

export const inSleep = (hour: number, start: number, end: number) => start > end ? hour >= start || hour < end : hour >= start && hour < end

export const DEFAULT_PERSON: PersonCfg = { tz: 'UTC', workStart: 9, workEnd: 17.5, workDays: [1, 2, 3, 4, 5] }
export const personCfg = (cfg: Config, name: string): PersonCfg => cfg.people[name] ?? { ...DEFAULT_PERSON, tz: cfg.defaultTz }

/** Sleep beats weekend beats business hours; anything else is an evening (or early morning) interruption. */
export function bucketOf(t: number, p: PersonCfg, cfg: Pick<Config, 'sleepStart' | 'sleepEnd'>): Bucket {
  const l = local(t, p.tz)
  if (inSleep(l.hour, cfg.sleepStart, cfg.sleepEnd)) return 'sleep'
  if (!p.workDays.includes(l.dow)) return 'weekend'
  if (l.hour >= p.workStart && l.hour < p.workEnd) return 'business'
  return 'evening'
}

/** The night a sleep page belongs to: 03:00 Tuesday is Monday night. */
export const nightOf = (t: number, tz: string, sleepEnd: number) => new Date(local(t, tz).ms - sleepEnd * HOUR).toISOString().slice(0, 10)

// ---------- Statistics ----------

/** Nearest-rank percentile of an unsorted list; NaN when empty. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))]
}

/** Gini coefficient: 0 = perfectly even, (n-1)/n = one person carries everything. */
export function gini(xs: number[]): number {
  const n = xs.length
  const sum = xs.reduce((a, b) => a + b, 0)
  if (n < 2 || sum <= 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  let w = 0
  s.forEach((x, i) => { w += (i + 1) * x })
  return (2 * w) / (n * sum) - (n + 1) / n
}

/** Longest run of consecutive calendar dates in a set of YYYY-MM-DD strings. */
export function longestRun(dates: Iterable<string>): number {
  const ds = [...new Set(dates)].map(d => Date.parse(d + 'T00:00:00Z')).sort((a, b) => a - b)
  let best = 0, run = 0
  for (let i = 0; i < ds.length; i++) {
    run = i > 0 && ds[i] - ds[i - 1] === DAY ? run + 1 : 1
    best = Math.max(best, run)
  }
  return best
}

export function histogram(xs: number[], edges: number[]): number[] {
  const out = new Array(edges.length + 1).fill(0)
  for (const x of xs) {
    let i = 0
    while (i < edges.length && x >= edges[i]) i++
    out[i]++
  }
  return out
}

export const ACK_EDGES = [1, 5, 15, 30, 60]
export const ACK_LABELS = ['< 1m', '1–5m', '5–15m', '15–30m', '30–60m', '1h+']
export const RES_EDGES = [5, 30, 120, 480]
export const RES_LABELS = ['< 5m', '5–30m', '30m–2h', '2–8h', '8h+']

// ---------- Burnout risk ----------

/** Burden weights used for fairness: a page at 3 am costs more than one at 2 pm. */
export const WEIGHTS: Record<Bucket, number> = { business: 1, evening: 1.5, weekend: 2, sleep: 3 }

export interface ScoreParts { sleep: number; nights: number; weekends: number; evenings: number }
/**
 * Burnout-risk score, 0-100, documented on /docs:
 *   sleep interruptions per week x 10, capped at 40
 *   (longest run of consecutive interrupted nights - 1) x 25/3, capped at 25
 *   interrupted non-working days per 30 days x 4, capped at 20
 *   evening pages per week x 3, capped at 15
 */
export function burnoutScore(x: { sleepPerWeek: number; maxNights: number; weekendDaysPerMonth: number; eveningPerWeek: number }): { score: number; parts: ScoreParts } {
  const parts = {
    sleep: Math.min(40, x.sleepPerWeek * 10),
    nights: Math.min(25, Math.max(0, x.maxNights - 1) * 25 / 3),
    weekends: Math.min(20, x.weekendDaysPerMonth * 4),
    evenings: Math.min(15, x.eveningPerWeek * 3),
  }
  return { score: Math.round(parts.sleep + parts.nights + parts.weekends + parts.evenings), parts }
}
export type Band = 'low' | 'moderate' | 'high' | 'severe'
export const band = (s: number): Band => s < 20 ? 'low' : s < 45 ? 'moderate' : s < 70 ? 'high' : 'severe'

// ---------- Analysis ----------

export interface PersonStats {
  name: string
  pages: number
  buckets: Record<Bucket, number>
  burden: number
  share: number
  fairShare: number
  sleepNights: number
  maxNights: number
  weekendDays: number
  ackMins: number[]
  ackP50: number
  ackP90: number
  ttrP50: number
  score: number
  parts: ScoreParts
  band: Band
  /** 7 x 24 local-time counts, Monday first */
  heat: number[]
  excluded: boolean
}

export interface Analysis {
  from: number
  to: number
  days: number
  weeks: number
  months: number
  total: number
  buckets: Record<Bucket, number>
  people: PersonStats[]
  giniPages: number
  giniBurden: number
  ackMins: number[]
  resMins: number[]
  ackP50: number
  ackP90: number
  ttrP50: number
  ttrP90: number
  neverAcked: number
  autoResolved: number
  nonActionable: number
}

const zero = (): Record<Bucket, number> => ({ business: 0, evening: 0, weekend: 0, sleep: 0 })

/** Observed window, at least a week, so rates on tiny exports don't explode. */
export function range(incidents: Incident[]) {
  if (!incidents.length) return { from: 0, to: 0, days: 7 }
  let from = Infinity, to = -Infinity
  for (const i of incidents) { if (i.created < from) from = i.created; if (i.created > to) to = i.created }
  return { from, to, days: Math.max(7, (to - from) / DAY) }
}

export function analyze(incidents: Incident[], cfg: Config, span?: { days: number }): Analysis {
  const r = range(incidents)
  const days = span?.days ?? r.days
  const weeks = days / 7, months = days / MONTH_DAYS
  const by = new Map<string, Incident[]>()
  for (const n of Object.keys(cfg.people)) by.set(n, [])
  for (const i of incidents) { const l = by.get(i.person) ?? []; l.push(i); by.set(i.person, l) }
  const buckets = zero()
  const people: PersonStats[] = []
  for (const [name, list] of by) {
    const p = personCfg(cfg, name)
    const b = zero()
    const heat = new Array(168).fill(0)
    const nights = new Set<string>()
    const offDays = new Set<string>()
    for (const i of list) {
      const k = bucketOf(i.created, p, cfg)
      b[k]++; buckets[k]++
      const l = local(i.created, p.tz)
      heat[((l.dow + 6) % 7) * 24 + Math.floor(l.hour)]++
      if (k === 'sleep') nights.add(nightOf(i.created, p.tz, cfg.sleepEnd))
      if (!p.workDays.includes(l.dow)) offDays.add(l.date)
    }
    const ackMins = list.filter(i => i.acked !== undefined).map(i => (i.acked! - i.created) / 60000)
    const ttr = list.filter(i => i.resolved !== undefined).map(i => (i.resolved! - i.created) / 60000)
    const maxNights = longestRun(nights)
    const s = burnoutScore({ sleepPerWeek: b.sleep / weeks, maxNights, weekendDaysPerMonth: offDays.size / months, eveningPerWeek: b.evening / weeks })
    people.push({
      name, pages: list.length, buckets: b, burden: (Object.keys(b) as Bucket[]).reduce((a, k) => a + b[k] * WEIGHTS[k], 0),
      share: 0, fairShare: 0, sleepNights: nights.size, maxNights, weekendDays: offDays.size,
      ackMins, ackP50: percentile(ackMins, 50), ackP90: percentile(ackMins, 90), ttrP50: percentile(ttr, 50),
      score: s.score, parts: s.parts, band: band(s.score), heat,
      excluded: !!p.excluded || name === 'Unassigned',
    })
  }
  const rota = people.filter(p => !p.excluded)
  const rotaTotal = rota.reduce((a, p) => a + p.pages, 0)
  for (const p of people) { p.share = !p.excluded && rotaTotal ? p.pages / rotaTotal : 0; p.fairShare = !p.excluded && rota.length ? 1 / rota.length : 0 }
  people.sort((a, b) => Number(a.excluded) - Number(b.excluded) || b.score - a.score || b.pages - a.pages || a.name.localeCompare(b.name))
  const ackMins = incidents.filter(i => i.acked !== undefined).map(i => (i.acked! - i.created) / 60000)
  const resMins = incidents.filter(i => i.resolved !== undefined).map(i => (i.resolved! - i.created) / 60000)
  return {
    from: r.from, to: r.to, days, weeks, months, total: incidents.length, buckets, people,
    giniPages: gini(rota.map(p => p.pages)), giniBurden: gini(rota.map(p => p.burden)),
    ackMins, resMins, ackP50: percentile(ackMins, 50), ackP90: percentile(ackMins, 90), ttrP50: percentile(resMins, 50), ttrP90: percentile(resMins, 90),
    neverAcked: incidents.filter(i => i.acked === undefined).length,
    autoResolved: incidents.filter(i => isAutoQuick(i, Infinity)).length,
    nonActionable: incidents.filter(i => i.actionable === false).length,
  }
}

// ---------- Noise and fixes ----------

/** Groups re-firings of the same alert: the source's dedupe key, else service + title with numbers, ids and hosts masked. */
export function normalizeTitle(t: string): string {
  return t.toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '#')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '#')
    .replace(/\b[0-9a-f]{7,}\b/g, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ').trim()
}
export const alertKey = (i: Incident) => i.service + ' :: ' + normalizeTitle(i.title)

/** Resolved by the tool (or without anyone acking) within the threshold. */
export function isAutoQuick(i: Incident, minutes: number): boolean {
  if (i.resolved === undefined || i.autoResolved === false) return false
  if (i.autoResolved !== true && i.acked !== undefined && i.acked <= i.resolved) return false
  return (i.resolved - i.created) / 60000 < minutes
}

export type FixKind = 'delete' | 'dedupe' | 'delay' | 'dependency' | 'downgrade'
export interface Fix {
  id: string
  kind: FixKind
  key: string
  title: string
  service: string
  fires: number
  removed: string[]
  perMonth: number
  sleepPerMonth: number
  evidence: string
  change: string
  how: string
}

export const FIX_LABEL: Record<FixKind, string> = { delete: 'Delete or move to a dashboard', dedupe: 'Add a dedupe key', delay: 'Add an escalation delay', dependency: 'Add a dependency', downgrade: 'Downgrade to low urgency' }

const pct = (a: number, b: number) => `${Math.round(a / b * 100)}%`
const mins = (m: number) => m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`

export function detectFixes(incidents: Incident[], cfg: Config, span?: { days: number }): Fix[] {
  const months = (span?.days ?? range(incidents).days) / MONTH_DAYS
  const sorted = [...incidents].sort((a, b) => a.created - b.created)
  const groups = new Map<string, Incident[]>()
  for (const i of sorted) { const k = alertKey(i); const l = groups.get(k) ?? []; l.push(i); groups.set(k, l) }
  const isSleep = new Map(sorted.map(i => [i.id, bucketOf(i.created, personCfg(cfg, i.person), cfg)]))
  const fixes: Fix[] = []
  const add = (kind: FixKind, key: string, list: Incident[], removed: Incident[], evidence: string, change: string, how: string) => {
    if (removed.length < 2) return
    fixes.push({
      id: kind + '|' + key, kind, key, title: list[list.length - 1].title, service: list[0].service, fires: list.length,
      removed: removed.map(i => i.id), perMonth: removed.length / months, sleepPerMonth: removed.filter(i => isSleep.get(i.id) === 'sleep').length / months,
      evidence, change, how,
    })
  }
  const window = cfg.flapWindowMin * 60000

  // Dependencies: alerts that fire within 10 minutes after another service's alert.
  const deps = dependencyMap(sorted, 10 * 60000)

  for (const [key, list] of groups) {
    const n = list.length
    const nonAct = list.filter(i => i.actionable === false)
    if (nonAct.length >= n * 0.5 && nonAct.length >= 2) {
      add('delete', key, list, list, `${nonAct.length} of ${n} pages (${pct(nonAct.length, n)}) were marked non-actionable.`,
        'Nobody needs to act on this. Delete the page, or route it to a dashboard or a low-priority channel that never notifies.',
        'PagerDuty: Event Orchestration rule "suppress". Opsgenie: alert policy "Do not create alert". Rootly: alert route to a non-paging channel.')
      continue
    }
    // Duplicates: fired again while the previous one was still open.
    const dups: Incident[] = []
    const flaps: Incident[] = []
    let open: Incident | null = null
    let chain: Incident[] = []
    const flushChain = () => { if (chain.length >= cfg.flapMinFirings) flaps.push(...chain.slice(1)); chain = [] }
    for (const i of list) {
      if (open && open.resolved !== undefined && i.created < open.resolved) { dups.push(i); continue }
      const prevEnd = chain.length ? (chain[chain.length - 1].resolved ?? chain[chain.length - 1].created) : -Infinity
      if (chain.length && i.created - prevEnd <= window) chain.push(i)
      else { flushChain(); chain = [i] }
      open = i
    }
    flushChain()
    if (dups.length + flaps.length >= 2) {
      const ev = [dups.length ? `${dups.length} fired while an earlier page for the same alert was still open` : '', flaps.length ? `${flaps.length} re-fired within ${mins(cfg.flapWindowMin)} of resolving (flapping)` : ''].filter(Boolean).join('; ')
      add('dedupe', key, list, [...dups, ...flaps], `${n} pages; ${ev}.`,
        `Group re-firings into one incident with a stable dedupe key, and add ${mins(cfg.flapWindowMin)} of hysteresis so it only resolves after staying healthy.`,
        `PagerDuty: send "dedup_key": "${list[0].key ?? slug(key)}" (or Content-Based Alert Grouping). Opsgenie: set the alias. Prometheus: a for: clause and a resolve hold-off.`)
    }
    const quick = list.filter(i => isAutoQuick(i, cfg.autoResolveMin))
    if (quick.length >= Math.max(2, n * 0.3)) {
      add('delay', key, list, quick, `${quick.length} of ${n} pages (${pct(quick.length, n)}) resolved on their own within ${cfg.autoResolveMin} min, before anyone could act.`,
        `Wait ${cfg.autoResolveMin} min before notifying. Transient spikes resolve silently; real problems still page.`,
        `PagerDuty: Service settings > Auto-pause incident notifications (${cfg.autoResolveMin} min). Opsgenie: notification rule delay. Prometheus: for: ${cfg.autoResolveMin}m.`)
    }
    const dep = deps.get(key)
    if (dep && dep.hits.length >= Math.max(3, n * 0.6)) {
      add('dependency', key, list, dep.hits, `${dep.hits.length} of ${n} pages (${pct(dep.hits.length, n)}) fired within 10 min after "${groups.get(dep.other)?.[0].title ?? dep.other.split(' :: ')[1]}" on ${dep.other.split(' :: ')[0]}.`,
        `Make this alert depend on ${dep.other.split(' :: ')[0]}: suppress it while the upstream alert is open, so one root cause pages once.`,
        'PagerDuty: Service dependencies + Event Orchestration condition on the upstream incident. Opsgenie: alert policy with a dependency tag. Alertmanager: inhibit_rules.')
    }
    const never = list.filter(i => i.acked === undefined && !isAutoQuick(i, cfg.autoResolveMin))
    if (never.length >= Math.max(3, n * 0.6) && list.some(i => i.urgency === 'high')) {
      const off = never.filter(i => isSleep.get(i.id) !== 'business')
      add('downgrade', key, list, off, `${never.length} of ${n} pages (${pct(never.length, n)}) were never acknowledged. If nobody acts, it should not wake anyone.`,
        'Downgrade to low urgency: notify during working hours only, and review it in the weekly ops meeting.',
        'PagerDuty: urgency "Use support hours" or "Low". Opsgenie: priority P4/P5 with a business-hours notification rule.')
    }
  }
  return fixes.sort((a, b) => (b.perMonth + 2 * b.sleepPerMonth) - (a.perMonth + 2 * a.sleepPerMonth) || a.id.localeCompare(b.id))
}

const slug = (k: string) => k.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60)

function dependencyMap(sorted: Incident[], win: number) {
  const out = new Map<string, { other: string; hits: Incident[] }>()
  const counts = new Map<string, Map<string, Incident[]>>()
  let lo = 0
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    while (sorted[lo].created < a.created - win) lo++
    const ka = alertKey(a)
    const seen = new Set<string>()
    for (let j = lo; j < i; j++) {
      const b = sorted[j]
      if (b.service === a.service) continue
      const kb = alertKey(b)
      if (seen.has(kb)) continue
      seen.add(kb)
      const m = counts.get(ka) ?? new Map()
      const l = m.get(kb) ?? []
      l.push(a)
      m.set(kb, l)
      counts.set(ka, m)
    }
  }
  for (const [ka, m] of counts) {
    let best: [string, Incident[]] | null = null
    for (const e of m) if (!best || e[1].length > best[1].length) best = e
    // The upstream must itself fire at least as often, or "dependency" is backwards.
    if (best && (counts.get(best[0])?.get(ka)?.length ?? 0) < best[1].length) out.set(ka, { other: best[0], hits: best[1] })
  }
  return out
}

/** Pages left after the given fixes. */
export function applyFixes(incidents: Incident[], fixes: Fix[], applied: string[]): Incident[] {
  const on = new Set(applied)
  const gone = new Set(fixes.filter(f => on.has(f.id)).flatMap(f => f.removed))
  return gone.size ? incidents.filter(i => !gone.has(i.id)) : incidents
}

// ---------- Rotation simulator ----------

export type RotaMode = 'single' | 'primary-secondary' | 'follow-the-sun'
export interface RotaInput { mode: RotaMode; size: number; shiftDays: number; tz: string; regions: string[]; escalationRate: number }
export interface RotaPerson { label: string; region: string; pagesPerMonth: number; sleepPerMonth: number; weekendDaysPerMonth: number; shiftsPerMonth: number }
export interface RotaResult { people: RotaPerson[]; pagesPerMonth: number; sleepPerMonth: number; note: string }

/** Projects the observed page arrival pattern onto a different rotation. Everyone in a region shares its load evenly. */
export function simulateRota(incidents: Incident[], cfg: Pick<Config, 'sleepStart' | 'sleepEnd'>, input: RotaInput, span?: { days: number }): RotaResult {
  const months = (span?.days ?? range(incidents).days) / MONTH_DAYS
  const size = Math.max(1, Math.round(input.size))
  const weekendDaysPerMonth = 8.7
  const shiftsPerMonth = (MONTH_DAYS / Math.max(1, input.shiftDays)) / size
  if (input.mode === 'follow-the-sun') {
    const regions = input.regions.filter(validTz).slice(0, 3)
    if (regions.length < 2) return simulateRota(incidents, cfg, { ...input, mode: 'single' }, span)
    const per = regions.map(() => ({ pages: 0, sleep: 0 }))
    for (const i of incidents) {
      // Each UTC hour goes to the region where it is closest to 13:00.
      let best = 0, bestD = Infinity
      regions.forEach((tz, k) => { const d = Math.abs(local(i.created, tz).hour - 13); if (d < bestD) { bestD = d; best = k } })
      per[best].pages++
      if (inSleep(local(i.created, regions[best]).hour, cfg.sleepStart, cfg.sleepEnd)) per[best].sleep++
    }
    const people: RotaPerson[] = []
    regions.forEach((tz, k) => {
      const n = Math.floor(size / regions.length) + (k < size % regions.length ? 1 : 0)
      for (let j = 0; j < n; j++) people.push({ label: `${regionName(tz)} ${j + 1}`, region: tz, pagesPerMonth: per[k].pages / months / n, sleepPerMonth: per[k].sleep / months / n, weekendDaysPerMonth: weekendDaysPerMonth / n, shiftsPerMonth: (MONTH_DAYS / Math.max(1, input.shiftDays)) / n })
    })
    return { people, pagesPerMonth: incidents.length / months, sleepPerMonth: per.reduce((a, p) => a + p.sleep, 0) / months, note: `Each region covers the ${Math.round(24 / regions.length)} hours around its working day.` }
  }
  let sleep = 0
  for (const i of incidents) if (inSleep(local(i.created, input.tz).hour, cfg.sleepStart, cfg.sleepEnd)) sleep++
  const factor = input.mode === 'primary-secondary' ? 1 + Math.min(1, Math.max(0, input.escalationRate)) : 1
  const people = Array.from({ length: size }, (_, j) => ({
    label: `Engineer ${j + 1}`, region: input.tz,
    pagesPerMonth: incidents.length / months / size * factor, sleepPerMonth: sleep / months / size * factor,
    weekendDaysPerMonth: weekendDaysPerMonth / size * (input.mode === 'primary-secondary' ? 2 : 1), shiftsPerMonth: shiftsPerMonth * (input.mode === 'primary-secondary' ? 2 : 1),
  }))
  return { people, pagesPerMonth: incidents.length / months, sleepPerMonth: sleep / months, note: input.mode === 'primary-secondary' ? `Each person is primary and secondary in turn; ${Math.round(input.escalationRate * 100)}% of pages escalate to the secondary.` : 'One person holds the pager for each shift.' }
}

export const regionName = (tz: string) => tz.split('/').pop()!.replace(/_/g, ' ')

/** Share of pages not acknowledged within 5 minutes: a fair guess at what escalates to a secondary. */
export const escalationRate = (incidents: Incident[]) => incidents.length ? incidents.filter(i => i.acked === undefined || i.acked - i.created > 5 * 60000).length / incidents.length : 0

// ---------- Compensation and time off in lieu ----------

export interface CompRow { name: string; weeks: number; offHours: number; sleep: number; weekendDays: number; stipend: number; pagePay: number; total: number; toilHours: number }

/** Pages within groupMinutes of the previous one for the same person count once (one wake-up, one payout). */
export function compensation(incidents: Incident[], cfg: Config, policy: CompPolicy, weeksOverride: Record<string, number> = {}): CompRow[] {
  const by = new Map<string, Incident[]>()
  for (const i of incidents) { if (i.person === 'Unassigned') continue; const l = by.get(i.person) ?? []; l.push(i); by.set(i.person, l) }
  for (const n of Object.keys(cfg.people)) if (!by.has(n) && !cfg.people[n].excluded) by.set(n, [])
  const rows: CompRow[] = []
  for (const [name, list] of by) {
    const p = personCfg(cfg, name)
    if (p.excluded) continue
    list.sort((a, b) => a.created - b.created)
    let offHours = 0, sleep = 0, last = -Infinity
    const weeks = new Set<string>(), offDays = new Set<string>()
    for (const i of list) {
      const b = bucketOf(i.created, p, cfg)
      const l = local(i.created, p.tz)
      weeks.add(isoWeek(l.ms))
      if (!p.workDays.includes(l.dow)) offDays.add(l.date)
      if (i.created - last < policy.groupMinutes * 60000) continue
      last = i.created
      if (b === 'sleep') sleep++
      else if (b !== 'business') offHours++
    }
    const w = weeksOverride[name] ?? weeks.size
    const stipend = w * policy.stipendPerWeek
    const pagePay = offHours * policy.perOffHoursPage + sleep * policy.perSleepPage
    rows.push({ name, weeks: w, offHours, sleep, weekendDays: offDays.size, stipend, pagePay, total: stipend + pagePay, toilHours: sleep * policy.toilPerSleepPage + offDays.size * policy.toilPerWeekendDay })
  }
  return rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

export function isoWeek(ms: number): string {
  const d = new Date(ms)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)
  const y = d.getUTCFullYear()
  const jan4 = Date.UTC(y, 0, 4)
  const w = 1 + Math.round(((d.getTime() - jan4) / DAY - 3 + ((new Date(jan4).getUTCDay() + 6) % 7)) / 7)
  return `${y}-W${String(w).padStart(2, '0')}`
}

// ---------- Periods and snapshots ----------

export const quarterOf = (t: number) => { const d = new Date(t); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}` }
export const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7)

export function periodBounds(period: string): [number, number] {
  const q = period.match(/^(\d{4})-Q([1-4])$/)
  if (q) return [Date.UTC(+q[1], (+q[2] - 1) * 3, 1), Date.UTC(+q[1], +q[2] * 3, 1)]
  const [y, m] = period.split('-').map(Number)
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)]
}

export function periods(incidents: Incident[], kind: 'month' | 'quarter'): string[] {
  const s = new Set(incidents.map(i => kind === 'month' ? monthOf(i.created) : quarterOf(i.created)))
  return [...s].sort()
}

export function slicePeriod(incidents: Incident[], period: string): { incidents: Incident[]; days: number } {
  const [a, b] = periodBounds(period)
  const list = incidents.filter(i => i.created >= a && i.created < b)
  // A period still in progress is measured to its last page, not to its calendar end.
  const end = Math.min(b, list.reduce((m, i) => Math.max(m, i.created + 1), a + 7 * DAY))
  return { incidents: list, days: (end - a) / DAY }
}

export interface Snapshot {
  id: string
  label: string
  period: string
  at: number
  days: number
  pages: number
  pagesPerMonth: number
  buckets: Record<Bucket, number>
  giniPages: number
  ackP50: number
  ttrP50: number
  noisePerMonth: number
  people: { name: string; pages: number; sleep: number; weekendDays: number; score: number }[]
}

export function snapshot(incidents: Incident[], cfg: Config, period: string, id: string, label: string): Snapshot {
  const s = slicePeriod(incidents, period)
  const a = analyze(s.incidents, cfg, { days: s.days })
  const fixes = detectFixes(s.incidents, cfg, { days: s.days })
  const gone = new Set(fixes.flatMap(f => f.removed))
  return {
    id, label, period, at: Date.now(), days: s.days, pages: a.total, pagesPerMonth: a.total / a.months, buckets: a.buckets,
    giniPages: a.giniPages, ackP50: a.ackP50, ttrP50: a.ttrP50, noisePerMonth: gone.size / a.months,
    people: a.people.filter(p => !p.excluded).map(p => ({ name: p.name, pages: p.pages, sleep: p.buckets.sleep, weekendDays: p.weekendDays, score: p.score })),
  }
}
