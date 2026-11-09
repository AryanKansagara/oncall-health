import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alertKey, analyze, applyFixes, bucketOf, burnoutScore, compensation, detectFixes, escalationRate, gini, histogram, isoWeek, local, longestRun, nightOf, normalizeTitle, percentile, periods, simulateRota, slicePeriod, snapshot } from './analyze.ts'
import { applyLogEntries, autoMap, detectCsvFormat, incidentsToCsv, mergeIncidents, parseCsv, parseJson, parseTime, toUrgency, validate } from './csv.ts'
import { DEFAULT_POLICY, generate, SAMPLES, sampleConfig } from './sample.ts'
import type { Config, Incident } from './types.ts'

const NY = 'America/New_York'
const cfg = (people: string[] = ['A', 'B'], tz = 'UTC'): Config => ({
  people: Object.fromEntries(people.map(p => [p, { tz, workStart: 9, workEnd: 17, workDays: [1, 2, 3, 4, 5] }])),
  defaultTz: tz, sleepStart: 22, sleepEnd: 7, autoResolveMin: 5, flapWindowMin: 60, flapMinFirings: 3, applied: [], policy: { ...DEFAULT_POLICY },
})
let seq = 0
const inc = (iso: string, o: Partial<Incident> = {}): Incident => ({ id: `i${++seq}`, title: 'Disk full on db-1', service: 'db', person: 'A', urgency: 'high', created: Date.parse(iso), ...o })
const M = 60000

test('local time follows DST in New York', () => {
  assert.equal(local(Date.parse('2026-07-01T12:00:00Z'), NY).hour, 8)
  assert.equal(local(Date.parse('2026-12-01T12:00:00Z'), NY).hour, 7)
  assert.equal(local(Date.parse('2026-11-01T05:30:00Z'), NY).hour, 1.5)
})

test('buckets: sleep beats weekend, business is working hours on working days', () => {
  const p = { tz: NY, workStart: 9, workEnd: 17, workDays: [1, 2, 3, 4, 5] }
  const c = { sleepStart: 22, sleepEnd: 7 }
  assert.equal(bucketOf(Date.parse('2026-10-07T14:00:00Z'), p, c), 'business') // Wed 10:00
  assert.equal(bucketOf(Date.parse('2026-10-07T23:00:00Z'), p, c), 'evening') // Wed 19:00
  assert.equal(bucketOf(Date.parse('2026-10-08T07:00:00Z'), p, c), 'sleep') // Thu 03:00
  assert.equal(bucketOf(Date.parse('2026-10-10T16:00:00Z'), p, c), 'weekend') // Sat 12:00
  assert.equal(bucketOf(Date.parse('2026-10-11T06:00:00Z'), p, c), 'sleep') // Sun 02:00
})

test('configurable sleep window that does not cross midnight', () => {
  const p = { tz: 'UTC', workStart: 9, workEnd: 17, workDays: [1, 2, 3, 4, 5] }
  assert.equal(bucketOf(Date.parse('2026-10-07T01:30:00Z'), p, { sleepStart: 1, sleepEnd: 6 }), 'sleep')
  assert.equal(bucketOf(Date.parse('2026-10-07T23:30:00Z'), p, { sleepStart: 1, sleepEnd: 6 }), 'evening')
})

test('a 03:00 page belongs to the previous night', () => {
  assert.equal(nightOf(Date.parse('2026-10-08T03:00:00Z'), 'UTC', 7), '2026-10-07')
  assert.equal(nightOf(Date.parse('2026-10-07T23:00:00Z'), 'UTC', 7), '2026-10-07')
})

test('percentile uses nearest rank', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9)
  assert.ok(Number.isNaN(percentile([], 50)))
})

test('gini: even is 0, one person carrying everything is (n-1)/n', () => {
  assert.equal(gini([5, 5, 5, 5]), 0)
  assert.equal(gini([0, 0, 0, 12]), 0.75)
  assert.ok(Math.abs(gini([1, 2, 3, 4]) - 0.25) < 1e-9)
})

