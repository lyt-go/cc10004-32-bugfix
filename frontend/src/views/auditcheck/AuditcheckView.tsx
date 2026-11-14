import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  downloadEntries,
  downloadExport,
  getAuditClosureReport,
  getAuditRuleDetail,
  listAuditSummaries,
  listAlarmEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { AuditRuleDetail, EntryRow } from '@/data/types'
import type { RuleSummary } from '@/api/local-service'

const meta = moduleMeta('auditcheck')
const columns = [
  '规则编号',
  '审计对象',
  '校验字段',
  '异常条件',
  '告警级别',
  '审计频率',
  '修复建议',
  '规则版本',
  '关联预警规则',
]
const allActions = ['提交规则评审', '生效规则', '关闭规则', '重新生效']
const statuses = ['草稿', '规则评审中', '已生效', '已关闭']

function allowedActions(row: EntryRow): string[] {
  const allowed = meta.actionFrom ?? {}
  return allActions.filter((action) => {
    // 已完成改版的旧规则不再提供「重新生效」，避免重复生成版本。
    if (action === '重新生效' && row['重新生效为']) {
      return false
    }
    const from = allowed[action]
    return !from || from.includes(String(row.status))
  })
}

export default function AuditcheckView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [noticeMessage, setNoticeMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<AuditRuleDetail | null>(null)
  const [summaries, setSummaries] = useState<Record<string, RuleSummary>>({})
  const [latestReportId, setLatestReportId] = useState<number | null>(null)
  const [alarms, setAlarms] = useState(() => listAlarmEntries())
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setSummaries(listAuditSummaries())
      setAlarms(listAlarmEntries())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据审计列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function openDetail(row: EntryRow) {
    setErrorMessage('')
    try {
      setDetail(getAuditRuleDetail(Number(row.id)))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '审计详情读取失败')
    }
  }

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNoticeMessage('')
    try {
      const result = applyAction(meta.key, Number(row.id), action)
      if (!result.ok) {
        setErrorMessage(result.message)
        return
      }
      setNoticeMessage(result.message)
      // 关闭核查是导出留存的主入口：关闭成功后立刻给出可下载文件。
      if (result.report) {
        downloadExport(result.report)
        setLatestReportId(Number(row.id))
      }
      if (result.newRuleNo) {
        const created = listEntries(meta.key).items.find((item) => String(item['规则编号']) === result.newRuleNo)
        if (created) {
          setDetail(getAuditRuleDetail(Number(created.id)))
        }
      }
      reload()
      if (!result.newRuleNo) {
        setDetail(getAuditRuleDetail(Number(row.id)))
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '动作执行失败')
    }
  }

  function downloadClosure(id: number) {
    setErrorMessage('')
    try {
      downloadExport(getAuditClosureReport(id))
      setLatestReportId(id)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '关闭核查导出失败')
    }
  }

  const statItems = [
    { label: '审计规则总数', value: rows.length },
    { label: '已生效规则', value: rows.filter((row) => String(row.status) === '已生效').length },
    { label: '规则评审中', value: rows.filter((row) => String(row.status) === '规则评审中').length },
    { label: '已关闭规则', value: rows.filter((row) => String(row.status) === '已关闭').length },
  ]

  return (
    <section className="page" data-module="auditcheck">
      <header className="page-head">
        <div>
          <h2>数据审计管理</h2>
          <p className="page-desc">
            审计规则按 草稿 → 规则评审中 → 已生效 → 已关闭 推进；关闭会把未结告警转为历史并冻结最终异常量，
            重新生效只能生成新的审计版本。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('审计规则登记入口尚未接入审批流')}>
            登记审计规则
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出数据审计清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {statItems.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table" data-testid="audit-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>未结告警</th>
            <th>最终异常量</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)} data-rule-no={String(row['规则编号'])}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td>{summaries[String(row['规则编号'])]?.unresolvedCount ?? 0}</td>
              <td>{summaries[String(row['规则编号'])]?.finalAnomalyCount ?? '—'}</td>
              <td className="row-actions">
                {allowedActions(row).map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
                <button className="link" type="button" onClick={() => openDetail(row)}>查看详情</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 4}>暂无数据审计数据，可先登记审计规则</td>
            </tr>
          )}
        </tbody>
      </table>

      {detail && (
        <section className="detail-panel" data-testid="audit-detail" data-rule-no={String(detail.rule['规则编号'])}>
          <header className="panel-head">
            <h3>
              审计详情 · {String(detail.rule['规则编号'])}（v{String(detail.rule['规则版本'] ?? 1)}）
            </h3>
            <button className="btn ghost" type="button" onClick={() => setDetail(null)}>收起</button>
          </header>

          <div className="kv-grid">
            <div><span>规则状态</span><strong>{String(detail.rule.status)}</strong></div>
            <div><span>审计频率</span><strong>{String(detail.rule['审计频率'] ?? '')}</strong></div>
            <div><span>修复建议</span><strong>{String(detail.rule['修复建议'] ?? '')}</strong></div>
            <div><span>异常条件（当前版本）</span><strong>{String(detail.rule['异常条件'] ?? '')}</strong></div>
            <div><span>关联预警规则</span><strong>{String(detail.rule['关联预警规则'] ?? '—')}</strong></div>
            <div><span>通知对象</span><strong data-testid="live-notify">{String(detail.warningRules[0]?.['通知对象'] ?? '—')}</strong></div>
            <div><span>升级策略</span><strong data-testid="live-escalation">{String(detail.warningRules[0]?.['升级策略'] ?? '—')}</strong></div>
            <div><span>未结告警</span><strong data-testid="unresolved-count">{detail.unresolvedCount}</strong></div>
            <div><span>未结异常量</span><strong data-testid="unresolved-anomaly">{detail.unresolvedAnomalyCount}</strong></div>
            <div><span>最终异常量</span><strong data-testid="final-anomaly">{detail.finalAnomalyCount}</strong></div>
            <div><span>历史升级结论</span><strong data-testid="latest-escalation">{detail.latestEscalation}</strong></div>
          </div>

          {detail.closure && (
            <div className="closure-box" data-testid="audit-closure">
              <h4>关闭核查（已归档）</h4>
              <div className="kv-grid">
                <div><span>审计频率</span><strong>{detail.closure.auditFrequency}</strong></div>
                <div><span>修复建议</span><strong>{detail.closure.fixSuggestion}</strong></div>
                <div><span>关闭时间</span><strong data-testid="closed-at">{detail.closure.closedAt}</strong></div>
                <div><span>关闭人</span><strong>{detail.closure.closedBy}</strong></div>
                <div><span>关联预警规则</span><strong>{detail.closure.alertRuleNo}</strong></div>
                <div><span>通知对象</span><strong data-testid="closure-notify">{detail.closure.notifyTargets || '—'}</strong></div>
                <div><span>升级策略</span><strong data-testid="closure-escalation">{detail.closure.escalationPolicy || '—'}</strong></div>
                <div><span>关闭时归档未结异常量</span><strong>{detail.closure.archivedUnresolvedAnomalyCount}</strong></div>
                <div><span>最终异常量（冻结）</span><strong data-testid="closure-final-anomaly">{detail.closure.finalAnomalyCount}</strong></div>
                <div><span>历史升级结论</span><strong>{detail.closure.latestEscalation}</strong></div>
              </div>
              <button className="btn" type="button" data-testid="download-closure" onClick={() => downloadClosure(Number(detail.rule.id))}>
                导出关闭核查
              </button>
              {latestReportId === Number(detail.rule.id) && (
                <span className="hint-text" data-testid="report-ready">关闭核查文件已生成，可再次下载留存</span>
              )}
            </div>
          )}

          <div className="table-title">告警与历史升级记录（当前规则版本）</div>
          <table className="data-table" data-testid="alarm-table">
            <thead>
              <tr>
                <th>告警编号</th>
                <th>规则版本</th>
                <th>异常条件快照</th>
                <th>异常量</th>
                <th>最终异常量</th>
                <th>升级结论</th>
                <th>告警状态</th>
                <th>产生时间</th>
                <th>归档时间</th>
              </tr>
            </thead>
            <tbody>
              {detail.alarms.map((alarm) => (
                <tr key={alarm.alarmNo} data-alarm-no={alarm.alarmNo} data-state={alarm.state}>
                  <td>{alarm.alarmNo}</td>
                  <td>v{alarm.auditVersion}</td>
                  <td>{alarm.conditionSnapshot}</td>
                  <td>{alarm.anomalyCount}</td>
                  <td>{alarm.finalAnomalyCount || '—'}</td>
                  <td>{alarm.escalation}</td>
                  <td>{alarm.state}</td>
                  <td>{alarm.createdAt}</td>
                  <td>{alarm.archivedAt || '—'}</td>
                </tr>
              ))}
              {detail.alarms.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={9}>当前版本暂无告警记录</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      <section className="detail-panel" data-testid="alarm-overview">
        <header className="panel-head">
          <h3>告警列表（全部规则版本）</h3>
          <span className="hint-text">
            未结 {alarms.filter((alarm) => alarm.state === '未结').length} 条 · 历史{' '}
            {alarms.filter((alarm) => alarm.state === '历史').length} 条
          </span>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>告警编号</th>
              <th>审计规则</th>
              <th>规则版本</th>
              <th>异常条件快照</th>
              <th>异常量</th>
              <th>最终异常量</th>
              <th>告警状态</th>
              <th>归档时间</th>
            </tr>
          </thead>
          <tbody>
            {alarms.map((alarm) => (
              <tr key={alarm.alarmNo} data-alarm-no={alarm.alarmNo} data-state={alarm.state}>
                <td>{alarm.alarmNo}</td>
                <td>{alarm.auditRuleNo}</td>
                <td>v{alarm.auditVersion}</td>
                <td>{alarm.conditionSnapshot}</td>
                <td>{alarm.anomalyCount}</td>
                <td>{alarm.finalAnomalyCount || '—'}</td>
                <td>{alarm.state}</td>
                <td>{alarm.archivedAt || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="page-foot">
        <span>共 {total} 条数据审计记录</span>
        {noticeMessage && <span className="notice-text" data-testid="notice">{noticeMessage}</span>}
        {errorMessage && <span className="error-text" data-testid="error">{errorMessage}</span>}
      </footer>
    </section>
  )
}
