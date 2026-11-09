import type { Incident } from './types.ts'

export function parseCsv(text: string): { rows: string[][]; lines: number[] } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const delim = sniffDelimiter(text)
  const rows: string[][] = []
  const lines: number[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else {
        if (c === '\n') line++
        field += c
      }
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
      row = []
      line++
      rowLine = line
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
  }
  return { rows, lines }
}

function sniffDelimiter(text: string): string {
  const head = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const counts = [',', '\t', ';', '|'].map(d => [d, head.split(d).length] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

/** Parses ISO 8601 (with or without offset), epoch seconds/ms, YYYY/MM/DD and US M/D/YYYY. No offset means UTC. Returns ms or NaN. */
export function parseTime(raw: string): number {
  const s = raw.trim()
  if (!s) return NaN
  if (/^\d{10}(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  if (/^\d{13}$/.test(s)) return Number(s)
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i)
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', se = '0', frac = '0', tz] = m
    let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, Math.round(Number('0.' + frac) * 1000))
    if (tz && !/^(z|utc)$/i.test(tz)) {
      const sign = tz[0] === '-' ? -1 : 1
      const digits = tz.slice(1).replace(':', '')
      t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000
    }
    return t
  }
  // US style from spreadsheets: 10/1/2026 7:00(:00)( AM)
  const u = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i)
  if (u) {
    let h = Number(u[4] ?? 0)
    if (u[7]) h = (h % 12) + (/pm/i.test(u[7]) ? 12 : 0)
    return Date.UTC(+u[3], +u[1] - 1, +u[2], h, Number(u[5] ?? 0), Number(u[6] ?? 0))
  }
  return NaN
}


