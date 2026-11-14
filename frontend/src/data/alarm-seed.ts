import type { AlarmRow, ClosureRecord } from './types'

// 告警与关闭核查的示例数据：告警永远挂在「审计规则编号 + 规则版本」上，
// 规则关闭后只改状态、冻结最终异常量，不删除历史升级记录。
export const ALARM_SEED: AlarmRow[] = [
  {
    id: 1,
    alarmNo: 'ALAR-0001',
    auditRuleNo: 'AUDI-0002',
    auditVersion: 1,
    alertRuleNo: 'OPSA-0002',
    conditionSnapshot: '订单金额日环比跌幅 > 20%（v1）',
    anomalyCount: 12,
    finalAnomalyCount: 0,
    escalation: 'P1 已通知数据平台值班组',
    state: '未结',
    createdAt: '2026-11-13 09:12:00',
    archivedAt: '',
  },
  {
    id: 2,
    alarmNo: 'ALAR-0002',
    auditRuleNo: 'AUDI-0002',
    auditVersion: 1,
    alertRuleNo: 'OPSA-0002',
    conditionSnapshot: '订单金额日环比跌幅 > 20%（v1）',
    anomalyCount: 5,
    finalAnomalyCount: 0,
    escalation: '30 分钟未响应，已升级至数据平台负责人',
    state: '未结',
    createdAt: '2026-11-13 14:26:00',
    archivedAt: '',
  },
  {
    id: 3,
    alarmNo: 'ALAR-0003',
    auditRuleNo: 'AUDI-0002',
    auditVersion: 1,
    alertRuleNo: 'OPSA-0002',
    conditionSnapshot: '订单金额日环比跌幅 > 20%（v1）',
    anomalyCount: 8,
    finalAnomalyCount: 8,
    escalation: '指标已恢复，告警转历史',
    state: '历史',
    createdAt: '2026-11-13 10:05:00',
    archivedAt: '2026-11-13 18:40:00',
  },
]

export const CLOSURE_SEED: ClosureRecord[] = []
