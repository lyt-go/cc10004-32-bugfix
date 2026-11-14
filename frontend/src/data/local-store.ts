import { ALARM_SEED, CLOSURE_SEED } from './alarm-seed'
import { SEED_ROWS } from './seed'
import type { AlarmRow, ClosureRecord, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 规则、告警、关闭核查保存在同一份快照里，一次 setItem 落盘，
// 保证「关闭规则 + 告警转历史」整体成功或整体不变。
const STORAGE_KEY = 'data-product-ops:entries'
const SCHEMA_VERSION = 2

export type PersistedState = {
  schemaVersion: number
  /** 每次落盘自增；写入前比对，识别并发改版。 */
  revision: number
  entries: Record<string, EntryRow[]>
  alarms: AlarmRow[]
  closures: ClosureRecord[]
}

export type TransactionOutcome<T> = {
  /** 只有校验通过、改动完整时才写盘；返回 false 时草稿会被丢弃。 */
  commit: boolean
  value: T
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedState(): PersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    entries: clone(SEED_ROWS),
    alarms: clone(ALARM_SEED),
    closures: clone(CLOSURE_SEED),
  }
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

// 没有 localStorage 时（Node 下跑校验脚本）用内存快照，行为保持一致。
let memoryState: PersistedState | null = null

function isState(value: unknown): value is PersistedState {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<PersistedState>
  return Boolean(candidate.entries) && Array.isArray(candidate.alarms) && Array.isArray(candidate.closures)
}

function migrateLegacy(parsed: unknown): PersistedState {
  // 旧版只存了模块行、没有告警模型，审计规则可能停在「已关闭」却还挂着未结告警。
  // 这里把审计/预警相关数据换回新版示例，其他模块的改动保留。
  const raw = parsed as { entries?: Record<string, EntryRow[]> } | Record<string, EntryRow[]> | null
  const legacyEntries = (raw && typeof raw === 'object' && 'entries' in raw ? raw.entries : raw) as
    | Record<string, EntryRow[]>
    | undefined
  const migrated = seedState()
  if (legacyEntries && typeof legacyEntries === 'object') {
    migrated.entries = { ...migrated.entries, ...legacyEntries }
    migrated.entries.auditcheck = clone(SEED_ROWS.auditcheck)
    migrated.entries.opsalert = clone(SEED_ROWS.opsalert)
  }
  return migrated
}

/** 每次都重新读最新快照：多标签页并发时以磁盘上的最新数据为准。 */
function readStorage(): PersistedState {
  if (!hasStorage()) {
    memoryState ??= seedState()
    return clone(memoryState)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return seedState()
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (isState(parsed) && parsed.schemaVersion === SCHEMA_VERSION) {
      return { ...parsed, revision: Number(parsed.revision) || 0 }
    }
    return migrateLegacy(parsed)
  } catch {
    return seedState()
  }
}

function persistState(state: PersistedState): void {
  if (hasStorage()) {
    // 单键一次写入：规则状态、告警归档、关闭记录同时落盘。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } else {
    memoryState = clone(state)
  }
}

/**
 * 事务：在最新快照的副本上完成校验与全部改动，成功后一次性落盘。
 * 校验失败时返回 commit:false，不写任何数据。
 * 落盘前比对 revision：另一个标签页刚刚改过数据时丢弃本次草稿、基于最新快照重算，
 * 因此重复关闭 / 并发改版最终只有一方生效，不会把过期快照写回去制造孤儿告警。
 */
export function runTransaction<T>(mutator: (draft: PersistedState) => TransactionOutcome<T>): T {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const base = readStorage()
    const draft = clone(base)
    const outcome = mutator(draft)
    if (!outcome.commit) {
      return outcome.value
    }
    // 读-算-写都在同一个同步调用里；revision 变化说明有别的标签页先落盘了。
    if (readStorage().revision !== base.revision) {
      continue
    }
    persistState({ ...draft, revision: base.revision + 1 })
    return outcome.value
  }
  throw new Error('数据被其他页面同时修改，请刷新后重试')
}

export function allRows(): Record<string, EntryRow[]> {
  return readStorage().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  runTransaction((draft) => {
    draft.entries[key] = rows
    return { commit: true, value: undefined }
  })
}

export function listAlarms(): AlarmRow[] {
  return readStorage().alarms
}

export function listClosures(): ClosureRecord[] {
  return readStorage().closures
}

export function resetRows(key: string): EntryRow[] {
  return runTransaction((draft) => {
    draft.entries[key] = clone(SEED_ROWS[key] ?? [])
    if (key === 'auditcheck' || key === 'opsalert') {
      draft.alarms = clone(ALARM_SEED)
      draft.closures = clone(CLOSURE_SEED)
    }
    return { commit: true, value: draft.entries[key] }
  })
}

export function storageKey(): string {
  return STORAGE_KEY
}
