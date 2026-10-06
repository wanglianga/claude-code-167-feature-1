import { useState } from 'react'
import { useStore } from '../store'
import { Badge, Notice } from './ui'
import { fmtMin, prettyDate, todayISO, weekdayCN } from '../utils'
import type { Visit } from '../types'

function tomorrowISO(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 电梯故障后的路线重算面板（观众手机端 + 服务台复用）
 * - 说明失效原因、预计延误、是否需要工作人员推行、可替代展区、线上讲解
 * - 给出新参观收益，降低"服务被随意取消"感受
 * - 观众三选一：调整参观顺序 / 改期 / 取消讲解；服务台留存处理结果
 */
export default function ReroutePanel({ visit, viewer = 'visitor' }: { visit: Visit; viewer?: 'visitor' | 'desk' }) {
  const resolveReroute = useStore((s) => s.resolveReroute)
  const deskHandleResolution = useStore((s) => s.deskHandleResolution)
  const analysis = visit.route?.reroute
  const resolution = visit.resolution

  const [date, setDate] = useState(tomorrowISO())
  const [time, setTime] = useState('09:30')
  const [deskNote, setDeskNote] = useState('')

  // 改期后已无在馆故障：不再展示重算面板
  if (visit.status === 'rescheduled' && !resolution) return null

  // —— 已做出选择：展示留存的处理结果（观众端与服务台一致）——
  if (resolution) {
    const handled = !!resolution.handledByDesk
    return (
      <div className="card reroute-card resolved">
        <div className="flex between">
          <h2 style={{ margin: 0 }}>✅ 路线变更处置结果 <Badge tone="green">服务台已留存</Badge></h2>
          <Badge tone="brand">路线 v{resolution.planVersion}</Badge>
        </div>
        <p className="sub mt8">
          {resolution.decidedBy === '观众' ? '您已' : '服务台已代观众'}做出选择，处理结果已写入同一条参观服务记录，各楼层工作人员按此接应。
        </p>
        <Notice kind="ok">
          <b>{resolution.label}</b>
          {resolution.choice === 'reschedule' && resolution.rescheduleDate && (
            <>（改至 {prettyDate(resolution.rescheduleDate)} {weekdayCN(resolution.rescheduleDate)}
            {resolution.rescheduleArrivalMin !== undefined && ` ${fmtMin(resolution.rescheduleArrivalMin)}`} 到馆）</>
          )}
        </Notice>
        {resolution.failedElevators.length > 0 && (
          <p className="small muted">触发原因：{resolution.failedElevators.join('、')}临时停用 · 决定时间 {new Date(resolution.decidedAt).toLocaleString('zh-CN', { hour12: false })}</p>
        )}
        {resolution.note && <p className="small">备注：{resolution.note}</p>}

        {handled ? (
          <Notice kind="ok">服务台处理记录：{resolution.resultText}（{resolution.handledAt ? new Date(resolution.handledAt).toLocaleString('zh-CN', { hour12: false }) : ''}）</Notice>
        ) : viewer === 'desk' ? (
          <div className="mt8">
            <label className="small"><b>服务台接手处理并留存（安排推行/接应/线上讲解推送等）：</b></label>
            <textarea className="mt8" placeholder="例如：已安排志愿者小陈在 2 号梯口接力推行；云端展厅链接已短信推送观众…"
              value={deskNote} onChange={(e) => setDeskNote(e.target.value)} />
            <button className="btn sm mt8" disabled={!deskNote.trim()}
              onClick={() => { deskHandleResolution(visit.id, deskNote.trim()); setDeskNote('') }}>
              留存服务台处理结果
            </button>
          </div>
        ) : (
          <p className="small muted mt8" style={{ marginBottom: 0 }}>服务台正在据此安排电梯口/坡道接应与线上讲解推送，处理结果会同步显示在这里。</p>
        )}
      </div>
    )
  }

  // —— 尚未决策：必须确有故障重算分析 ——
  if (!analysis) return null

  const delayText = analysis.delayMin <= 0 ? '几乎不延误' : `约 ${analysis.delayMin} 分钟`
  const by = viewer === 'desk' ? ('服务台' as const) : ('观众' as const)

  return (
    <div className="card reroute-card">
      <div className="flex between">
        <h2 style={{ margin: 0 }}>🛗 通往重点展厅的电梯临时停用 · 路线已重新计算</h2>
        <Badge tone="red">{analysis.failedElevators.join('、')}故障</Badge>
      </div>
      <p className="sub mt8">这不是取消您的参观服务：系统已按您当前位置重算无障碍路线，并由服务台保留安排。请查看原因与新的参观收益后选择如何继续。</p>

      {/* 关键指标 */}
      <div className="stat-row mt8">
        <div className="stat"><b>{delayText}</b><span>预计整体延误</span></div>
        <div className="stat"><b>{analysis.retainedHalls.length}</b><span>保留重点展厅</span></div>
        <div className="stat"><b>{analysis.alternativeHalls.length}</b><span>可替代展区</span></div>
        <div className="stat"><b style={{ color: analysis.needStaffPush ? '#b4372a' : undefined }}>{analysis.needStaffPush ? '需要' : '不需要'}</b><span>工作人员推行/搀扶</span></div>
      </div>

      {/* 失效原因 */}
      <h3 className="mt8">为什么路线变了</h3>
      {analysis.reasons.map((r, i) => <Notice key={i} kind="warn">{r}</Notice>)}

      {/* 受影响 / 替代 / 保留展厅 */}
      <div className="badges mt8">
        {analysis.retainedHalls.map((h) => <Badge key={'r' + h} tone="green">✅ 保留：{h}</Badge>)}
        {analysis.alternativeHalls.map((h) => <Badge key={'a' + h} tone="blue">🔀 替代：{h}</Badge>)}
        {analysis.lostHalls.map((h) => <Badge key={'l' + h} tone="red">⊘ 本次无法到达：{h}</Badge>)}
      </div>

      {analysis.needStaffPush && analysis.staffPushText && (
        <Notice kind="info">🤝 {analysis.staffPushText}</Notice>
      )}
      {analysis.onlineSupplement && analysis.onlineText && (
        <Notice kind="info">💻 {analysis.onlineText}</Notice>
      )}

      {/* 新参观收益 */}
      <h3 className="mt12">这次调整后，您仍能获得的参观收益</h3>
      <ul className="benefit-list">
        {analysis.benefits.map((b, i) => <li key={i}>{b}</li>)}
      </ul>

      {/* 观众三选一 */}
      <hr className="divider" />
      <h3>{viewer === 'desk' ? '代观众选择处置方式' : '请选择您希望如何继续'} <span className="small muted">（结果同步服务台留存）</span></h3>
      <div className="choice-grid">
        <div className={`choice-tile ${!analysis.options.reorder ? 'disabled' : ''}`}>
          <div className="t">① 调整参观顺序</div>
          <div className="d">按新无障碍路线先看可达展厅，保留重点展品，{analysis.delayMin > 0 ? `预计延误 ${analysis.delayMin} 分钟` : '几乎不延误'}。</div>
          <button className="btn sm" disabled={!analysis.options.reorder}
            onClick={() => resolveReroute(visit.id, 'reorder', { by })}>
            {analysis.options.reorder ? '接受新路线继续参观' : '当前无可达展厅，建议改期'}
          </button>
        </div>

        <div className="choice-tile">
          <div className="t">② 改期再来</div>
          <div className="d">保留同规格无障碍预约与讲解权益，电梯恢复后优先排班，今日已看展厅与线上讲解照常保留。</div>
          <div className="flex" style={{ gap: 6 }}>
            <input type="date" min={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} style={{ padding: '7px 8px' }} />
            <input type="time" value={time} step={900} onChange={(e) => setTime(e.target.value)} style={{ padding: '7px 8px', maxWidth: 100 }} />
          </div>
          <button className="btn sm gold mt8"
            onClick={() => resolveReroute(visit.id, 'reschedule', {
              rescheduleDate: date,
              rescheduleArrivalMin: (() => { const [h, m] = time.split(':').map(Number); return h * 60 + m })(),
              by
            })}>
            确认改期
          </button>
        </div>

        <div className="choice-tile">
          <div className="t">③ 取消本次讲解</div>
          <div className="d">保留无障碍路线与楼层定点协助自行参观，服务台发放自助讲解器；无法到达展厅改线上讲解补充。</div>
          <button className="btn sm danger"
            onClick={() => resolveReroute(visit.id, 'cancel_guide', { by })}>
            仅取消人工讲解
          </button>
        </div>
      </div>
    </div>
  )
}
