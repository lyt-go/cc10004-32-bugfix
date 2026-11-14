import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listAlarms,
  listClosures,
  listRows,
  resetRows,
  runTransaction,
} from '@/data/local-store'
import type {
  ActionResult,
  AlarmRow,
  AuditRuleDetail,
  ClosureRecord,
  EntryRow,
  ExportFile,
  ModuleMeta,
  OverviewResult,
  PageResult,
  WarningRuleDetail,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function csvCell(value: string | number | boolean | undefined): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function buildCsv(rows: (string | number | boolean)[][]): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\n')}`
}

function ruleVersion(row: EntryRow): number {
  const value = Number(row['规则版本'])
  return Number.isFinite(value) && value > 0 ? value : 1
}

function ruleNo(row: EntryRow): string {
  return String(row['规则编号'] ?? row['预警编号'] ?? '')
}

/** 从「AUDI-0002」这类编号推出下一版编号；只排序号最大的那个，保证不撞号。 */
function nextRuleNo(rows: EntryRow[], field: string, prefix: string): string {
  const max = rows.reduce((current, row) => {
    const matched = String(row[field] ?? '').match(/(\d+)$/)
    const value = matched ? Number(matched[1]) : 0
    return Math.max(current, value)
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((current, row) => Math.max(current, Number(row.id) || 0), 0) + 1
}

/**
 * 校验动作是否能从当前状态出发。
 * 有 actionFrom 的模块（审计、预警）严格按状态机推进；其他模块保持原有宽松行为。
 */
function transitionError(meta: ModuleMeta, row: EntryRow, action: string, target: string): string | null {
  const allowedFrom = meta.actionFrom?.[action]
  if (allowedFrom && !allowedFrom.includes(String(row.status))) {
    return `${meta.entity}当前状态「${row.status}」不能执行「${action}」，只能从「${allowedFrom.join('、')}」推进`
  }
  if (String(row.status) === target) {
    return `${meta.entity}已经是「${target}」，不用重复操作`
  }
  return null
}

export function runAction(key: string, id: number, action: string, operator = '值班管理员'): ActionResult {
  if (key === 'auditcheck') {
    return runAuditAction(id, action, operator)
  }
  if (key === 'opsalert') {
    return runWarningAction(id, action)
  }
  return runGenericAction(key, id, action)
}

function runGenericAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  return runTransaction<ActionResult>((draft) => {
    const rows = draft.entries[key] ?? []
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { commit: false, value: { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` } }
    }
    const current = rows[index]
    const error = transitionError(meta, current, action, target)
    if (error) {
      return { commit: false, value: { ok: false, message: error } }
    }
    const lastStatus = meta.statuses[meta.statuses.length - 1]
    draft.entries[key][index] = {
      ...current,
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    return {
      commit: true,
      value: { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` },
    }
  })
}

type Draft = Parameters<Parameters<typeof runTransaction>[0]>[0]

/** 当前规则版本的告警；告警编号 + 版本一经生成就不允许改挂到别的规则。 */
function alarmsOfVersion(alarms: AlarmRow[], ruleNoValue: string, version: number): AlarmRow[] {
  return alarms.filter(
    (alarm) => alarm.auditRuleNo === ruleNoValue && alarm.auditVersion === version,
  )
}

function closureOfVersion(draft: Draft, ruleNoValue: string, version: number): ClosureRecord | undefined {
  return draft.closures.find(
    (item) => item.auditRuleNo === ruleNoValue && item.auditVersion === version,
  )
}

function freezeAlarms(alarms: AlarmRow[], closedAt: string): void {
  for (const alarm of alarms) {
    // 已归档的告警保留它自己的最终异常量，未归档的按关闭时的累计值冻结。
    if (!alarm.finalAnomalyCount) {
      alarm.finalAnomalyCount = alarm.anomalyCount
    }
    if (alarm.state === '未结') {
      alarm.state = '历史'
      alarm.archivedAt = closedAt
    }
  }
}

/** 升级结论按告警产生时间取最新一条，审计详情与预警详情用同一份。 */
function latestEscalationOf(alarms: AlarmRow[]): string {
  if (alarms.length === 0) {
    return '无升级记录'
  }
  return [...alarms].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[alarms.length - 1].escalation
}

function closureReport(closure: ClosureRecord, alarms: AlarmRow[], condition: string): ExportFile {
  const lines: (string | number | boolean)[][] = [
    ['关闭核查'],
    ['审计规则编号', closure.auditRuleNo],
    ['审计规则版本', `v${closure.auditVersion}`],
    ['审计对象', closure.auditObject],
    ['审计频率', closure.auditFrequency],
    ['修复建议', closure.fixSuggestion],
    ['关闭时间', closure.closedAt],
    ['关闭人', closure.closedBy],
    ['预警规则编号', closure.alertRuleNo],
    ['通知对象', closure.notifyTargets],
    ['升级策略', closure.escalationPolicy],
    ['最终异常量', closure.finalAnomalyCount],
    ['归档未结异常量', closure.archivedUnresolvedAnomalyCount],
    ['历史升级结论', closure.latestEscalation],
    [],
    ['历史升级记录'],
    ['告警编号', '规则版本', '异常条件快照', '异常量', '最终异常量', '升级结论', '状态', '产生时间', '归档时间'],
    ...alarms.map((alarm) => [
      alarm.alarmNo,
      `v${alarm.auditVersion}`,
      alarm.conditionSnapshot,
      alarm.anomalyCount,
      alarm.finalAnomalyCount,
      alarm.escalation,
      alarm.state,
      alarm.createdAt,
      alarm.archivedAt,
    ]),
  ]
  if (condition) {
    lines.splice(5, 0, ['异常条件', condition])
  }
  return {
    filename: `数据审计关闭核查-${closure.auditRuleNo}.csv`,
    content: buildCsv(lines),
  }
}

function runAuditAction(id: number, action: string, operator: string): ActionResult {
  const meta = moduleMeta('auditcheck')
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (action === '关闭规则') {
    return closeAuditRule(id, operator)
  }
  if (action === '重新生效') {
    return reactivateAuditRule(id)
  }
  return runTransaction<ActionResult>((draft) => {
    const rows = draft.entries.auditcheck ?? []
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { commit: false, value: { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` } }
    }
    const current = rows[index]
    const error = transitionError(meta, current, action, target)
    if (error) {
      return { commit: false, value: { ok: false, message: error } }
    }
    const version = ruleVersion(current)
    const updated: EntryRow = {
      ...current,
      status: target,
      pending: target !== '已生效',
      abnormal: false,
    }
    if (target === '已生效') {
      updated['规则版本'] = version
    }
    draft.entries.auditcheck[index] = updated
    return {
      commit: true,
      value: { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` },
    }
  })
}

/**
 * 关闭审计规则：规则状态、告警归档、关闭核查记录在同一次事务里落盘。
 * - 未结告警转为历史，归档时间写入关闭时间；
 * - 所有告警冻结最终异常量，关闭后不再累计；
 * - 历史升级记录原样保留（异常条件沿用告警产生时的版本快照）。
 */
function closeAuditRule(id: number, operator: string): ActionResult {
  return runTransaction<ActionResult>((draft) => {
    const rows = draft.entries.auditcheck ?? []
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { commit: false, value: { ok: false, message: `没有找到编号为 ${id} 的审计规则` } }
    }
    const current = rows[index]
    const ruleNoValue = ruleNo(current)
    const version = ruleVersion(current)

    if (current.status === '已关闭') {
      return { commit: false, value: { ok: false, message: `审计规则 ${ruleNoValue} 已关闭，不能重复关闭` } }
    }
    const error = transitionError(moduleMeta('auditcheck'), current, '关闭规则', '已关闭')
    if (error) {
      return { commit: false, value: { ok: false, message: error } }
    }
    // 版本要么是当前版本，要么没有历史可归档的告警；不允许把其他版本的告警并进来。
    const staleAlarm = draft.alarms.find(
      (alarm) =>
        alarm.auditRuleNo === ruleNoValue &&
        alarm.state === '未结' &&
        alarm.auditVersion !== version,
    )
    if (staleAlarm) {
      return {
        commit: false,
        value: { ok: false, message: `审计规则 ${ruleNoValue} 存在版本不一致的未结告警 ${staleAlarm.alarmNo}，请先核对规则版本` },
      }
    }
    if (closureOfVersion(draft, ruleNoValue, version)) {
      return { commit: false, value: { ok: false, message: `审计规则 ${ruleNoValue} v${version} 已有关闭核查记录，不能重复关闭` } }
    }

    const closedAt = nowText()
    const alarms = alarmsOfVersion(draft.alarms, ruleNoValue, version)
    const unresolved = alarms.filter((alarm) => alarm.state === '未结')
    const archivedUnresolvedAnomalyCount = unresolved.reduce((sum, alarm) => sum + alarm.anomalyCount, 0)
    const finalAnomalyCount = alarms.reduce((sum, alarm) => sum + alarm.anomalyCount, 0)

    freezeAlarms(alarms, closedAt)

    const warningRuleNo = String(current['关联预警规则'] ?? '')
    const warningRule = (draft.entries.opsalert ?? []).find((row) => ruleNo(row) === warningRuleNo)
    const closure: ClosureRecord = {
      id: nextId(draft.closures),
      auditRuleNo: ruleNoValue,
      auditVersion: version,
      alertRuleNo: warningRuleNo,
      auditObject: String(current['审计对象'] ?? ''),
      auditFrequency: String(current['审计频率'] ?? ''),
      fixSuggestion: String(current['修复建议'] ?? ''),
      closedAt,
      closedBy: operator,
      notifyTargets: String(warningRule?.['通知对象'] ?? ''),
      escalationPolicy: String(warningRule?.['升级策略'] ?? ''),
      finalAnomalyCount,
      archivedUnresolvedAnomalyCount,
      historyCount: alarms.length,
      latestEscalation: latestEscalationOf(alarms),
    }
    draft.closures.push(closure)
    draft.entries.auditcheck[index] = {
      ...current,
      status: '已关闭',
      pending: false,
      abnormal: false,
      // 规则表展示关闭时冻结的最终异常量，避免详情页继续用旧累计值。
      '最终异常量': finalAnomalyCount,
    }

    return {
      commit: true,
      value: {
        ok: true,
        message: `审计规则 ${ruleNoValue} 已关闭：${unresolved.length} 条未结告警转为历史，最终异常量 ${finalAnomalyCount}`,
        report: closureReport(closure, [...alarms].sort((a, b) => a.id - b.id), String(current['异常条件'] ?? '')),
      },
    }
  })
}