test('longest run of consecutive nights', () => {
  assert.equal(longestRun(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05', '2026-10-06']), 3)
  assert.equal(longestRun([]), 0)
})

test('histogram edges are lower-inclusive', () => {
  assert.deepEqual(histogram([0.5, 1, 4.9, 5, 70], [1, 5, 15, 30, 60]), [1, 2, 1, 0, 0, 1])
})

test('burnout score components and caps', () => {
  assert.equal(burnoutScore({ sleepPerWeek: 0, maxNights: 0, weekendDaysPerMonth: 0, eveningPerWeek: 0 }).score, 0)
  assert.equal(burnoutScore({ sleepPerWeek: 2, maxNights: 1, weekendDaysPerMonth: 1, eveningPerWeek: 1 }).score, 27)
  assert.equal(burnoutScore({ sleepPerWeek: 99, maxNights: 99, weekendDaysPerMonth: 99, eveningPerWeek: 99 }).score, 100)
})

test('analyze: per-person buckets, shares against a fair share, people with zero pages count', () => {
  const list = [inc('2026-10-07T10:00:00Z'), inc('2026-10-08T03:00:00Z'), inc('2026-10-09T03:00:00Z'), inc('2026-10-10T12:00:00Z'), inc('2026-10-07T11:00:00Z', { person: 'B' })]
  const a = analyze(list, cfg(['A', 'B', 'C']))
  const A = a.people.find(p => p.name === 'A')!
  assert.deepEqual(A.buckets, { business: 1, evening: 0, weekend: 1, sleep: 2 })
  assert.equal(A.maxNights, 2)
  assert.equal(A.share, 0.8)
  assert.ok(Math.abs(A.fairShare - 1 / 3) < 1e-9)
  assert.equal(a.people.find(p => p.name === 'C')!.pages, 0)
  assert.ok(a.giniPages > 0.4)
  assert.equal(A.heat.reduce((x, y) => x + y, 0), 4)
  assert.equal(A.heat[2 * 24 + 10], 1) // Wednesday 10:00 (Monday = row 0)
})

test('excluded people and Unassigned stay out of fairness', () => {
  const c = cfg(['A', 'B'])
  c.people.B.excluded = true
  const a = analyze([inc('2026-10-07T10:00:00Z'), inc('2026-10-07T11:00:00Z', { person: 'B' }), inc('2026-10-07T12:00:00Z', { person: 'Unassigned' })], c)
  assert.equal(a.people.find(p => p.name === 'A')!.share, 1)
  assert.equal(a.people.find(p => p.name === 'B')!.share, 0)
  assert.equal(a.people.at(-1)!.excluded, true)
})

test('ack and resolve percentiles', () => {
  const list = [1, 2, 3, 4, 10].map((m, k) => inc(`2026-10-07T1${k}:00:00Z`, { acked: Date.parse(`2026-10-07T1${k}:00:00Z`) + m * M, resolved: Date.parse(`2026-10-07T1${k}:00:00Z`) + m * 10 * M }))
  const a = analyze(list, cfg())
  assert.equal(a.ackP50, 3)
  assert.equal(a.ackP90, 10)
  assert.equal(a.ttrP50, 30)
})

test('titles normalize so re-firings group together', () => {
  assert.equal(normalizeTitle('Disk 91% on db-ledger-3 (10.0.4.12)'), normalizeTitle('disk 97% on db-ledger-3 (10.0.4.13)'))
  assert.notEqual(alertKey(inc('2026-10-01T00:00:00Z', { service: 'a' })), alertKey(inc('2026-10-01T00:00:00Z', { service: 'b' })))
})

test('flapping: re-fires inside the window are removable, the first page stays', () => {
  const t0 = Date.parse('2026-10-08T03:00:00Z')
  const list = [0, 10, 20, 30].map(k => inc(new Date(t0 + k * M).toISOString(), { resolved: t0 + (k + 8) * M, acked: t0 + (k + 1) * M, autoResolved: false }))
  const f = detectFixes(list, cfg()).find(x => x.kind === 'dedupe')!
  assert.equal(f.removed.length, 3)
  assert.ok(!f.removed.includes(list[0].id))
})

test('duplicates: fired while the previous page was open', () => {
  const t0 = Date.parse('2026-10-07T12:00:00Z')
  const list = [inc('2026-10-07T12:00:00Z', { resolved: t0 + 60 * M, acked: t0 + M }), inc('2026-10-07T12:10:00Z', { resolved: t0 + 70 * M }), inc('2026-10-07T12:20:00Z', { resolved: t0 + 80 * M })]
  const c = cfg(); c.flapWindowMin = 1
  const f = detectFixes(list, c).find(x => x.kind === 'dedupe')!
  assert.match(f.evidence, /2 fired while an earlier page/)
})

test('auto-resolved under N minutes suggests an escalation delay', () => {
  const list = [1, 2, 3, 4].map(d => { const t = Date.parse(`2026-10-0${d}T12:00:00Z`); return inc(`2026-10-0${d}T12:00:00Z`, { resolved: t + 2 * M, autoResolved: true }) })
  list.push(inc('2026-10-05T12:00:00Z', { resolved: Date.parse('2026-10-05T12:00:00Z') + 30 * M, acked: Date.parse('2026-10-05T12:00:00Z') + M, autoResolved: false }))
  const f = detectFixes(list, cfg()).find(x => x.kind === 'delay')!
  assert.equal(f.removed.length, 4)
  assert.ok(Math.abs(f.perMonth - 4 / (7 / 30.44)) < 1e-6)
})

test('non-actionable alerts suggest deletion; never-acked high urgency suggests a downgrade of off-hours pages', () => {
  const del = detectFixes([1, 2, 3].map(d => inc(`2026-10-0${d}T12:00:00Z`, { actionable: false, title: 'Synthetic probe' })), cfg())
  assert.equal(del[0].kind, 'delete')
  const never = [1, 2, 5, 6].map(d => inc(`2026-10-0${d}T03:00:00Z`, { title: 'Recon failed', resolved: Date.parse(`2026-10-0${d}T07:00:00Z`) }))
  const down = detectFixes(never, cfg()).find(x => x.kind === 'downgrade')!
  assert.equal(down.removed.length, 4)
  assert.equal(down.sleepPerMonth, down.perMonth)
})

test('dependency: downstream alert fires right after an upstream one on another service', () => {
  const list: Incident[] = []
  for (let d = 1; d <= 5; d++) {
    list.push(inc(`2026-10-0${d}T12:00:00Z`, { service: 'db', title: 'CPU high', resolved: Date.parse(`2026-10-0${d}T12:30:00Z`), acked: Date.parse(`2026-10-0${d}T12:01:00Z`) }))
    list.push(inc(`2026-10-0${d}T12:04:00Z`, { service: 'writer', title: 'Queue lag', resolved: Date.parse(`2026-10-0${d}T12:30:00Z`), acked: Date.parse(`2026-10-0${d}T12:05:00Z`) }))
  }
  const fixes = detectFixes(list, cfg())
  const dep = fixes.filter(x => x.kind === 'dependency')
  assert.equal(dep.length, 1)
  assert.equal(dep[0].service, 'writer')
})

test('applying fixes removes exactly the union of their pages', () => {
  const def = SAMPLES[0]
  const list = generate(def), c = sampleConfig(def)
  const fixes = detectFixes(list, c)
  const two = fixes.slice(0, 2)
  const after = applyFixes(list, fixes, two.map(f => f.id))
  assert.equal(list.length - after.length, new Set(two.flatMap(f => f.removed)).size)
  assert.equal(applyFixes(list, fixes, []).length, list.length)
})

test('payments sample: the flapping disk alert is the top fix and one person is overloaded', () => {
  const def = SAMPLES[0]
  const list = generate(def), c = sampleConfig(def)
  const fixes = detectFixes(list, c)
  assert.match(fixes[0].title, /Disk usage/)
  const a = analyze(list, c)
  assert.equal(a.people[0].name, 'Priya Raman')
  assert.equal(a.people[0].band, 'severe')
  assert.ok(a.people[0].share > 2 * a.people[0].fairShare)
  const fixed = analyze(applyFixes(list, fixes, fixes.filter(f => f.key === fixes[0].key).map(f => f.id)), c)
  assert.ok(fixed.buckets.sleep < a.buckets.sleep * 0.7)
})

test('samples are deterministic', () => {
  assert.deepEqual(generate(SAMPLES[1]).slice(0, 5), generate(SAMPLES[1]).slice(0, 5))
})

test('follow-the-sun wakes fewer people than a single rotation', () => {
  const list = generate(SAMPLES[0])
  const base = { size: 6, shiftDays: 7, tz: NY, regions: [NY, 'Europe/London'], escalationRate: 0.2 }
  const single = simulateRota(list, { sleepStart: 22, sleepEnd: 7 }, { ...base, mode: 'single' })
  const fts = simulateRota(list, { sleepStart: 22, sleepEnd: 7 }, { ...base, mode: 'follow-the-sun' })
  const ps = simulateRota(list, { sleepStart: 22, sleepEnd: 7 }, { ...base, mode: 'primary-secondary' })
  assert.equal(single.people.length, 6)
  assert.ok(fts.sleepPerMonth < single.sleepPerMonth / 2)
  assert.ok(Math.abs(ps.people[0].pagesPerMonth - single.people[0].pagesPerMonth * 1.2) < 1e-9)
  const total = fts.people.reduce((a, p) => a + p.pagesPerMonth, 0)
  assert.ok(Math.abs(total - fts.pagesPerMonth) < 1e-6)
})

test('escalation rate counts pages not acked within 5 minutes', () => {
  const t = Date.parse('2026-10-01T00:00:00Z')
  assert.equal(escalationRate([inc('2026-10-01T00:00:00Z', { acked: t + M }), inc('2026-10-01T00:00:00Z', { acked: t + 9 * M }), inc('2026-10-01T00:00:00Z')]), 2 / 3)
})

test('compensation groups pages within the window and applies the policy', () => {
  const list = [inc('2026-10-08T03:00:00Z'), inc('2026-10-08T03:10:00Z'), inc('2026-10-08T20:00:00Z'), inc('2026-10-10T12:00:00Z')]
  const policy = { ...DEFAULT_POLICY, stipendPerWeek: 100, perOffHoursPage: 10, perSleepPage: 50, toilPerSleepPage: 2, toilPerWeekendDay: 4, groupMinutes: 30 }
  const row = compensation(list, cfg(['A']), policy).find(r => r.name === 'A')!
  assert.equal(row.sleep, 1)
  assert.equal(row.offHours, 2)
  assert.equal(row.weeks, 1)
  assert.equal(row.total, 100 + 50 + 20)
  assert.equal(row.toilHours, 2 + 4)
})

test('ISO weeks', () => {
  assert.equal(isoWeek(Date.parse('2026-01-01T00:00:00Z')), '2026-W01')
  assert.equal(isoWeek(Date.parse('2026-12-31T00:00:00Z')), '2026-W53')
  assert.equal(isoWeek(Date.parse('2027-01-04T00:00:00Z')), '2027-W01')
})

test('periods, slices and snapshots', () => {
  const list = generate(SAMPLES[2])
  assert.deepEqual(periods(list, 'quarter'), ['2026-Q3', '2026-Q4'])
  const q3 = slicePeriod(list, '2026-Q3')
  assert.equal(Math.round(q3.days), 92)
  const s = snapshot(list, sampleConfig(SAMPLES[2]), '2026-09', 'x', 'September')
  assert.equal(s.pages, list.filter(i => new Date(i.created).toISOString().startsWith('2026-09')).length)
  assert.equal(s.people.length, 4)
})

// ---------- Import ----------

test('CSV parser handles quotes, newlines in quotes and line numbers', () => {
  const r = parseCsv('a,b\n"x, y","multi\nline"\n1,2\n')
  assert.deepEqual(r.rows[1], ['x, y', 'multi\nline'])
  assert.deepEqual(r.lines, [1, 2, 4])
})

test('timestamps: ISO offsets, epoch ms, slashes', () => {
  assert.equal(parseTime('2026-10-01T07:00:00-04:00'), Date.parse('2026-10-01T11:00:00Z'))
  assert.equal(parseTime('2026-10-01 07:00:00 +0000'), Date.parse('2026-10-01T07:00:00Z'))
  assert.equal(parseTime('1790000000000'), 1790000000000)
  assert.equal(parseTime('2026/10/01 07:00:00'), Date.parse('2026-10-01T07:00:00Z'))
  assert.ok(Number.isNaN(parseTime('yesterday')))
})

test('format detection from headers', () => {
  assert.equal(detectCsvFormat(['id', 'incident_number', 'description', 'status', 'urgency', 'service_name', 'escalation_policy_name', 'created_on', 'resolved_on', 'acknowledged_by', 'assigned_to', 'seconds_to_first_ack', 'seconds_to_resolve', 'auto_resolved']), 'pagerduty-csv')
  assert.equal(detectCsvFormat(['TinyId', 'Alias', 'Message', 'Status', 'CreatedAt', 'Owner', 'Priority', 'Tags', 'AckTime', 'CloseTime', 'AcknowledgedBy', 'ClosedBy']), 'opsgenie-csv')
  assert.equal(detectCsvFormat(['ID', 'Sequential ID', 'Title', 'Severity', 'Started At', 'Acknowledged At', 'Mitigated At', 'Resolved At', 'Services']), 'rootly-csv')
  assert.equal(detectCsvFormat(['when', 'what']), 'generic-csv')
})

test('PagerDuty CSV maps, uses seconds_to_first_ack, and reports bad lines by number', () => {
  const text = 'id,description,urgency,service_name,created_on,acknowledged_by,assigned_to,seconds_to_first_ack,seconds_to_resolve,auto_resolved\n'
    + 'P1,Disk full,high,db,2026-10-01T03:00:00Z,Ann,,120,600,false\n'
    + 'P2,Disk full,low,db,not a date,Ann,,120,600,false\n'
    + 'P3,CPU,high,api,2026-10-01T04:00:00Z,,Bob,,90,true\n'
  const csv = parseCsv(text)
  const v = validate(csv, autoMap(csv.rows[0]), 'pagerduty-csv')
  assert.equal(v.incidents.length, 2)
  assert.equal(v.skipped, 1)
  assert.equal(v.issues[0].line, 3)
  assert.equal(v.incidents[0].acked, Date.parse('2026-10-01T03:02:00Z'))
  assert.equal(v.incidents[1].person, 'Bob')
  assert.equal(v.incidents[1].autoResolved, true)
})

test('Opsgenie CSV: AckTime in ms, ClosedBy decides auto-resolve, tags mark noise', () => {
  const text = 'TinyId,Alias,Message,CreatedAt,Owner,Priority,Tags,AckTime,CloseTime,AcknowledgedBy,ClosedBy\n'
    + '12,disk-db1,Disk full,1790000000000,Ann,P5,"noise,db",60000,120000,Ann,Ann\n'
    + '13,cpu,CPU high,1790000100000,Bob,P1,,,30000,,Alert API\n'
  const csv = parseCsv(text)
  const v = validate(csv, autoMap(csv.rows[0]), detectCsvFormat(csv.rows[0]))
  assert.equal(v.incidents[0].acked, 1790000060000)
  assert.equal(v.incidents[0].urgency, 'low')
  assert.equal(v.incidents[0].actionable, false)
  assert.equal(v.incidents[0].key, 'disk-db1')
  assert.equal(v.incidents[1].autoResolved, true)
  assert.equal(v.incidents[1].person, 'Bob')
})

test('missing required column is a single line-1 error', () => {
  const csv = parseCsv('foo,bar\n1,2\n')
  const v = validate(csv, autoMap(csv.rows[0]))
  assert.equal(v.incidents.length, 0)
  assert.equal(v.issues[0].line, 1)
})

test('PagerDuty REST /incidents and /log_entries', () => {
  const p = parseJson(JSON.stringify({ incidents: [{ id: 'Q1', title: 'Disk', urgency: 'high', status: 'resolved', created_at: '2026-10-01T03:00:00Z', last_status_change_at: '2026-10-01T03:03:00Z', service: { summary: 'db' }, assignments: [{ assignee: { summary: 'Ann' } }], acknowledgements: [] }] }))
  assert.equal(p.format, 'pagerduty-json')
  const v = validate(p.csv, autoMap(p.csv.rows[0]), p.format)
  assert.equal(v.incidents[0].person, 'Ann')
  assert.equal(v.incidents[0].resolved, Date.parse('2026-10-01T03:03:00Z'))
  const logs = parseJson(JSON.stringify({ log_entries: [
    { type: 'notify_log_entry', created_at: '2026-10-01T03:00:05Z', incident: { id: 'Q1' }, user: { summary: 'Bea' }, agent: { type: 'service_reference' } },
    { type: 'resolve_log_entry', created_at: '2026-10-01T03:03:00Z', incident: { id: 'Q1' }, agent: { type: 'generic_events_api_inbound_integration_reference' } },
  ] }))
  assert.equal(logs.format, 'pagerduty-log')
  const e = applyLogEntries(v.incidents, logs.logEntries!)
  assert.equal(e.matched, 1)
  assert.equal(e.incidents[0].person, 'Bea')
  assert.equal(e.incidents[0].autoResolved, true)
})

test('Rootly JSON:API flattens attributes and nested names', () => {
  const p = parseJson(JSON.stringify({ data: [{ id: 'r1', type: 'incidents', attributes: { title: 'Checkout down', started_at: '2026-10-01T10:00:00Z', resolved_at: '2026-10-01T11:00:00Z', severity: { data: { attributes: { name: 'SEV1' } } }, services: [{ name: 'checkout' }], user: { data: { attributes: { name: 'Ann' } } } } }] }))
  assert.equal(p.format, 'rootly-json')
  const v = validate(p.csv, autoMap(p.csv.rows[0]), p.format)
  assert.equal(v.incidents[0].service, 'checkout')
  assert.equal(v.incidents[0].person, 'Ann')
  assert.equal(v.incidents[0].urgency, 'high')
  assert.equal(toUrgency('SEV3'), 'low')
})

test('merging by id and CSV export round-trip', () => {
  const a = [inc('2026-10-01T00:00:00Z', { id: 'x' })], b = [inc('2026-10-02T00:00:00Z', { id: 'x', title: 'new' }), inc('2026-09-01T00:00:00Z', { id: 'y' })]
  const m = mergeIncidents(a, b)
  assert.deepEqual(m.map(i => i.id), ['y', 'x'])
  assert.equal(m[1].title, 'new')
  const csv = parseCsv(incidentsToCsv(m))
  const v = validate(csv, autoMap(csv.rows[0]))
  assert.deepEqual(v.incidents.map(i => [i.id, i.created, i.title]), m.map(i => [i.id, i.created, i.title]))
})
