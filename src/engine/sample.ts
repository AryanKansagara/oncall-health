// Synthetic teams. Deterministic, so tests and screenshots are stable. All names and services are made up.
import { local } from './analyze.ts'
import type { Config, Incident, PersonCfg } from './types.ts'

export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR

interface AlertDef {
  title: string
  service: string
  urgency?: 'high' | 'low'
  /** Expected firings per day */
  perDay: number
  /** Local hours (team tz) the alert prefers; empty = any hour */
  hours?: number[]
  /** Re-fires this many extra times, gapMin apart (flapping) */
  burst?: [number, number]
  gapMin?: [number, number]
  /** Fires again while the first is open */
  dupProb?: number
  autoProb: number
  autoMin?: [number, number]
  ackProb?: number
  ttrMin?: [number, number]
  actionable?: boolean
  routeTo?: string
  /** Child alert: fires after each parent firing with this probability */
  children?: { def: AlertDef; prob: number; lagMin: [number, number] }[]
  /** Multiplier from this date on (tuning that already happened) */
  tunedFrom?: string
  tunedFactor?: number
}

export interface SampleDef {
  id: string
  name: string
  blurb: string
  seed: number
  tz: string
  from: string
  to: string
  people: Record<string, PersonCfg>
  rota: (t: number) => string
  alerts: AlertDef[]
}

const NY = 'America/New_York'
const wk = (tz: string, extra: Partial<PersonCfg> = {}): PersonCfg => ({ tz, workStart: 9, workEnd: 17.5, workDays: [1, 2, 3, 4, 5], ...extra })

/** Weekly rotation handing over at 10:00 local on Mondays. */
function weekly(names: string[], tz: string, epoch: string, override?: (name: string, t: number) => string) {
  const start = Date.parse(epoch + 'T10:00:00Z')
  return (t: number) => {
    const l = local(t, tz).ms
    const w = Math.floor((l - start) / (7 * DAY))
    const name = names[((w % names.length) + names.length) % names.length]
    return override ? override(name, t) : name
  }
}

const payments: SampleDef = {
  id: 'payments',
  name: 'Payments platform',
  blurb: 'Six engineers, weekly rotation. A flapping disk alert on the ledger database, and one person absorbing the database pages and weekend swaps.',
  seed: 41, tz: NY, from: '2026-07-01', to: '2026-11-01',
  people: { 'Priya Raman': wk(NY), 'Marco Bellini': wk(NY), 'Jun Park': wk(NY), 'Dana Okafor': wk('America/Chicago'), 'Lena Fischer': wk(NY), 'Sam Whitaker': wk('America/Chicago') },
  rota: weekly(['Marco Bellini', 'Jun Park', 'Dana Okafor', 'Lena Fischer', 'Sam Whitaker', 'Priya Raman'], NY, '2026-06-29', (name, t) => {
    // Priya picks up the weekends nobody else wants.
    const l = local(t, NY)
    return (name === 'Marco Bellini' || name === 'Jun Park') && (l.dow === 0 || l.dow === 6) ? 'Priya Raman' : name
  }),
  alerts: [
    { title: 'Disk usage above 90% on db-ledger-3 /var/lib/postgresql', service: 'payments-db', perDay: 0.32, hours: [1, 2, 2, 3], burst: [1, 4], gapMin: [4, 14], autoProb: 0.92, autoMin: [1, 4], routeTo: 'Priya Raman' },
    { title: 'Postgres primary CPU > 85% (payments-db)', service: 'payments-db', perDay: 0.22, autoProb: 0.3, autoMin: [3, 9], routeTo: 'Priya Raman',
      children: [{ def: { title: 'ledger-writer queue lag > 30s', service: 'ledger-writer', perDay: 0, autoProb: 0.55, autoMin: [2, 8] }, prob: 0.85, lagMin: [2, 7] }] },
    { title: 'Payments API p99 latency > 800ms', service: 'payments-api', perDay: 0.7, hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], autoProb: 0.7, autoMin: [1, 4], tunedFrom: '2026-10-01', tunedFactor: 0.35 },
    { title: 'Nightly reconciliation job failed (settlement-recon)', service: 'settlement-recon', perDay: 0.3, hours: [4, 5], autoProb: 0, ackProb: 0.12, ttrMin: [180, 300] },
    { title: 'Synthetic check failed: checkout-eu from probe-fra-1', service: 'checkout-web', perDay: 0.35, autoProb: 0.25, autoMin: [2, 6], actionable: false, ackProb: 0.5 },
    { title: 'Payment authorization error rate > 2%', service: 'payments-api', perDay: 0.12, autoProb: 0, ackProb: 1, ttrMin: [25, 140] },
    { title: 'Card network webhook 5xx from processor', service: 'processor-gateway', perDay: 0.1, autoProb: 0.15, autoMin: [4, 9], ackProb: 0.95, ttrMin: [15, 60] },
  ],
}

