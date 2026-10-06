import { HALLS } from '../data/museum'
import type { RoutePlan, RouteSeg } from '../types'
import { fmtDist, fmtMin, fmtRange } from '../utils'
import { crowdLabel } from '../lib/planner'
import { Badge, Notice } from './ui'

const KIND_ICON: Record<RouteSeg['kind'], string> = { flat: '→', ramp: '⤴', elevator: '🛗' }

function segClass(s: RouteSeg): string {
  if (s.kind === 'elevator') return 'elev'
  if (s.kind === 'ramp') return 'ramp'
  if (s.isRest) return 'rest'
  if (s.distance === 0 && s.title?.startsWith('参观讲解')) return 'hall'
  return ''
}

function segName(s: RouteSeg): string {
  if (s.distance === 0 && s.from === s.to) return s.title ?? '馆内停留'
  return `${s.from} → ${s.to}`
}

export default function RouteTimeline({ plan, visitedHallIds = [] }: { plan: RoutePlan; visitedHallIds?: string[] }) {
  const visited = new Set(visitedHallIds)
  return (
    <div className="card">
      <div className="flex between">
        <h2 style={{ margin: 0 }}>分段无障碍路线 <Badge tone="brand">v{plan.version}</Badge></h2>
        <span className="small muted">生成于 {new Date(plan.generatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
      </div>
      <p className="sub">
        {plan.startNode}出发，{fmtMin(plan.arrivalMin)} 入馆，{fmtMin(plan.endMin)} 前回到{plan.endNode} ·
        全程约 <b>{fmtDist(plan.totalDistance)}</b> · 步行/移动约 {plan.totalWalkMin} 分钟 · 含观展共 {plan.totalMin} 分钟
      </p>

      {plan.reduced && <Notice kind="warn">因观众身体不适，本版路线已缩减展厅数量并加密休息点，工作人员将全程关注状态。</Notice>}

      <div className="timeline mt12">
        {plan.segments.map((s) => (
          <div key={s.id} className={`seg ${segClass(s)}`}>
            <span className="dot">{s.distance === 0 && s.title?.startsWith('参观讲解') ? '★' : KIND_ICON[s.kind]}</span>
            <div className="seg-head">
              <b>{segName(s)}</b>
              <span className="seg-time">
                {s.distance > 0 ? `约 ${fmtMin(s.arriveMin)} 到达 · ` : ''}{fmtRange(s.arriveMin - s.walkMin, s.arriveMin)}
              </span>
            </div>
            <div className="seg-body">
              {s.distance > 0 && (
                <>
                  {s.kind === 'elevator' ? '电梯移动' : '步行'} {fmtDist(s.distance)} · 约 {s.walkMin} 分钟
                  {s.maxSlope !== undefined && <> · 最大坡度 <b>{s.maxSlope}%</b>（{s.maxSlope >= 8 ? '较陡，需协助' : '缓坡'}）</>}
                  {s.via.length > 0 && <> · 途经：{s.via.join('、')}</>}
                </>
              )}
              {s.distance === 0 && s.stayMin ? `停留约 ${s.stayMin} 分钟` : null}
            </div>
            <div className="seg-meta">
              {s.restNode && <Badge tone="green">🪑 休息点：{s.restNode}</Badge>}
              {s.toiletNode && <Badge tone="blue">🚻 无障碍卫生间：{s.toiletNode}</Badge>}
              {s.kind === 'elevator' && <Badge tone="blue">🛗 垂直通行</Badge>}
              {s.kind === 'ramp' && <Badge tone="gold">♿ 坡道 {s.maxSlope}%</Badge>}
            </div>
            {s.title && s.distance > 0 && <div className="seg-title">📍 {s.title}{s.stayMin ? `（约 ${s.stayMin} 分钟）` : ''}</div>}
            {s.assist && <div className="seg-assist">🤝 协助：{s.assist}</div>}
            {s.warning && <div className="seg-warn">⚠️ {s.warning}</div>}
          </div>
        ))}
      </div>

      {plan.stops.length > 0 && (
        <>
          <hr className="divider" />
          <h3>各展厅预计到达时间（展厅工作人员接应）</h3>
          {plan.stops.map((st) => {
            const h = HALLS.find((x) => x.id === st.hallId)!
            const c = crowdLabel(st.crowd)
            const color = c.tone === 'bad' ? '#b4372a' : c.tone === 'warn' ? '#b07a1c' : '#2e7d43'
            const isVisited = visited.has(st.hallId)
            return (
              <div key={st.hallId} className={`eta-card ${isVisited ? 'visited' : ''}`}>
                <div className="flex between">
                  <span className="t">{h.name}{isVisited && <Badge tone="green">✅ 已参观</Badge>}</span>
                  <span className="small">预计到达 <b style={{ fontSize: '1rem' }}>{fmtMin(st.arriveMin)}</b>（{fmtRange(st.arriveMin, st.leaveMin)}）</span>
                </div>
                <div className="flex mt8 small muted" style={{ gap: 12 }}>
                  <span className="flex" style={{ gap: 6 }}>
                    拥挤度
                    <span className="crowdbar" style={{ width: 110 }}><i style={{ width: `${st.crowd * 100}%`, background: color }} /></span>
                    {Math.round(st.crowd * 100)}% · {c.text}
                  </span>
                </div>
                <div className="seg-assist mt8">🤝 {st.assist}</div>
              </div>
            )
          })}
        </>
      )}

      {plan.skipped.length > 0 && (
        <>
          <hr className="divider" />
          <h3>本次未排入的展区与原因</h3>
          {plan.skipped.map((sk) => {
            const h = HALLS.find((x) => x.id === sk.hallId)
            return (
              <div key={sk.hallId} className="notice info">
                <span className="ic">⤵</span>
                <div><b>{h?.name ?? sk.hallId}</b>：{sk.reason}</div>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
