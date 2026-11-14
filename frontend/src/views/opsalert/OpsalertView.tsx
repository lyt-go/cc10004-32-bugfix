import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  downloadEntries,
  getWarningRuleDetail,
  listAlarmEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, WarningRuleDetail } from '@/data/types'

const meta = moduleMeta('opsalert')
const columns = [
  '预警编号',
  '监控指标',
  '比较方式',
  '阈值数值',
  '持续周期',
  '预警级别',
  '通知对象',
  '升级策略',
  '规则版本',
  '关联审计规则',
]
const allActions = ['提交规则评审', '生效规则', '关闭规则']
const statuses = ['草稿', '规则评审中', '已生效', '已关闭']

function allowedActions(row: EntryRow): string[] {
  const allowed = meta.actionFrom ?? {}
  return allActions.filter((action) => {
    const from = allowed[action]
    return !from || from.includes(String(row.status))
  })
}

export default function OpsalertView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [noticeMessage, setNoticeMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<WarningRuleDetail | null>(null)
  const [alarms, setAlarms] = useState(() => listAlarmEntries())
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setAlarms(listAlarmEntries())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '运营预警列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function openDetail(row: EntryRow) {
    setErrorMessage('')
    try {
      setDetail(getWarningRuleDetail(Number(row.id)))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '预警详情读取失败')
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
      reload()
      setDetail(getWarningRuleDetail(Number(row.id)))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '动作执行失败')
    }
  }

  const statItems = [
    { label: '预警规则总数', value: rows.length },
    { label: '已生效规则', value: rows.filter((row) => String(row.status) === '已生效').length },
    { label: '规则评审中', value: rows.filter((row) => String(row.status) === '规则评审中').length },
    { label: '已关闭规则', value: rows.filter((row) => String(row.status) === '已关闭').length },
  ]

  return (
    <section className="page" data-module="opsalert">
      <header className="page-head">
        <div>
          <h2>运营预警管理</h2>
          <p className="page-desc">
            定义数据产品运营的异常预警规则；未结告警必须先随审计规则关闭归档，预警规则才能关闭。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('预警规则登记入口尚未接入审批流')}>
            登记预警规则
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出运营预警清单
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

      <table className="data-table" data-testid="warning-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>未结告警</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)} data-rule-no={String(row['预警编号'])}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td>
                {alarms.filter(
                  (alarm) => alarm.alertRuleNo === String(row['预警编号']) && alarm.state === '未结',
                ).length}
              </td>
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
              <td className="empty-state" colSpan={columns.length + 3}>暂无运营预警数据，可先登记预警规则</td>
            </tr>
          )}
        </tbody>
      </table>

      {detail && (
        <section className="detail-panel" data-testid="warning-detail" data-rule-no={String(detail.rule['预警编号'])}>
          <header className="panel-head">
            <h3>预警详情 · {String(detail.rule['预警编号'])}</h3>
            <button className="btn ghost" type="button" onClick={() => setDetail(null)}>收起</button>
          </header>

          <div className="kv-grid">
            <div><span>通知对象</span><strong data-testid="notify-targets">{String(detail.rule['通知对象'] ?? '')}</strong></div>
            <div><span>升级策略</span><strong data-testid="escalation-policy">{String(detail.rule['升级策略'] ?? '')}</strong></div>
            <div><span>未结告警</span><strong data-testid="unresolved-count">{detail.unresolvedCount}</strong></div>
            <div><span>未结异常量</span><strong data-testid="unresolved-anomaly">{detail.unresolvedAnomalyCount}</strong></div>
            <div><span>最终异常量</span><strong data-testid="final-anomaly">{detail.finalAnomalyCount}</strong></div>
            <div><span>历史升级结论</span><strong data-testid="latest-escalation">{detail.latestEscalation}</strong></div>
          </div>

          {detail.closure && (
            <div className="closure-box" data-testid="warning-closure">
              <h4>关闭核查（来自审计规则 {detail.closure.auditRuleNo}）</h4>
              <div className="kv-grid">
                <div><span>审计频率</span><strong>{detail.closure.auditFrequency}</strong></div>
                <div><span>修复建议</span><strong>{detail.closure.fixSuggestion}</strong></div>
                <div><span>关闭时间</span><strong data-testid="closed-at">{detail.closure.closedAt}</strong></div>
                <div><span>通知对象</span><strong data-testid="closure-notify">{detail.closure.notifyTargets || '—'}</strong></div>
                <div><span>升级策略</span><strong data-testid="closure-escalation">{detail.closure.escalationPolicy || '—'}</strong></div>
                <div><span>最终异常量（冻结）</span><strong data-testid="closure-final-anomaly">{detail.closure.finalAnomalyCount}</strong></div>
              </div>
            </div>
          )}

          <div className="table-title">告警与历史升级记录</div>
          <table className="data-table" data-testid="alarm-table">
            <thead>
              <tr>
                <th>告警编号</th>
                <th>审计规则</th>
                <th>规则版本</th>
                <th>异常条件快照</th>
                <th>异常量</th>
                <th>最终异常量</th>
                <th>升级结论</th>
                <th>告警状态</th>
                <th>归档时间</th>
              </tr>
            </thead>
            <tbody>
              {detail.alarms.map((alarm) => (
                <tr key={alarm.alarmNo} data-alarm-no={alarm.alarmNo} data-state={alarm.state}>
                  <td>{alarm.alarmNo}</td>
                  <td>{alarm.auditRuleNo}</td>
                  <td>v{alarm.auditVersion}</td>
                  <td>{alarm.conditionSnapshot}</td>
                  <td>{alarm.anomalyCount}</td>
                  <td>{alarm.finalAnomalyCount || '—'}</td>
                  <td>{alarm.escalation}</td>
                  <td>{alarm.state}</td>
                  <td>{alarm.archivedAt || '—'}</td>
                </tr>
              ))}
              {detail.alarms.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={9}>暂无告警记录</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      <footer className="page-foot">
        <span>共 {total} 条运营预警记录</span>
        {noticeMessage && <span className="notice-text" data-testid="notice">{noticeMessage}</span>}
        {errorMessage && <span className="error-text" data-testid="error">{errorMessage}</span>}
      </footer>
    </section>
  )
}