const LDN = 'Europe/London', SYD = 'Australia/Sydney'
const search: SampleDef = {
  id: 'search',
  name: 'Search, follow-the-sun',
  blurb: 'London and Sydney hand the pager across the day, so almost nobody is woken. The noise is duplicate replica-lag pages and GC pauses.',
  seed: 7, tz: LDN, from: '2026-07-01', to: '2026-11-01',
  people: { 'Aisha Khan': wk(LDN), 'Tom Hughes': wk(LDN), 'Ines Duarte': wk(LDN), 'Liam Nguyen': wk(SYD), 'Chloe Martin': wk(SYD), 'Ravi Patel': wk(SYD) },
  rota: (() => {
    const ldn = weekly(['Aisha Khan', 'Tom Hughes', 'Ines Duarte'], LDN, '2026-06-29')
    const syd = weekly(['Liam Nguyen', 'Chloe Martin', 'Ravi Patel'], SYD, '2026-06-29')
    return (t: number) => { const h = local(t, LDN).hour; return h >= 8 && h < 20 ? ldn(t) : syd(t) }
  })(),
  alerts: [
    { title: 'Index replica lag > 120s on search-es-4', service: 'search-index', perDay: 0.55, dupProb: 0.75, autoProb: 0.2, autoMin: [3, 8], ackProb: 0.9, ttrMin: [20, 70] },
    { title: 'Elasticsearch old-gen GC pause > 2s', service: 'search-cluster', perDay: 0.8, autoProb: 0.85, autoMin: [1, 3] },
    { title: 'Query latency p95 > 400ms (search-api)', service: 'search-api', perDay: 0.3, autoProb: 0.45, autoMin: [2, 6], ackProb: 0.9, ttrMin: [10, 50] },
    { title: 'Ingest pipeline stalled: catalog-updates', service: 'search-ingest', perDay: 0.15, autoProb: 0, ackProb: 1, ttrMin: [30, 180] },
  ],
}

const BER = 'Europe/Berlin'
const platform: SampleDef = {
  id: 'platform',
  name: 'Platform infra, four people',
  blurb: 'A small team where one engineer has held the pager four of the last five weekends. Kubernetes node pressure pages that nobody acknowledges.',
  seed: 99, tz: BER, from: '2026-07-01', to: '2026-11-01',
  people: { 'Jonas Weber': wk(BER), 'Mia Schulz': wk(BER), 'Elif Yilmaz': wk(BER), 'Noah Becker': wk(BER) },
  rota: weekly(['Jonas Weber', 'Mia Schulz', 'Elif Yilmaz', 'Noah Becker'], BER, '2026-06-29', (name, t) => {
    const l = local(t, BER)
    return (l.dow === 0 || l.dow === 6) && name !== 'Mia Schulz' ? 'Elif Yilmaz' : name
  }),
  alerts: [
    { title: 'KubeNodeMemoryPressure on node pool general-b', service: 'k8s-prod', perDay: 0.9, autoProb: 0.15, autoMin: [3, 9], ackProb: 0.1, ttrMin: [30, 120] },
    { title: 'Certificate expires in < 14 days: *.internal', service: 'pki', urgency: 'high', perDay: 0.25, hours: [6, 7], autoProb: 0, ackProb: 0.3, ttrMin: [600, 1400], actionable: false },
    { title: 'etcd leader changes > 3 in 10m', service: 'k8s-prod', perDay: 0.25, burst: [1, 3], gapMin: [8, 20], autoProb: 0.8, autoMin: [2, 6] },
    { title: 'CI runners queue depth > 50', service: 'ci', perDay: 0.4, hours: [10, 11, 14, 15, 16], autoProb: 0.6, autoMin: [2, 6], ackProb: 0.8, ttrMin: [10, 40] },
    { title: 'Ingress 5xx rate > 1% (edge-lb)', service: 'edge', perDay: 0.12, autoProb: 0.1, autoMin: [3, 6], ackProb: 1, ttrMin: [20, 90] },
  ],
}

