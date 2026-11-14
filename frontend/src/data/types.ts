/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  /** 每个动作允许的起始状态；登记了就从这些状态严格推进，没登记保持宽松兼容。 */
  actionFrom?: Record<string, string[]>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ExportFile = {
  filename: string
  content: string
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 关闭核查等动作会顺手生成可下载的导出文件。 */
  report?: ExportFile
  /** 审计规则重新生效时会生成新的规则编号。 */
  newRuleNo?: string
}

/** 告警在规则关闭时从「未结」归档为「历史」，异常量不再变化。 */
export type AlarmState = '未结' | '历史'

export type AlarmRow = {
  id: number
  alarmNo: string
  auditRuleNo: string
  auditVersion: number
  alertRuleNo: string
  /** 告警产生时的异常条件快照：历史升级记录永远保留当时的版本口径。 */
  conditionSnapshot: string
  anomalyCount: number
  finalAnomalyCount: number
  escalation: string
  state: AlarmState
  createdAt: string
  archivedAt: string
}

export type ClosureRecord = {
  id: number
  auditRuleNo: string
  auditVersion: number
  alertRuleNo: string
  auditObject: string
  auditFrequency: string
  fixSuggestion: string
  closedAt: string
  closedBy: string
  notifyTargets: string
  escalationPolicy: string
  finalAnomalyCount: number
  archivedUnresolvedAnomalyCount: number
  historyCount: number
  /** 关闭时冻结的最新升级结论，审计详情与预警详情共用同一份。 */
  latestEscalation: string
}

export type AuditRuleDetail = {
  rule: EntryRow
  warningRules: EntryRow[]
  alarms: AlarmRow[]
  closure: ClosureRecord | null
  unresolvedCount: number
  unresolvedAnomalyCount: number
  finalAnomalyCount: number
  historyCount: number
  latestEscalation: string
}

export type WarningRuleDetail = {
  rule: EntryRow
  auditRules: EntryRow[]
  alarms: AlarmRow[]
  closure: ClosureRecord | null
  unresolvedCount: number
  unresolvedAnomalyCount: number
  finalAnomalyCount: number
  historyCount: number
  latestEscalation: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