/**
 * 重新生效：必须生成新的审计版本和新规则编号，原规则保持已关闭。
 * 旧告警只属于旧规则旧版本，不会被恢复、不会被改挂到新规则。
 */
function reactivateAuditRule(id: number): ActionResult {
  return runTransaction<ActionResult>((draft) => {
    const rows = draft.entries.auditcheck ?? []
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { commit: false, value: { ok: false, message: `没有找到编号为 ${id} 的审计规则` } }
    }
    const current = rows[index]
    const originalNo = ruleNo(current)
    if (current.status !== '已关闭') {
      return {
        commit: false,
        value: { ok: false, message: `审计规则 ${originalNo} 当前状态「${current.status}」不能重新生效，只有已关闭的规则需要重新生效` },
      }
    }
    if (current['重新生效为']) {
      return {
        commit: false,
        value: { ok: false, message: `审计规则 ${originalNo} 已重新生效为 ${current['重新生效为']}，不能重复改版` },
      }
    }
    const version = ruleVersion(current) + 1
    const newNo = nextRuleNo(rows, '规则编号', 'AUDI')
    const cloned: EntryRow = {
      ...current,
      id: nextId(rows),
      status: '已生效',
      pending: false,
      abnormal: false,
      '规则编号': newNo,
      '规则版本': version,
      '来源规则编号': originalNo,
      '最终异常量': 0,
    }
    rows.push(cloned)
    // 原规则保持已关闭，记录改版去向；历史告警仍挂在旧编号 + 旧版本上，无法被新规则恢复。
    draft.entries.auditcheck[index] = {
      ...current,
      pending: false,
      abnormal: false,
      '重新生效为': newNo,
    }
    return {
      commit: true,
      value: {
        ok: true,
        message: `审计规则 ${originalNo} 已关闭，重新生效生成新版本 ${newNo}（v${version}），旧告警保持历史`,
        newRuleNo: newNo,
      },
    }
  })
}

