import { useMemo, useState } from 'react'
import { ACK_EDGES, ACK_LABELS, analyze, applyFixes, compensation, FIX_LABEL, histogram, RES_EDGES, RES_LABELS, simulateRota, type Analysis, type Fix, type RotaInput, type RotaMode, type Snapshot } from './engine/analyze.ts'
import { toCsv } from './engine/csv.ts'
import type { CompPolicy } from './engine/types.ts'
import { BucketBar, BucketLegend, Heatmap, HeatLegend, Hist, ScoreRing, ShareBar } from './charts.tsx'
import { defaultRota } from './projectData.ts'
import type { Tab, TabProps } from './Project.tsx'
import { deleteSnapshotCloud } from './sync.ts'
import { CopyButton, download, Empty, fmtMin, fmtMoney, fmtN, fmtPct, fmtPeriod, Link, signed, toast } from './ui.tsx'

export default function Tabs(p: TabProps & { tab: Tab }) {
  if (p.tab === 'noise') return <Noise {...p} />
  if (p.tab === 'rotation') return <Rotation {...p} />
  if (p.tab === 'pay') return <Pay {...p} />
  if (p.tab === 'history') return <History {...p} />
  return <Overview {...p} />
}

const perMo = (n: number, a: Analysis) => n / a.months
const giniWord = (g: number) => g < 0.15 ? 'even' : g < 0.3 ? 'somewhat uneven' : g < 0.45 ? 'uneven' : 'very uneven'

function AppliedBanner({ a, cfg, setConfig }: TabProps) {
  if (!a.fixed) return null
  const saved = a.base.total - a.fixed.total
  return (
    <div className="banner good" role="status">
      <span><strong>{cfg.applied.length} fix{cfg.applied.length > 1 ? 'es' : ''} applied as a what-if.</strong> Numbers below show the team after the change: {fmtN(perMo(saved, a.base), 1)} fewer pages a month, {fmtN(perMo(a.base.buckets.sleep - a.fixed.buckets.sleep, a.base), 1)} fewer at night.</span>
      <div className="row gap-sm"><Link href={location.pathname.replace(/\/[a-z]+$/, '') + '/noise' + location.search} className="btn sm ghost">Review fixes</Link><button type="button" className="btn sm ghost" onClick={() => setConfig({ applied: [] })}>Clear</button></div>
    </div>
  )
}

function Kpi({ label, value, was, note }: { label: string; value: string; was?: string; note?: string }) {
  return <div className="kpi"><small>{label}</small><b>{value}</b>{was && was !== value && <span className="was">{was}</span>}{note && <p>{note}</p>}</div>
}