export function parseNum(raw: string): number {
  const s = raw.trim().replace(/[,\s$]/g, '')
  if (s === '' || /^null$/i.test(s)) return NaN
  return Number(s)
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map(r => r.map(v => {
    const s = typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : v
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n') + '\n'
}


// ---------- Formats ----------

export type Format = 'pagerduty-csv' | 'pagerduty-json' | 'pagerduty-log' | 'opsgenie-csv' | 'rootly-csv' | 'rootly-json' | 'generic-csv'

export const FORMATS: Record<Format, string> = {
  'pagerduty-csv': 'PagerDuty incidents CSV',
  'pagerduty-json': 'PagerDuty REST API /incidents',
  'pagerduty-log': 'PagerDuty REST API /log_entries',
  'opsgenie-csv': 'Opsgenie alerts CSV',
  'rootly-csv': 'Rootly incidents CSV',
  'rootly-json': 'Rootly API (JSON:API)',
  'generic-csv': 'Generic CSV',
}

type FieldType = 'time' | 'str' | 'num' | 'bool' | 'dur'
export interface FieldSpec { key: string; label: string; required?: boolean; type: FieldType; aliases: string[] }

/** Canonical fields. Aliases are normalized column names (lowercase, spaces to underscores) as the vendors export them. */
export const FIELDS: FieldSpec[] = [
  { key: 'created', label: 'Created / triggered at', required: true, type: 'time', aliases: ['created_at', 'created_on', 'createdat', 'started_at', 'triggered_at', 'start_time', 'timestamp', 'time', 'date'] },
  { key: 'title', label: 'Title', required: true, type: 'str', aliases: ['title', 'description', 'message', 'summary', 'alert', 'alert_name', 'name', 'incident_title'] },
  { key: 'service', label: 'Service', type: 'str', aliases: ['service_name', 'service', 'services', 'source', 'teams', 'team_name', 'entity'] },
  { key: 'person', label: 'Paged person', type: 'str', aliases: ['acknowledged_by', 'acknowledgedby', 'acknowledged_by_user_names', 'assigned_to', 'assigned_to_user_names', 'assignee', 'owner', 'responder', 'responders', 'person', 'user', 'on_call', 'oncall', 'commander', 'incident_commander', 'creator'] },
  { key: 'urgency', label: 'Urgency / severity / priority', type: 'str', aliases: ['urgency', 'priority', 'severity', 'sev'] },
  { key: 'acked', label: 'Acknowledged at', type: 'time', aliases: ['acknowledged_at', 'acked_at', 'ack_at', 'first_acknowledged_at'] },
  { key: 'resolved', label: 'Resolved / closed at', type: 'time', aliases: ['resolved_at', 'resolved_on', 'closed_at', 'ended_at', 'mitigated_at'] },
  { key: 'ackSecs', label: 'Seconds to first ack', type: 'dur', aliases: ['seconds_to_first_ack', 'time_to_ack', 'acktime', 'ack_time', 'tta'] },
  { key: 'resolveSecs', label: 'Seconds to resolve', type: 'dur', aliases: ['seconds_to_resolve', 'time_to_resolve', 'closetime', 'close_time', 'ttr'] },
  { key: 'autoResolved', label: 'Auto-resolved', type: 'bool', aliases: ['auto_resolved', 'autoresolved', 'resolved_by_integration'] },
  { key: 'closedBy', label: 'Resolved / closed by', type: 'str', aliases: ['closedby', 'closed_by', 'resolved_by'] },
  { key: 'actionable', label: 'Actionable', type: 'bool', aliases: ['actionable', 'is_actionable'] },
  { key: 'tags', label: 'Tags / labels', type: 'str', aliases: ['tags', 'labels', 'label'] },
  { key: 'key', label: 'Dedupe key / alias', type: 'str', aliases: ['alias', 'incident_key', 'dedup_key', 'dedupe_key', 'alert_key', 'fingerprint'] },
  { key: 'id', label: 'ID', type: 'str', aliases: ['id', 'incident_id', 'tinyid', 'incident_number', 'number', 'sequential_id', 'alert_id'] },
]

export const norm = (h: string) => h.trim().toLowerCase().replace(/^"|"$/g, '').replace(/[\s\-.]+/g, '_')

/** Header signatures, most specific first. */
export function detectCsvFormat(headers: string[]): Format {
  const h = new Set(headers.map(norm))
  if (h.has('tinyid') || (h.has('alias') && h.has('message') && h.has('createdat'))) return 'opsgenie-csv'
  if (h.has('seconds_to_first_ack') || h.has('created_on') || h.has('escalation_policy_name') || (h.has('incident_number') && h.has('service_name'))) return 'pagerduty-csv'
  if (h.has('sequential_id') || h.has('mitigated_at') || (h.has('started_at') && h.has('severity') && h.has('services'))) return 'rootly-csv'
  return 'generic-csv'
}

export type Mapping = Record<string, number>

/** Opsgenie's "Owner" is the alert owner; prefer AcknowledgedBy, which is matched first because aliases are ordered. */
export function autoMap(headers: string[]): Mapping {
  const hs = headers.map(norm)
  const map: Mapping = {}
  const used = new Set<number>()
  for (const f of FIELDS) {
    for (const a of f.aliases) {
      const i = hs.indexOf(a)
      if (i >= 0 && !used.has(i)) { map[f.key] = i; used.add(i); break }
    }
  }
  return map
}

export interface Issue { line: number; level: 'error' | 'warning'; message: string }
export interface Validated { incidents: Incident[]; issues: Issue[]; skipped: number; total: number }

const TRUE = /^(true|yes|y|1|t)$/i
const FALSE = /^(false|no|n|0|f)$/i
const NOISE_TAG = /\b(non[-_ ]?actionable|not[-_ ]?actionable|noise|noisy|false[-_ ]?positive)\b/i

export function toUrgency(raw: string): 'high' | 'low' {
  const s = raw.trim().toLowerCase()
  if (!s) return 'high'
  if (/^(low|p4|p5|sev[-_ ]?[34]|minor|info|warning|warn)$/.test(s)) return 'low'
  return 'high'
}

/** Durations: plain seconds, or Opsgenie's milliseconds (values over 10 million are treated as ms). */
function durationMs(raw: string, field: string): number {
  const n = parseNum(raw)
  if (Number.isNaN(n)) return NaN
  if (field === 'ms' || n > 1e7) return n
  return n * 1000
}

const looksHuman = (s: string) => !!s && !/(api|system|integration|automation|auto[-_ ]?resolve|monitor|policy|rule|engine)/i.test(s)

/** Typed incidents from parsed records plus a line-numbered report. Rows with fatal problems are skipped. */
export function validate(csv: { rows: string[][]; lines: number[] }, map: Mapping, format: Format = 'generic-csv'): Validated {
  const issues: Issue[] = []
  for (const f of FIELDS) if (f.required && !(f.key in map)) issues.push({ line: 1, level: 'error', message: `Required column "${f.label}" is not mapped` })
  const total = Math.max(0, csv.rows.length - 1)
  if (issues.length) return { incidents: [], issues, skipped: total, total }
  if (!('person' in map)) issues.push({ line: 1, level: 'warning', message: 'No person column mapped; every page is assigned to "Unassigned". Map acknowledged-by or assignee to see per-person load.' })
  const out: Incident[] = []
  const seen = new Set<string>()
  let skipped = 0
  const get = (rec: string[], k: string) => map[k] === undefined ? '' : (rec[map[k]] ?? '').trim()
  // When the mapped person column is empty (an unacked alert), fall back to the next person-like column (assignee, owner).
  const heads = (csv.rows[0] ?? []).map(norm)
  const personCols = FIELDS.find(f => f.key === 'person')!.aliases.map(a => heads.indexOf(a)).filter(i => i >= 0 && i !== map.person)
  const personFallback = (rec: string[]) => personCols.map(i => firstOf(rec[i] ?? '')).find(Boolean)
  for (let r = 1; r < csv.rows.length; r++) {
    const rec = csv.rows[r]
    const line = csv.lines[r]
    const created = parseTime(get(rec, 'created'))
    if (Number.isNaN(created)) { issues.push({ line, level: 'error', message: `Created time "${get(rec, 'created').slice(0, 40)}" is not a date/time` }); skipped++; continue }
    const title = get(rec, 'title')
    if (!title) { issues.push({ line, level: 'error', message: 'Title is empty' }); skipped++; continue }
    const id = get(rec, 'id') || `row-${line}`
    if (seen.has(id)) { issues.push({ line, level: 'warning', message: `Duplicate ID ${id} skipped` }); skipped++; continue }
    seen.add(id)
    const inc: Incident = { id, title, service: firstOf(get(rec, 'service')) || 'Unknown service', person: firstOf(get(rec, 'person')) || personFallback(rec) || 'Unassigned', urgency: toUrgency(get(rec, 'urgency')), created }
    let acked = parseTime(get(rec, 'acked'))
    if (Number.isNaN(acked) && get(rec, 'ackSecs')) { const d = durationMs(get(rec, 'ackSecs'), format === 'opsgenie-csv' ? 'ms' : 's'); if (!Number.isNaN(d) && d > 0) acked = created + d }
    let resolved = parseTime(get(rec, 'resolved'))
    if (Number.isNaN(resolved) && get(rec, 'resolveSecs')) { const d = durationMs(get(rec, 'resolveSecs'), format === 'opsgenie-csv' ? 'ms' : 's'); if (!Number.isNaN(d) && d >= 0) resolved = created + d }
    if (!Number.isNaN(acked)) { if (acked < created) issues.push({ line, level: 'warning', message: 'Acknowledged before it was created; ack time ignored' }); else inc.acked = acked }
    if (!Number.isNaN(resolved)) { if (resolved < created) issues.push({ line, level: 'warning', message: 'Resolved before it was created; resolve time ignored' }); else inc.resolved = resolved }
    const auto = get(rec, 'autoResolved')
    if (TRUE.test(auto)) inc.autoResolved = true
    else if (FALSE.test(auto)) inc.autoResolved = false
    else if (get(rec, 'closedBy')) inc.autoResolved = !looksHuman(get(rec, 'closedBy'))
    const act = get(rec, 'actionable')
    if (FALSE.test(act) || NOISE_TAG.test(get(rec, 'tags'))) inc.actionable = false
    else if (TRUE.test(act)) inc.actionable = true
    const key = get(rec, 'key')
    if (key) inc.key = key
    out.push(inc)
  }
  return { incidents: out, issues, skipped, total }
}

/** "Payments API, Ledger" or "[a, b]" lists keep the first entry. */
const firstOf = (s: string) => s.replace(/^\[|\]$/g, '').split(/[,;|]/)[0].replace(/^["']|["']$/g, '').trim()

// ---------- JSON (REST APIs) ----------

const str = (v: unknown): string => {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('data' in o) return str(o.data)
    if ('attributes' in o) return str(o.attributes)
    return str(o.summary ?? o.name ?? o.email ?? o.title ?? o.slug ?? o.id)
  }
  return ''
}

export interface JsonParsed { format: Format; csv: { rows: string[][]; lines: number[] }; logEntries?: LogEntry[] }
export interface LogEntry { type: string; at: number; incident: string; who: string; agentType: string }

/** Flattens PagerDuty /incidents, /log_entries and Rootly JSON:API responses into header + rows so the same mapping and validation apply. "Line" is the record number. */
export function parseJson(text: string): JsonParsed {
  const j = JSON.parse(text)
  const pages = Array.isArray(j) && j.length && typeof j[0] === 'object' && j[0] && ('incidents' in j[0] || 'log_entries' in j[0] || 'data' in j[0]) ? j : [j]
  const pick = (k: string) => pages.flatMap((p: Record<string, unknown>) => Array.isArray(p) ? p : (p[k] as unknown[]) ?? [])
  if (pages.some((p: Record<string, unknown>) => p && 'log_entries' in p)) {
    const entries = pick('log_entries') as Record<string, unknown>[]
    const logEntries = entries.map(e => ({
      type: String(e.type ?? '').replace(/_reference$/, ''),
      at: parseTime(String(e.created_at ?? '')),
      incident: str((e.incident as Record<string, unknown>)?.id),
      who: str(e.user ?? (e.agent && (e.agent as { type?: string }).type?.startsWith('user') ? e.agent : '')),
      agentType: String((e.agent as { type?: string })?.type ?? ''),
    })).filter(e => e.incident && !Number.isNaN(e.at))
    return { format: 'pagerduty-log', csv: { rows: [], lines: [] }, logEntries }
  }
  let records: Record<string, string>[]
  let format: Format
  if (pages.some((p: Record<string, unknown>) => p && 'incidents' in p) || (Array.isArray(j) && j[0]?.incident_number !== undefined)) {
    format = 'pagerduty-json'
    const list = (Array.isArray(j) && !('incidents' in (j[0] ?? {})) ? j : pick('incidents')) as Record<string, unknown>[]
    records = list.map(i => {
      const acks = (i.acknowledgements as { at?: string; acknowledger?: unknown }[] | undefined) ?? []
      const assigns = (i.assignments as { assignee?: unknown }[] | undefined) ?? []
      return {
        id: str(i.id), title: str(i.title ?? i.summary), service_name: str(i.service), urgency: str(i.urgency), created_at: str(i.created_at),
        resolved_at: str(i.resolved_at) || (i.status === 'resolved' ? str(i.last_status_change_at) : ''),
        acknowledged_at: str(acks[0]?.at), acknowledged_by: str(acks[0]?.acknowledger) || str(assigns[0]?.assignee),
        incident_key: str(i.incident_key),
      }
    })
  } else {
    format = 'rootly-json'
    const list = (Array.isArray(j) ? j : pick('data')) as Record<string, unknown>[]
    records = list.map(r => {
      const a = (r.attributes ?? r) as Record<string, unknown>
      const out: Record<string, string> = { id: str(r.id) }
      for (const [k, v] of Object.entries(a)) out[k] = str(v)
      if (!out.title && out.summary) out.title = out.summary
      return out
    })
  }
  const headers = [...new Set(records.flatMap(Object.keys))]
  return { format, csv: { rows: [headers, ...records.map(r => headers.map(h => r[h] ?? ''))], lines: [0, ...records.map((_, i) => i + 1)] } }
}

/** Enriches imported PagerDuty incidents with ack time, who was notified and whether an integration resolved it. */
export function applyLogEntries(incidents: Incident[], entries: LogEntry[]): { incidents: Incident[]; matched: number } {
  const by = new Map<string, LogEntry[]>()
  for (const e of entries) { const l = by.get(e.incident) ?? []; l.push(e); by.set(e.incident, l) }
  let matched = 0
  const out = incidents.map(i => {
    const es = by.get(i.id)
    if (!es) return i
    matched++
    es.sort((a, b) => a.at - b.at)
    const n = { ...i }
    const ack = es.find(e => e.type === 'acknowledge_log_entry')
    const notify = es.find(e => e.type === 'notify_log_entry' && e.who)
    const res = es.find(e => e.type === 'resolve_log_entry')
    if (ack) { n.acked = ack.at; if (ack.who) n.person = ack.who }
    else if (notify) n.person = notify.who
    if (res) { n.resolved = res.at; n.autoResolved = !res.agentType.startsWith('user') }
    return n
  })
  return { incidents: out, matched }
}

/** Merges by ID; incoming rows win. */
export function mergeIncidents(old: Incident[], incoming: Incident[]): Incident[] {
  const m = new Map(old.map(i => [i.id, i]))
  for (const i of incoming) m.set(i.id, i)
  return [...m.values()].sort((a, b) => a.created - b.created)
}

export function incidentsToCsv(list: Incident[]): string {
  const iso = (t?: number) => t === undefined ? '' : new Date(t).toISOString()
  return toCsv([['id', 'created_at', 'title', 'service', 'person', 'urgency', 'acknowledged_at', 'resolved_at', 'auto_resolved', 'actionable', 'dedup_key'],
    ...list.map(i => [i.id, iso(i.created), i.title, i.service, i.person, i.urgency, iso(i.acked), iso(i.resolved), i.autoResolved === undefined ? '' : String(i.autoResolved), i.actionable === undefined ? '' : String(i.actionable), i.key ?? ''])])
}