function runWarningAction(id: number, action: string): ActionResult {
  const meta = moduleMeta('opsalert')
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  return runTransaction<ActionResult>((draft) => {
    const rows = draft.entries.opsalert ?? []
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { commit: false, value: { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` } }
    }
    const current = rows[index]
    const error = transitionError(meta, current, action, target)
    if (error) {
      return { commit: false, value: { ok: false, message: error } }
    }
    if (target === '已关闭') {
      const unresolved = draft.alarms.filter(
        (alarm) => alarm.alertRuleNo === ruleNo(current) && alarm.state === '未结',
      )
      if (unresolved.length > 0) {
        return {
          commit: false,
          value: {
            ok: false,
            message: `预警规则 ${ruleNo(current)} 还有 ${unresolved.length} 条未结告警，请先关闭对应审计规则并归档告警`,
          },
        }
      }
    }
    draft.entries.opsalert[index] = {
      ...current,
      status: target,
      pending: target !== '已生效' && target !== '已关闭',
      abnormal: false,
    }
    return {
      commit: true,
      value: { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` },
    }
  })
}

export function listAlarmEntries(): AlarmRow[] {
  return [...listAlarms()].sort((a, b) => a.id - b.id)
}

/**
 * 登记新异常量：只有「未结」且规则版本未关闭的告警才继续累计。
 * 规则关闭后告警已归档，这里直接拒绝，保证最终异常量不会被改版或新异常刷新。
 */