export const SAMPLES: SampleDef[] = [payments, search, platform]

export function generate(def: SampleDef): Incident[] {
  const r = rng(def.seed)
  const between = (a: number, b: number) => a + r() * (b - a)
  const out: Incident[] = []
  let n = 0
  const from = Date.parse(def.from + 'T00:00:00Z'), to = Date.parse(def.to + 'T00:00:00Z')
  const emit = (a: AlertDef, t: number) => {
    if (t >= to) return
    const id = `${def.id.slice(0, 2).toUpperCase()}${String(++n).padStart(5, '0')}`
    const person = a.routeTo ?? def.rota(t)
    const sleepy = (() => { const h = local(t, def.tz).hour; return h >= 22 || h < 7 })()
    const inc: Incident = { id, title: a.title, service: a.service, person, urgency: a.urgency ?? 'high', created: t }
    if (r() < a.autoProb) {
      inc.resolved = t + between(...(a.autoMin ?? [1, 4])) * MIN
      inc.autoResolved = true
    } else {
      if (r() < (a.ackProb ?? 0.85)) inc.acked = t + between(0.5, sleepy ? 14 : 6) * MIN * (r() < 0.08 ? 4 : 1)
      inc.resolved = (inc.acked ?? t) + between(...(a.ttrMin ?? [8, 45])) * MIN
      inc.autoResolved = false
    }
    if (a.actionable === false) inc.actionable = false
    out.push(inc)
    for (const c of a.children ?? []) if (r() < c.prob) emit(c.def, t + between(...c.lagMin) * MIN)
    return inc
  }
  for (let d = from; d < to; d += DAY) {
    for (const a of def.alerts) {
      let rate = a.perDay
      if (a.tunedFrom && d >= Date.parse(a.tunedFrom + 'T00:00:00Z')) rate *= a.tunedFactor ?? 1
      // Poisson-ish: whole part plus a coin flip for the fraction.
      let k = Math.floor(rate) + (r() < rate % 1 ? 1 : 0)
      while (k-- > 0) {
        let t: number
        if (a.hours?.length) {
          const h = a.hours[Math.floor(r() * a.hours.length)] + r()
          // Local hour h on this calendar day, team tz.
          const guess = d + h * HOUR
          t = guess - (local(guess, def.tz).ms - guess)
        } else t = d + r() * DAY
        const first = emit(a, t)
        if (!first) continue
        if (a.burst) {
          let last = first
          const extra = Math.round(between(a.burst[0], a.burst[1]))
          for (let j = 0; j < extra; j++) {
            const next = emit(a, (last.resolved ?? last.created) + between(...(a.gapMin ?? [5, 15])) * MIN)
            if (!next) break
            last = next
          }
        }
        if (a.dupProb && r() < a.dupProb && first.resolved) emit({ ...a, burst: undefined, dupProb: 0, children: [] }, first.created + (first.resolved - first.created) * between(0.2, 0.7))
      }
    }
  }
  return out.sort((a, b) => a.created - b.created)
}

export const DEFAULT_POLICY = { currency: 'USD', stipendPerWeek: 300, perOffHoursPage: 25, perSleepPage: 75, toilPerSleepPage: 2, toilPerWeekendDay: 4, groupMinutes: 30 }

export function sampleConfig(def: SampleDef): Config {
  return { people: structuredClone(def.people), defaultTz: def.tz, sleepStart: 22, sleepEnd: 7, autoResolveMin: 5, flapWindowMin: 60, flapMinFirings: 3, applied: [], policy: { ...DEFAULT_POLICY } }
}
