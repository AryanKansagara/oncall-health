import type { CSSProperties } from 'react'
import { inSleep, type Band } from './engine/analyze.ts'
import { BUCKETS, type Bucket } from './engine/types.ts'
import { fmtN } from './ui.tsx'

export const BUCKET_LABEL: Record<Bucket, string> = { business: 'Business hours', evening: 'Evenings', weekend: 'Weekends', sleep: 'Sleep hours' }
export const bucketColor = (b: Bucket) => `var(--b-${b})`
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** 7 x 24 pager heatmap in the person's local time. Cells that `before` had and `heat` lacks get a "removed" ring. */
export function Heatmap({ heat, before, max, sleepStart, sleepEnd, label }: { heat: number[]; before?: number[]; max: number; sleepStart: number; sleepEnd: number; label: string }) {
  const m = Math.max(1, max)
  return (
    <div className="heat" role="img" aria-label={`${label}: ${fmtN(heat.reduce((a, b) => a + b, 0))} pages by weekday and local hour`}>
      <span />
      {Array.from({ length: 24 }, (_, h) => <span key={h} className="hh">{h % 6 === 0 ? String(h).padStart(2, '0') : ''}</span>)}
      {DAYS.map((d, di) => [
        <span key={d} className="hl">{d}</span>,
        ...Array.from({ length: 24 }, (_, h) => {
          const i = di * 24 + h
          const v = heat[i]
          const night = inSleep(h + 0.5, sleepStart, sleepEnd)
          const cut = before && before[i] > v
          const style = v ? { '--v': `${Math.round(22 + 78 * Math.sqrt(v / m))}%` } as CSSProperties : undefined
          return <span key={i} className={`c${night ? ' night' : ''}${v ? ' v' : ''}${cut ? ' cut' : ''}`} style={style} title={`${d} ${String(h).padStart(2, '0')}:00 · ${v} page${v === 1 ? '' : 's'}${cut ? ` (was ${before![i]})` : ''}`} />
        }),
      ])}
    </div>
  )
}

export const HeatLegend = () => (
  <div className="heat-legend" aria-hidden="true">
    <span><i style={{ background: 'var(--heat-night)', boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--b-sleep) 30%, transparent)' }} />Sleep hours</span>
    <span><i style={{ background: 'color-mix(in srgb, var(--heat) 40%, var(--heat-empty))' }} />Fewer</span>
    <span><i style={{ background: 'var(--heat)' }} />More pages</span>
    <span><i style={{ border: '1.5px solid var(--good)', borderRadius: '50%' }} />Removed by a fix</span>
  </div>
)

export function BucketBar({ buckets, total }: { buckets: Record<Bucket, number>; total?: number }) {
  const t = total ?? BUCKETS.reduce((a, b) => a + buckets[b], 0)
  return (
    <div className="bbar" role="img" aria-label={BUCKETS.map(b => `${BUCKET_LABEL[b]} ${buckets[b]}`).join(', ')}>
      {t > 0 && BUCKETS.map(b => <span key={b} style={{ width: `${buckets[b] / t * 100}%`, background: bucketColor(b) }} />)}
    </div>
  )
}

export const BucketLegend = () => <div className="legend">{BUCKETS.map(b => <span key={b}><i style={{ background: bucketColor(b) }} />{BUCKET_LABEL[b]}</span>)}</div>

export function ShareBar({ share, fair, max = 1 }: { share: number; fair: number; max?: number }) {
  return (
    <div className="share" role="img" aria-label={`${Math.round(share * 100)}% of pages, fair share ${Math.round(fair * 100)}%`}>
      <span className={share > fair * 1.25 ? 'over' : ''} style={{ width: `${Math.min(100, share / max * 100)}%` }} />
      {fair > 0 && <i style={{ left: `${Math.min(100, fair / max * 100)}%` }} title="Fair share" />}
    </div>
  )
}

export function Hist({ counts, labels, color }: { counts: number[]; labels: string[]; color?: string }) {
  const m = Math.max(1, ...counts)
  return (
    <div className="hist">
      {counts.map((c, i) => (
        <div className="bar" key={i}>
          <b>{c}</b>
          <span style={{ height: `${c / m * 100}%`, background: color }} />
          <small>{labels[i]}</small>
        </div>
      ))}
    </div>
  )
}

const RING: Record<Band, string> = { low: 'var(--good)', moderate: 'var(--accent)', high: 'var(--b-evening)', severe: 'var(--bad)' }
export const ScoreRing = ({ score, band }: { score: number; band: Band }) => (
  <div className="score-ring" style={{ '--s': score, '--ring': RING[band] } as CSSProperties} role="img" aria-label={`Burnout risk ${score} of 100, ${band}`}><span>{score}</span></div>
)