export function recordAnomaly(alarmNo: string, delta = 1): ActionResult {
  if (!Number.isFinite(delta) || delta <= 0) {
    return { ok: false, message: '新增异常量必须是正数' }
  }
  return runTransaction<ActionResult>((draft) => {
    const alarm = draft.alarms.find((item) => item.alarmNo === alarmNo)
    if (!alarm) {
      return { commit: false, value: { ok: false, message: `没有找到告警 ${alarmNo}` } }
    }
    if (alarm.state !== '未结') {
      return { commit: false, value: { ok: false, message: `告警 ${alarmNo} 已归档为历史，不再累计异常量` } }
    }
    if (closureOfVersion(draft, alarm.auditRuleNo, alarm.auditVersion)) {
      return { commit: false, value: { ok: false, message: `告警 ${alarmNo} 所属审计规则已关闭，不再累计异常量` } }
    }
    alarm.anomalyCount += delta
    return {
      commit: true,
      value: { ok: true, message: `告警 ${alarmNo} 异常量已累计至 ${alarm.anomalyCount}` },
    }
  })
}

/** 规则列表上直接展示的汇总：关闭后未结告警归零、最终异常量冻结，和详情页同一口径。 */
export type RuleSummary = {
  unresolvedCount: number
  unresolvedAnomalyCount: number
  finalAnomalyCount: number
  historyCount: number
  closedAt: string
  latestEscalation: string
}

export function listAuditSummaries(): Record<string, RuleSummary> {
  const alarms = listAlarms()
  const closures = listClosures()
  const result: Record<string, RuleSummary> = {}
  for (const rule of listRows('auditcheck')) {
    const ruleNoValue = ruleNo(rule)
    const version = ruleVersion(rule)
    const closure = closures.find(
      (item) => item.auditRuleNo === ruleNoValue && item.auditVersion === version,
    )
    result[ruleNoValue] = {
      ...summarizeAlarms(alarmsOfVersion(alarms, ruleNoValue, version), closure),
      closedAt: closure?.closedAt ?? '',
    }
  }
  return result
}

function resolveWarningRule(rule: EntryRow): EntryRow[] {
  const linkedNo = String(rule['关联预警规则'] ?? '')
  if (!linkedNo) {
    return []
  }
  return listRows('opsalert').filter((row) => ruleNo(row) === linkedNo)
}