function Overview(p: TabProps) {
  const { a, cfg } = p
  const cur = a.fixed ?? a.base
  const base = a.base
  const rota = cur.people.filter(x => !x.excluded)
  const maxShare = Math.max(0.01, ...rota.map(x => Math.max(x.share, x.fairShare)))
  const max = Math.max(1, ...base.people.map(x => Math.max(...x.heat)))
  const was = (f: (x: Analysis) => string) => a.fixed ? f(base) : undefined
  const top = rota[0]
  return (
    <>
      <AppliedBanner {...p} />
      <div className="kpis">
        <Kpi label="Pages per month" value={fmtN(perMo(cur.total, cur), 1)} was={was(x => fmtN(perMo(x.total, x), 1))} note={`${fmtPct(cur.buckets.business / Math.max(1, cur.total))} in business hours`} />
        <Kpi label="Sleep interruptions per month" value={fmtN(perMo(cur.buckets.sleep, cur), 1)} was={was(x => fmtN(perMo(x.buckets.sleep, x), 1))} note={`Between ${String(cfg.sleepStart).padStart(2, '0')}:00 and ${String(cfg.sleepEnd).padStart(2, '0')}:00 local`} />
        <Kpi label="Load fairness (Gini)" value={cur.giniPages.toFixed(2)} was={was(x => x.giniPages.toFixed(2))} note={`${giniWord(cur.giniPages)}; 0 is perfectly even`} />
        <Kpi label="Time to acknowledge" value={`${fmtMin(cur.ackP50)} / ${fmtMin(cur.ackP90)}`} note="Median / 90th percentile" />
      </div>
      {top && top.share > top.fairShare * 1.5 && top.pages > 5 && (
        <div className="banner warn"><span><strong>{top.name}</strong> carries {fmtPct(top.share)} of the rotation&rsquo;s pages against a fair share of {fmtPct(top.fairShare)}, with {top.buckets.sleep} sleep interruptions and a longest run of {top.maxNights} bad night{top.maxNights === 1 ? '' : 's'}.</span><Link href={location.pathname.replace(/\/[a-z]+$/, '') + '/noise' + location.search} className="btn sm primary">See what to fix</Link></div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>People</h2><BucketLegend /></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Person</th><th>Risk</th><th className="num">Pages</th><th style={{ minWidth: 140 }}>When</th><th className="num">Sleep</th><th className="num">Nights in a row</th><th className="num">Days off hit</th><th style={{ minWidth: 150 }}>Share vs fair share</th><th className="num">Ack p50</th></tr></thead>
            <tbody>
              {cur.people.map(x => (
                <tr key={x.name}>
                  <th scope="row"><div className="person-cell">{x.name}{x.excluded && <span className="badge">not in rotation</span>}</div></th>
                  <td><div className="row gap-sm"><ScoreRing score={x.score} band={x.band} /><span className={`badge ${x.band}`}>{x.band}</span></div></td>
                  <td className="num">{x.pages}</td>
                  <td><BucketBar buckets={x.buckets} /></td>
                  <td className="num">{x.buckets.sleep}</td>
                  <td className="num">{x.maxNights}</td>
                  <td className="num">{x.weekendDays}</td>
                  <td>{x.excluded ? <span className="muted small">excluded</span> : <div className="row gap-sm"><div className="grow"><ShareBar share={x.share} fair={x.fairShare} max={maxShare} /></div><span className="small tab-nums">{fmtPct(x.share)}</span></div>}</td>
                  <td className="num">{fmtMin(x.ackP50)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ margin: '10px 0 0' }}>Risk is the documented burnout-risk score (0 to 100): sleep interruptions, consecutive bad nights, interrupted days off and evenings. <Link href="/docs#score">How it is calculated</Link>. The black tick is the fair share for a rotation of {rota.length}.</p>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>When each person gets paged</h2><HeatLegend /></div>
        <div className="heat-grid">
          {cur.people.filter(x => x.pages > 0 || !x.excluded).map(x => {
            const b = base.people.find(y => y.name === x.name)
            return (
              <div className="heat-person" key={x.name}>
                <div className="heat-person-head"><b>{x.name}</b><span className="muted small">{cfg.people[x.name]?.tz ?? cfg.defaultTz} · {x.pages} pages</span></div>
                <Heatmap heat={x.heat} before={a.fixed ? b?.heat : undefined} max={max} sleepStart={cfg.sleepStart} sleepEnd={cfg.sleepEnd} label={x.name} />
              </div>
            )
          })}
        </div>
      </div>
      <div className="grid-2">
        <div className="panel"><h2>Time to acknowledge</h2><Hist counts={histogram(cur.ackMins, ACK_EDGES)} labels={ACK_LABELS} /><p className="muted small">{fmtN(cur.neverAcked)} pages ({fmtPct(cur.neverAcked / Math.max(1, cur.total))}) were never acknowledged.</p></div>
        <div className="panel"><h2>Time to resolve</h2><Hist counts={histogram(cur.resMins, RES_EDGES)} labels={RES_LABELS} color="var(--b-weekend)" /><p className="muted small">Median {fmtMin(cur.ttrP50)}, 90th percentile {fmtMin(cur.ttrP90)}. {fmtN(cur.autoResolved)} resolved on their own.</p></div>
      </div>
    </>
  )
}

// ---------- Noise ----------

function fixesCsv(fixes: Fix[]) {
  return toCsv([['rank', 'alert', 'service', 'suggested_change', 'pages_per_month_removed', 'sleep_pages_per_month_removed', 'evidence', 'how'], ...fixes.map((f, i) => [i + 1, f.title, f.service, `${FIX_LABEL[f.kind]}: ${f.change}`, Math.round(f.perMonth * 10) / 10, Math.round(f.sleepPerMonth * 10) / 10, f.evidence, f.how])])
}

function Noise(p: TabProps) {
  const { a, cfg, setConfig } = p
  const [all, setAll] = useState(false)
  const toggle = (id: string) => setConfig({ applied: cfg.applied.includes(id) ? cfg.applied.filter(x => x !== id) : [...cfg.applied, id] })
  const removable = new Set(a.fixes.flatMap(f => f.removed)).size
  const allFixed = useMemo(() => analyze(applyFixes(a.incidents, a.fixes, a.fixes.map(f => f.id)), cfg, a.span), [a, cfg])
  const shown = all ? a.fixes : a.fixes.slice(0, 12)
  return (
    <>
      <AppliedBanner {...p} />
      <div className="kpis">
        <Kpi label="Removable pages per month" value={fmtN(perMo(removable, a.base), 1)} note={`${fmtPct(removable / Math.max(1, a.base.total))} of all pages`} />
        <Kpi label="Of those, at night" value={fmtN(perMo(a.base.buckets.sleep - allFixed.buckets.sleep, a.base), 1)} note="Sleep interruptions the full list removes" />
        <Kpi label="Auto-resolved blips" value={fmtN(a.base.autoResolved)} note="Resolved before anyone acted" />
        <Kpi label="Non-actionable" value={fmtN(a.base.nonActionable)} note="Marked by tag or field in the export" />
      </div>
      <div className="panel tint">
        <div className="panel-head"><h2>Detection thresholds</h2><span className="muted small">Change these and the list re-ranks</span></div>
        <div className="inline-fields">
          <label className="field"><span>Auto-resolved under (min)</span><input type="number" min="1" max="60" value={cfg.autoResolveMin} onChange={e => setConfig({ autoResolveMin: Math.max(1, Number(e.target.value) || 1) })} /></label>
          <label className="field"><span>Flapping window (min)</span><input type="number" min="5" max="1440" value={cfg.flapWindowMin} onChange={e => setConfig({ flapWindowMin: Math.max(5, Number(e.target.value) || 5) })} /></label>
          <label className="field"><span>Flapping after N firings</span><input type="number" min="2" max="20" value={cfg.flapMinFirings} onChange={e => setConfig({ flapMinFirings: Math.max(2, Number(e.target.value) || 2) })} /></label>
        </div>
      </div>
      <div className="panel-head">
        <h2>Tune these alerts first</h2>
        <div className="row gap-sm wrap">
          {cfg.applied.length > 0 && <button type="button" className="btn sm ghost" onClick={() => setConfig({ applied: [] })}>Clear what-ifs</button>}
          <CopyButton text={a.fixes.map((f, i) => `${i + 1}. ${f.title} (${f.service}): ${FIX_LABEL[f.kind]}. ${f.change} Removes ~${fmtN(f.perMonth, 1)} pages/month.`).join('\n')} label="Copy as list" />
          <button type="button" className="btn sm outline" onClick={() => download('alert-fixes.csv', fixesCsv(a.fixes))}>Download CSV</button>
        </div>
      </div>
      {a.fixes.length === 0 ? <div className="panel"><Empty title="No noisy alerts found"><p className="muted">Nothing flapped, duplicated or resolved itself under the current thresholds. That is a good sign.</p></Empty></div> : (
        <div className="fix-list">
          {shown.map((f, i) => {
            const on = cfg.applied.includes(f.id)
            return (
              <article key={f.id} className={`fix-card${on ? ' on' : ''}`}>
                <div className="fix-rank">{i + 1}</div>
                <div>
                  <div className="row gap-sm wrap" style={{ marginBottom: 6 }}><span className="kind">{FIX_LABEL[f.kind]}</span><span className="muted small">{f.service} · {f.fires} pages</span></div>
                  <h3>{f.title}</h3>
                  <p>{f.evidence}</p>
                  <p><strong>Change:</strong> {f.change}</p>
                  <p className="how">{f.how}</p>
                </div>
                <div className="fix-impact">
                  <b>−{fmtN(f.perMonth, 1)}</b><small>pages / month</small><small>{fmtN(f.sleepPerMonth, 1)} at night</small>
                  <label className="row gap-sm end" style={{ marginTop: 10, cursor: 'pointer' }}><span className="small">What-if</span><span className="switch"><input type="checkbox" checked={on} onChange={() => toggle(f.id)} aria-label={`Apply ${FIX_LABEL[f.kind]} to ${f.title} as a what-if`} /><span /></span></label>
                </div>
              </article>
            )
          })}
          {a.fixes.length > 12 && <button type="button" className="btn ghost" onClick={() => setAll(!all)}>{all ? 'Show top 12' : `Show all ${a.fixes.length}`}</button>}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 14 }}>A fix&rsquo;s count is what it removes alone. Fixes on the same alert overlap; the totals above count each page once.</p>
    </>
  )
}

// ---------- Rotation ----------

const MODES: [RotaMode, string][] = [['single', 'Single rotation'], ['primary-secondary', 'Primary + secondary'], ['follow-the-sun', 'Follow the sun']]
const TZS = ['America/Los_Angeles', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney']

function Rotation(p: TabProps) {
  const { a, cfg, project, update } = p
  const list = a.fixed ? a.after : a.incidents
  const r: RotaInput = project.rota ?? defaultRota(cfg, list)
  const set = (patch: Partial<RotaInput>) => void update({ rota: { ...r, ...patch } })
  const res = useMemo(() => simulateRota(list, cfg, r, a.span), [list, cfg, r, a.span])
  const cur = (a.fixed ?? a.base).people.filter(x => !x.excluded)
  const worst = cur[0]
  const worstSim = [...res.people].sort((x, y) => y.sleepPerMonth - x.sleepPerMonth)[0]
  const tzOpts = [...new Set([...TZS, cfg.defaultTz, ...r.regions])]
  const m = (a.fixed ?? a.base).months
  return (
    <>
      <AppliedBanner {...p} />
      <div className="grid-2">
        <div className="panel tint">
          <h2>Proposed rotation</h2>
          <div className="seg-control" role="radiogroup" aria-label="Rotation type" style={{ marginBottom: 14 }}>
            {MODES.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={r.mode === k} className={r.mode === k ? 'on' : ''} onClick={() => set({ mode: k })}>{l}</button>)}
          </div>
          <div className="inline-fields">
            <label className="field"><span>Team size</span><input type="number" min="1" max="40" value={r.size} onChange={e => set({ size: Math.max(1, Math.min(40, Number(e.target.value) || 1)) })} /></label>
            <label className="field"><span>Shift length (days)</span><select value={r.shiftDays} onChange={e => set({ shiftDays: Number(e.target.value) })}>{[1, 3.5, 7, 14].map(d => <option key={d} value={d}>{d === 3.5 ? 'Half week' : d === 1 ? 'Daily' : d === 7 ? 'Weekly' : 'Two weeks'}</option>)}</select></label>
            {r.mode !== 'follow-the-sun' && <label className="field"><span>Team timezone</span><select value={r.tz} onChange={e => set({ tz: e.target.value })}>{tzOpts.map(t => <option key={t}>{t}</option>)}</select></label>}
            {r.mode === 'primary-secondary' && <label className="field"><span>Escalate to secondary (%)</span><input type="number" min="0" max="100" value={Math.round(r.escalationRate * 100)} onChange={e => set({ escalationRate: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })} /></label>}
          </div>
          {r.mode === 'follow-the-sun' && (
            <div className="inline-fields">
              {[0, 1, 2].map(i => (
                <label key={i} className="field"><span>Region {i + 1}{i === 2 ? ' (optional)' : ''}</span>
                  <select value={r.regions[i] ?? ''} onChange={e => { const regions = [...r.regions]; regions[i] = e.target.value; set({ regions: regions.filter(Boolean) }) }}>
                    {i === 2 && <option value="">None</option>}
                    {tzOpts.map(t => <option key={t}>{t}</option>)}
                  </select>
                </label>
              ))}
            </div>
          )}
          <p className="muted small" style={{ margin: 0 }}>Uses this period&rsquo;s real page arrival times{a.fixed ? ', after the applied what-if fixes' : ''}. {res.note}</p>
        </div>
        <div className="panel">
          <h2>Projected load per person</h2>
          <div className="kpis" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 12 }}>
            <Kpi label="Worst sleep pages / month, today" value={worst ? fmtN(worst.buckets.sleep / m, 1) : '—'} note={worst?.name} />
            <Kpi label="Worst sleep pages / month, proposed" value={worstSim ? fmtN(worstSim.sleepPerMonth, 1) : '—'} note={worstSim?.label} />
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Seat</th><th className="num">Pages / mo</th><th className="num">Sleep / mo</th><th className="num">Weekend days / mo</th><th className="num">Shifts / mo</th></tr></thead>
              <tbody>{res.people.map(x => <tr key={x.label}><th scope="row">{x.label}</th><td className="num">{fmtN(x.pagesPerMonth, 1)}</td><td className="num">{fmtN(x.sleepPerMonth, 1)}</td><td className="num">{fmtN(x.weekendDaysPerMonth, 1)}</td><td className="num">{fmtN(x.shiftsPerMonth, 1)}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="panel">
        <h2>Today, for comparison</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Person</th><th className="num">Pages / mo</th><th className="num">Sleep / mo</th><th className="num">Days off hit / mo</th><th style={{ minWidth: 160 }}>Today vs proposed sleep</th></tr></thead>
            <tbody>{cur.map(x => {
              const avg = res.people.reduce((s, y) => s + y.sleepPerMonth, 0) / Math.max(1, res.people.length)
              const now = x.buckets.sleep / m
              return <tr key={x.name}><th scope="row">{x.name}</th><td className="num">{fmtN(x.pages / m, 1)}</td><td className="num">{fmtN(now, 1)}</td><td className="num">{fmtN(x.weekendDays / m, 1)}</td><td className={now > avg ? 'diff-down' : 'muted'}>{signed(avg - now, v => fmtN(v, 1))} / mo</td></tr>
            })}</tbody>
          </table>
        </div>
        <p className="muted small" style={{ margin: '10px 0 0' }}>Projection assumes pages keep arriving when they did this period and that load is shared evenly within each region. Swaps and overrides are what make real rotations unfair; compare with the Overview.</p>
      </div>
    </>
  )
}

// ---------- Pay ----------

function Pay(p: TabProps) {
  const { a, cfg, setConfig, project, update } = p
  const pol = cfg.policy
  const setPol = (patch: Partial<CompPolicy>) => setConfig({ policy: { ...pol, ...patch } })
  const rows = useMemo(() => compensation(a.fixed ? a.after : a.incidents, cfg, pol, project.weeks ?? {}), [a, cfg, pol, project.weeks])
  const total = rows.reduce((s, r) => s + r.total, 0)
  const toil = rows.reduce((s, r) => s + r.toilHours, 0)
  const num = (k: keyof CompPolicy, label: string, step = 1) => (
    <label className="field"><span>{label}</span><input type="number" min="0" step={step} value={pol[k] as number} onChange={e => setPol({ [k]: Math.max(0, Number(e.target.value) || 0) } as Partial<CompPolicy>)} /></label>
  )
  const csv = () => toCsv([['person', 'on_call_weeks', 'off_hours_pages', 'sleep_pages', 'days_off_interrupted', 'stipend', 'page_pay', 'total', 'currency', 'toil_hours'], ...rows.map(r => [r.name, r.weeks, r.offHours, r.sleep, r.weekendDays, r.stipend, r.pagePay, r.total, pol.currency, r.toilHours])])
  return (
    <>
      <AppliedBanner {...p} />
      <div className="grid-2">
        <div className="panel tint">
          <h2>Policy</h2>
          <div className="inline-fields">
            <label className="field"><span>Currency</span><select value={pol.currency} onChange={e => setPol({ currency: e.target.value })}>{['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'SGD', 'JPY'].map(c => <option key={c}>{c}</option>)}</select></label>
            {num('stipendPerWeek', 'Stipend per on-call week', 10)}
            {num('perOffHoursPage', 'Per evening / weekend page', 5)}
            {num('perSleepPage', 'Per sleep-hours page', 5)}
            {num('toilPerSleepPage', 'Time off per sleep page (h)', 0.5)}
            {num('toilPerWeekendDay', 'Time off per day off hit (h)', 0.5)}
            {num('groupMinutes', 'Pages within N min count once', 5)}
          </div>
          <p className="muted small" style={{ margin: 0 }}>On-call weeks default to the weeks each person was paged at least once. Override them in the table when the schedule says otherwise.</p>
        </div>
        <div className="panel">
          <h2>Totals for {fmtPeriod(p.period)}</h2>
          <div className="kpis" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 0 }}>
            <Kpi label="Total payout" value={fmtMoney(total, pol.currency)} note={`${rows.length} people`} />
            <Kpi label="Time off in lieu" value={`${fmtN(toil)} h`} note={`${fmtN(toil / 8, 1)} working days`} />
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Per person</h2><button type="button" className="btn sm outline" onClick={() => download(`oncall-pay-${p.period}.csv`, csv())}>Download CSV</button></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Person</th><th className="num">On-call weeks</th><th className="num">Off-hours pages</th><th className="num">Sleep pages</th><th className="num">Stipend</th><th className="num">Page pay</th><th className="num">Total</th><th className="num">Time off (h)</th></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.name}>
                <th scope="row">{r.name}</th>
                <td className="num"><input className="table-input num" style={{ width: 70 }} type="number" min="0" value={r.weeks} aria-label={`On-call weeks for ${r.name}`} onChange={e => void update({ weeks: { ...(project.weeks ?? {}), [r.name]: Math.max(0, Number(e.target.value) || 0) } })} /></td>
                <td className="num">{r.offHours}</td><td className="num">{r.sleep}</td>
                <td className="num">{fmtMoney(r.stipend, pol.currency)}</td><td className="num">{fmtMoney(r.pagePay, pol.currency)}</td>
                <td className="num strong">{fmtMoney(r.total, pol.currency)}</td><td className="num">{fmtN(r.toilHours, 1)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {project.weeks && Object.keys(project.weeks).length > 0 && <button type="button" className="linkish small" style={{ marginTop: 10 }} onClick={() => void update({ weeks: {} })}>Reset week overrides</button>}
      </div>
    </>
  )
}

// ---------- History ----------

function History(p: TabProps) {
  const { project, update } = p
  const snaps = project.snapshots
  const [aId, setA] = useState(snaps.at(-2)?.id ?? '')
  const [bId, setB] = useState(snaps.at(-1)?.id ?? '')
  const A = snaps.find(s => s.id === aId) ?? snaps.at(-2)
  const B = snaps.find(s => s.id === bId) ?? snaps.at(-1)
  const remove = (s: Snapshot) => {
    void update({ snapshots: snaps.filter(x => x.id !== s.id) })
    void deleteSnapshotCloud(s.id)
    toast(`Deleted the ${s.label} snapshot`, { undo: () => void update({ snapshots: [...snaps] }) })
  }
  if (!snaps.length) return <div className="panel"><Empty title="No snapshots yet"><p className="muted">Pick a quarter or month at the top and press <kbd>S</kbd> (or Save snapshot). Snapshot again after tuning, then compare here to see whether it helped.</p></Empty></div>
  const rows: [string, (s: Snapshot) => number, (n: number) => string, boolean][] = [
    ['Pages per month', s => s.pagesPerMonth, n => fmtN(n, 1), true],
    ['Sleep interruptions', s => s.buckets.sleep / (s.days / 30.44), n => fmtN(n, 1), true],
    ['Weekend pages', s => s.buckets.weekend / (s.days / 30.44), n => fmtN(n, 1), true],
    ['Noise (removable) per month', s => s.noisePerMonth, n => fmtN(n, 1), true],
    ['Load fairness (Gini)', s => s.giniPages, n => n.toFixed(2), true],
    ['Median time to ack', s => s.ackP50, fmtMin, true],
    ['Median time to resolve', s => s.ttrP50, fmtMin, true],
  ]
  const people = [...new Set([...(A?.people ?? []), ...(B?.people ?? [])].map(x => x.name))]
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Compare</h2>
          <div className="row gap-sm wrap">
            <select value={A?.id} onChange={e => setA(e.target.value)} aria-label="Before">{snaps.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
            <span className="muted">to</span>
            <select value={B?.id} onChange={e => setB(e.target.value)} aria-label="After">{snaps.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
          </div>
        </div>
        {A && B && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Metric</th><th className="num">{A.label}</th><th className="num">{B.label}</th><th className="num">Change</th></tr></thead>
              <tbody>{rows.map(([l, f, fmt, lowerBetter]) => {
                const x = f(A), y = f(B), d = y - x
                const good = Number.isFinite(d) && d !== 0 && (d < 0) === lowerBetter
                return <tr key={l}><th scope="row">{l}</th><td className="num">{fmt(x)}</td><td className="num">{fmt(y)}</td><td className={`num ${d === 0 || !Number.isFinite(d) ? 'muted' : good ? 'diff-down' : 'diff-up'}`}>{Number.isFinite(d) ? signed(d, fmt) : '—'}{x > 0 && Number.isFinite(d) && d !== 0 ? ` (${signed(d / x, v => fmtPct(v))})` : ''}</td></tr>
              })}</tbody>
            </table>
          </div>
        )}
      </div>
      {A && B && (
        <div className="panel">
          <h2>Per person</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Person</th><th className="num">Pages</th><th className="num">Sleep</th><th className="num">Risk score</th></tr></thead>
              <tbody>{people.map(n => {
                const x = A.people.find(q => q.name === n), y = B.people.find(q => q.name === n)
                const cell = (f: (q: Snapshot['people'][number]) => number) => {
                  const a0 = x ? f(x) : 0, b0 = y ? f(y) : 0, d = b0 - a0
                  return <td className="num">{a0} &rarr; {b0} <span className={d < 0 ? 'diff-down' : d > 0 ? 'diff-up' : 'muted'}>({signed(d, v => String(v))})</span></td>
                }
                return <tr key={n}><th scope="row">{n}</th>{cell(q => q.pages)}{cell(q => q.sleep)}{cell(q => q.score)}</tr>
              })}</tbody>
            </table>
          </div>
          <p className="muted small" style={{ margin: '10px 0 0' }}>Raw counts for each snapshot&rsquo;s period. A quarter has about three times the pages of a month; compare like with like, or use the per-month rows above.</p>
        </div>
      )}
      <div className="panel">
        <h2>Snapshots</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Label</th><th>Period</th><th className="num">Pages</th><th className="num">Sleep</th><th>Saved</th><th /></tr></thead>
            <tbody>{[...snaps].reverse().map(s => (
              <tr key={s.id}><th scope="row">{s.label}</th><td>{fmtPeriod(s.period)}</td><td className="num">{s.pages}</td><td className="num">{s.buckets.sleep}</td><td className="small muted">{new Date(s.at).toLocaleDateString()}</td><td className="num"><button type="button" className="btn sm danger-ghost" onClick={() => remove(s)}>Delete</button></td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </>
  )
}
