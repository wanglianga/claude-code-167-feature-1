import { useState } from 'react'
import { useStore } from '../store'
import { HALLS } from '../data/museum'
import { Badge, Notice } from './ui'
import { fmtMin } from '../utils'
import type { RecoveryChoice, Visit } from '../types'

const CHOICE_META: Record<RecoveryChoice, { label: string; desc: string }> = {
  reorder: { label: '按新顺序继续参观', desc: '保留可到达的重点展厅，工作人员在备用电梯与坡道接应，看完再离馆' },
  reschedule: { label: '改期再来', desc: '今日已看内容与线上讲解码保留，改约日期可快速入馆，不重复收费/登记' },
  cancel_guide: { label: '改为线上讲解', desc: '保留无障碍路线、轮椅与现场协助，取消今日讲解员，未达展厅发云讲解码' }
}

function tomorrowISO(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const hallName = (id: string) => HALLS.find((h) => h.id === id)?.name ?? id
const hallShort = (id: string) => hallName(id).split(' · ')[1] ?? hallName(id)

export default function RouteRecoveryPanel({ visit }: { visit: Visit }) {
  const chooseRecovery = useStore((s) => s.chooseRecovery)
  const setPreferredHalls = useStore((s) => s.setPreferredHalls)
  const [showActions, setShowActions] = useState(false)
  const [newDate, setNewDate] = useState(tomorrowISO())
  const [confirmCancel, setConfirmCancel] = useState(false)

  const plan = visit.route
  const d = plan?.disruption
  if (!plan || !d) return null
  if (visit.status === 'cancelled' || visit.status === 'completed') return null

  const decision = visit.recovery
  // 决定之后若路线又被重算（如另一部电梯再故障），允许观众重新选择
  const planNewerThanDecision = decision && new Date(plan.generatedAt).getTime() > new Date(decision.at).getTime() + 1000
  const decided = decision && !planNewerThanDecision

  const preferred = new Set(visit.party.preferredHallIds ?? [])
  const toggleCandidate = (hallId: string) => {
    const cur = visit.party.preferredHallIds ?? []
    const next = cur.includes(hallId) ? cur.filter((x) => x !== hallId) : [...cur, hallId]
    setPreferredHalls(visit.id, next)
  }

  return (
    <div className="card recovery-card">
      <div className="flex between">
        <h2 style={{ margin: 0 }}>🛗 现场路线调整通知 <Badge tone="red">不是取消服务，已为您重新安排</Badge></h2>
        <Badge tone="brand">路线 v{plan.version}（替代 v{d.prevVersion}）</Badge>
      </div>
      <p className="sub" style={{ marginTop: 8 }}><b>{d.trigger}</b>。服务台已同步保留处理结果，下面是失效原因、新路线和您可以选择的安排。</p>

      {/* —— 失效原因 —— */}
      <div className="recovery-reasons">
        {d.reasons.map((r, i) => (
          <div key={i} className="recovery-reason"><span className="ic">📢</span><span>{r}</span></div>
        ))}
      </div>

      {/* —— 四项重算结果 —— */}
      <div className="grid4 recovery-stats">
        <div className="stat">
          <b className={d.delayMin > 0 ? 'danger-text' : ''}>{d.delayMin > 0 ? `+${d.delayMin} 分钟` : '不额外延误'}</b>
          <span>预计延误（含绕行/候梯）</span>
        </div>
        <div className="stat">
          <b className={d.needStaffPush ? '' : 'green-text'}>{d.needStaffPush ? '需要推行' : '无需推行'}</b>
          <span>工作人员协助{visit.party.usesWheelchair || visit.party.borrowWheelchair ? '（轮椅）' : ''}</span>
        </div>
        <div className="stat">
          <b>{d.keptHalls.length} 个</b>
          <span>保留的原计划/重点展厅</span>
        </div>
        <div className="stat">
          <b className={d.extraDistance > 0 ? 'danger-text' : d.extraDistance < -20 ? 'green-text' : ''}>
            {d.extraDistance > 0 ? `+${d.extraDistance} 米` : d.extraDistance < -20 ? `少走 ${Math.abs(d.extraDistance)} 米` : '步行相近'}
          </b>
          <span>步行距离变化</span>
        </div>
      </div>
      {d.needStaffPush && (
        <div className="small muted" style={{ marginTop: -6 }}>
          🤝 推行安排：{d.pushReasons.join('；')}。请在备用电梯厅稍候，佩戴黄袖标的工作人员会主动上前，无需您开口求助。
        </div>
      )}

      {/* —— 失效展区 —— */}
      {d.affectedHalls.length > 0 && (
        <>
          <hr className="divider" />
          <h3>本次暂时看不了的展区与原因</h3>
          {d.affectedHalls.map((a) => (
            <div key={a.hallId} className="notice warn" style={{ marginBottom: 6 }}>
              <span className="ic">🚧</span>
              <div><b>{hallName(a.hallId)}</b><div className="small">{a.reason}</div></div>
            </div>
          ))}
        </>
      )}

      {/* —— 替代展区 + 可加选 —— */}
      {(d.substitutedHalls.length > 0 || d.candidates.length > 0) && (
        <>
          <hr className="divider" />
          <h3>可替代展区（同楼层、少绕行）</h3>
          {d.substitutedHalls.map((s) => {
            const h = HALLS.find((x) => x.id === s.hallId)!
            return (
              <div key={s.hallId} className="notice ok" style={{ marginBottom: 6 }}>
                <span className="ic">🔄</span>
                <div>
                  <b>已为您改排：{hallName(s.hallId)}</b>（替代 {hallShort(s.forHallId)}）
                  <div className="small">重点展品：{h.highlights.join('、')}；{s.reason}</div>
                </div>
              </div>
            )
          })}
          {d.candidates.length > 0 && (
            <div className="small muted mt8">还想加上哪个展区？勾选后立即按"重点优先"再排一次（不影响已选安排）：</div>
          )}
          {d.candidates.map((c) => (
            <label key={c.hallId} className={`candidate-row ${preferred.has(c.hallId) ? 'on' : ''}`}>
              <input type="checkbox" checked={preferred.has(c.hallId)} onChange={() => toggleCandidate(c.hallId)} />
              <span>
                <b>{hallName(c.hallId)}</b>
                <span className="small muted"> · {c.reason}</span>
              </span>
            </label>
          ))}
        </>
      )}

      {/* —— 线上讲解 —— */}
      {d.onlineHalls.length > 0 && (
        <>
          <hr className="divider" />
          <h3>📱 线上云讲解补充（7 天内可回看）</h3>
          <div className="badges">
            {d.onlineHalls.map((id) => (
              <Badge key={id} tone="blue">{hallShort(id)}：{HALLS.find((h) => h.id === id)?.onlineCode}</Badge>
            ))}
          </div>
          <p className="small muted mt8">扫码或在公众号输入编号即可观看策展人导览视频与重点展品特写，改期再到馆无需重复预约。</p>
        </>
      )}

      {/* —— 新参观收益 —— */}
      <hr className="divider" />
      <h3>✨ 调整后您依然能获得的参观收益</h3>
      <ul className="benefit-list">
        {d.benefits.map((b, i) => <li key={i}>✅ {b}</li>)}
      </ul>

      {/* —— 已决定状态 —— */}
      {decided ? (
        <div className="recovery-decided">
          <Notice kind="ok">
            您已选择【{CHOICE_META[decision.choice].label}】（{new Date(decision.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}）
            {decision.choice === 'reschedule' && decision.note ? <>，新日期：<b>{decision.note} {fmtMin(visit.baseArrivalMin)}</b></> : null}
            {decision.choice === 'cancel_guide' ? <>，未达展厅的云讲解码已在上边发放</> : null}
          </Notice>
          {decision.handledBy ? (
            <p className="small green-text" style={{ color: 'var(--green)', margin: '6px 0 0' }}>
              ✅ 服务台{decision.handledBy}已于 {new Date(decision.handledAt!).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} 受理并确认安排，如有疑问请到一层服务台或致电咨询。
            </p>
          ) : (
            <p className="small muted" style={{ margin: '6px 0 0' }}>⏳ 服务台正在受理您的选择，工作人员会当面或电话与您确认（本页与馆内工作台同步）。</p>
          )}
          <button className="btn ghost sm mt8" onClick={() => setShowActions((v) => !v)}>
            {showActions ? '收起' : '情况有变化，我想重新选择'}
          </button>
        </div>
      ) : (
        planNewerThanDecision && (
          <Notice kind="warn">您选择后现场情况再次变化（{d.trigger}），请在下方重新确认安排。</Notice>
        )
      )}

      {/* —— 三个选择 —— */}
      {(!decided || showActions) && (
        <div className="recovery-actions">
          <hr className="divider" />
          <h3>请选择接下来的安排（结果会直接同步给服务台与各楼层工作人员）</h3>
          <div className="recovery-choice-grid">
            <button className="recovery-choice primary" onClick={() => { chooseRecovery(visit.id, 'reorder'); setShowActions(false) }}>
              <b>① {CHOICE_META.reorder.label}</b>
              <span>{CHOICE_META.reorder.desc}</span>
            </button>
            <div className="recovery-choice">
              <b>② {CHOICE_META.reschedule.label}</b>
              <span>{CHOICE_META.reschedule.desc}</span>
              <div className="flex" style={{ gap: 6, marginTop: 8 }}>
                <input type="date" min={tomorrowISO()} value={newDate} onChange={(e) => setNewDate(e.target.value)} style={{ padding: '8px 10px' }} />
                <button className="btn sm" disabled={!newDate} onClick={() => { chooseRecovery(visit.id, 'reschedule', newDate); setShowActions(false) }}>确认改期</button>
              </div>
            </div>
            <div className="recovery-choice">
              <b>③ {CHOICE_META.cancel_guide.label}</b>
              <span>{CHOICE_META.cancel_guide.desc}</span>
              {!confirmCancel ? (
                <button className="btn sm danger" style={{ marginTop: 8 }} onClick={() => setConfirmCancel(true)}>我要取消今日讲解</button>
              ) : (
                <div className="flex" style={{ gap: 6, marginTop: 8 }}>
                  <button className="btn sm" onClick={() => { chooseRecovery(visit.id, 'cancel_guide'); setConfirmCancel(false); setShowActions(false) }}>确认（路线/轮椅/协助保留）</button>
                  <button className="btn sm ghost" onClick={() => setConfirmCancel(false)}>再想想</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