/** 审计详情与预警详情共用同一套汇总结论，避免两处升级结论对不上。 */
function summarizeAlarms(alarms: AlarmRow[], closure: ClosureRecord | undefined) {
  // 已归档告警按冻结的最终异常量计，未结告警按当前累计值计：
  // 关闭后的版本不再变化，重新生效的新版本另起告警继续累计。
  const unresolved = alarms.filter((alarm) => alarm.state === '未结')
  const history = alarms.filter((alarm) => alarm.state === '历史')
  const unresolvedAnomalyCount = unresolved.reduce((sum, alarm) => sum + alarm.anomalyCount, 0)
  const finalAnomalyCount = alarms.reduce(
    (sum, alarm) => sum + (alarm.state === '历史' ? alarm.finalAnomalyCount || alarm.anomalyCount : alarm.anomalyCount),
    0,
  )
  return {
    unresolvedCount: unresolved.length,
    unresolvedAnomalyCount,
    // 没有告警但有关闭核查时，仍展示关闭时冻结的最终异常量。
    finalAnomalyCount: alarms.length === 0 && closure ? closure.finalAnomalyCount : finalAnomalyCount,
    historyCount: history.length,
    latestEscalation: alarms.length === 0 ? closure?.latestEscalation ?? '无升级记录' : latestEscalationOf(alarms),
  }
}

export function getAuditRuleDetail(id: number): AuditRuleDetail {
  const rule = listRows('auditcheck').find((row) => Number(row.id) === id)
  if (!rule) {
    throw new Error(`没有找到编号为 ${id} 的审计规则`)
  }
  const ruleNoValue = ruleNo(rule)
  const version = ruleVersion(rule)
  const alarms = alarmsOfVersion(listAlarms(), ruleNoValue, version).sort((a, b) => a.id - b.id)
  const closure = listClosures().find(
    (item) => item.auditRuleNo === ruleNoValue && item.auditVersion === version,
  )
  return {
    rule,
    warningRules: resolveWarningRule(rule),
    alarms,
    closure: closure ?? null,
    ...summarizeAlarms(alarms, closure),
  }
}

export function getWarningRuleDetail(id: number): WarningRuleDetail {
  const rule = listRows('opsalert').find((row) => Number(row.id) === id)
  if (!rule) {
    throw new Error(`没有找到编号为 ${id} 的预警规则`)
  }
  const warningNo = ruleNo(rule)
  const alarms = listAlarms()
    .filter((alarm) => alarm.alertRuleNo === warningNo)
    .sort((a, b) => a.id - b.id)
  // 预警可能关联多个审计版本：优先取真正归档过告警的最近一版关闭核查，
  // 避免新版本关闭（该版本没有历史告警）覆盖旧版本的最终异常量结论。
  const warningClosures = listClosures().filter((item) => item.alertRuleNo === warningNo)
  const closure =
    warningClosures.filter((item) => item.historyCount > 0).sort((a, b) => b.id - a.id)[0] ??
    warningClosures.sort((a, b) => b.id - a.id)[0]
  const linkedAuditNo = String(rule['关联审计规则'] ?? '')
  const auditRules = listRows('auditcheck').filter((row) =>
    linkedAuditNo
      ? ruleNo(row) === linkedAuditNo || String(row['关联预警规则'] ?? '') === warningNo
      : String(row['关联预警规则'] ?? '') === warningNo,
  )
  return {
    rule,
    auditRules,
    alarms,
    closure: closure ?? null,
    ...summarizeAlarms(alarms, closure),
  }
}

export function getAuditClosureReport(id: number): ExportFile {
  const detail = getAuditRuleDetail(id)
  if (!detail.closure) {
    throw new Error('审计规则尚未关闭，没有关闭核查可导出')
  }
  return closureReport(
    detail.closure,
    detail.alarms,
    String(detail.rule['异常条件'] ?? ''),
  )
}

export function downloadExport(file: ExportFile): void {
  const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // 立刻 revoke 会让部分浏览器取消下载，留出时间再回收。
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].map(csvCell).join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  downloadExport(exportEntries(key))
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

