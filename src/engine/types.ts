/** One page: an incident or alert that notified a human. All times are UTC epoch ms. */
export interface Incident {
  id: string
  title: string
  service: string
  /** The person who was paged (acknowledger if known, else the assignee). */
  person: string
  urgency: 'high' | 'low'
  created: number
  acked?: number
  resolved?: number
  /** Resolved by the monitoring tool, not by a human. */
  autoResolved?: boolean
  /** False when the source says nobody needed to do anything (tag, field or resolution note). */
  actionable?: boolean
  /** Dedupe key / alias from the source, if any. */
  key?: string
}

export interface PersonCfg {
  tz: string
  /** Local working hours, e.g. 9 and 17.5 */
  workStart: number
  workEnd: number
  /** 0 = Sunday ... 6 = Saturday */
  workDays: number[]
  /** Excluded from fairness (managers, people who left). */
  excluded?: boolean
}

export interface CompPolicy {
  currency: string
  stipendPerWeek: number
  perOffHoursPage: number
  perSleepPage: number
  /** Time off in lieu, hours */
  toilPerSleepPage: number
  toilPerWeekendDay: number
  /** Pages handled within this many minutes of the previous one count once. */
  groupMinutes: number
}

export interface Config {
  people: Record<string, PersonCfg>
  defaultTz: string
  sleepStart: number
  sleepEnd: number
  /** Noise thresholds */
  autoResolveMin: number
  flapWindowMin: number
  flapMinFirings: number
  /** Fix ids the user has marked as applied ("what if") */
  applied: string[]
  policy: CompPolicy
}

export type Bucket = 'business' | 'evening' | 'sleep' | 'weekend'
export const BUCKETS: Bucket[] = ['business', 'evening', 'weekend', 'sleep']
