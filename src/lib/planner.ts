import { EDGES, ELEVATORS, HALLS, HALL_FLOOR_STAFF_CAPACITY, HOURS, NODES, TOTAL_PARKING, TOTAL_WHEELCHAIRS } from '../data/museum'
import type {
  Edge, Floor, GraphNode, HallInfo, HallStop, PartyProfile, RerouteAnalysis, RoutePlan, RouteSeg, Staff, Visit
} from '../types'
import { fmtMin, uid } from '../utils'

// —— 现场实时信号（工作人员可调整）——
export interface LiveSignals {
  elevatorsDown: string[] // 故障电梯 id
  closedHalls: string[] // 临时闭展 hall id
  crowdOverride: Record<string, number> // 人工设定的拥挤度 0..1
  staffExtraLeave: string[] // 临时请假 staff id
  wheelchairOffset: number // 额外不可用（报修/消毒）为正；提前归还为负
  visitorUnwell: boolean // 观众身体不适 → 缩减路线、加强休息
  lateMin: number // 观众迟到分钟
}

export const DEFAULT_SIGNALS: LiveSignals = {
  elevatorsDown: [],
  closedHalls: [],
  crowdOverride: {},
  staffExtraLeave: [],
  wheelchairOffset: 0,
  visitorUnwell: false,
  lateMin: 0
}

export function signalSnapshot(s: LiveSignals): string {
  return JSON.stringify({
    e: [...s.elevatorsDown].sort(),
    c: [...s.closedHalls].sort(),
    cr: Object.fromEntries(Object.entries(s.crowdOverride).sort()),
    l: [...s.staffExtraLeave].sort(),
    w: s.wheelchairOffset,
    u: s.visitorUnwell
  })
}

const nodeMap = new Map<string, GraphNode>(NODES.map((n) => [n.id, n] as [string, GraphNode]))
const hallMap = new Map<string, HallInfo>(HALLS.map((h) => [h.id, h] as [string, HallInfo]))

const REST_NODE: Record<Floor, string> = { [-1]: 'rB1', 1: 'r1', 2: 'r2', 3: 'r3' }
const WC_NODE: Record<Floor, string> = { [-1]: 'wcB1', 1: 'wc1', 2: 'wc2', 3: 'wc3' }
const HALL_FLOOR: Record<string, Floor> = { hA: -1, hB: -1, hC: 2, hD: 2, hE: 3, hF: 3 }

interface Adj {
  edge: Edge
  to: string
}

function buildAdj(elevatorsDown: string[]): Map<string, Adj[]> {
  const adj = new Map<string, Adj[]>()
  for (const n of NODES) adj.set(n.id, [])
  for (const e of EDGES) {
    if (e.kind === 'elevator' && e.elevatorId && elevatorsDown.includes(e.elevatorId)) continue
    adj.get(e.a)!.push({ edge: e, to: e.b })
    adj.get(e.b)!.push({ edge: e, to: e.a })
  }
  return adj
}

function dijkstra(adj: Map<string, Adj[]>, from: string, to: string): string[] | null {
  if (from === to) return [from]
  const dist = new Map<string, number>([[from, 0]])
  const prev = new Map<string, string>()
  const visited = new Set<string>()
  const nodes = NODES.map((n) => n.id)
  for (let k = 0; k < nodes.length; k++) {
    let u: string | null = null
    let best = Infinity
    for (const id of nodes) {
      if (visited.has(id)) continue
      const d = dist.get(id) ?? Infinity
      if (d < best) { best = d; u = id }
    }
    if (u === null || u === to) break
    visited.add(u)
    for (const { edge, to: v } of adj.get(u)!) {
      const w = edge.kind === 'elevator' ? 14 : edge.distance // 乘梯综合代价（等候+乘坐）
      const nd = (dist.get(u) ?? Infinity) + w
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd)
        prev.set(v, u)
      }
    }
  }
  if (!prev.has(to) && from !== to) return null
  const path = [to]
  let cur = to
  while (cur !== from) {
    cur = prev.get(cur)!
    if (!cur) return null
    path.unshift(cur)
  }
  return path
}

// 确定性拥挤度：日常双峰（10:30 / 14:30）+ 展厅差异 + 人工覆盖
function gauss(x: number, mu: number, sigma: number): number {
  const d = x - mu
  return Math.exp(-(d * d) / (2 * sigma * sigma))
}
function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997
  return h
}
export function crowdAt(hallId: string, min: number, override?: Record<string, number>): number {
  if (override && override[hallId] !== undefined) return override[hallId]
  const h = hallMap.get(hallId)!
  const wave = 0.55 + 0.45 * Math.max(gauss(min, 10 * 60 + 30, 55), gauss(min, 14 * 60 + 30, 60))
  const jitter = (hashStr(hallId) % 9) / 100
  return Math.min(0.98, Math.max(0.05, h.popularity * wave + jitter - 0.04))
}

export function crowdLabel(c: number): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (c >= 0.8) return { text: '过度拥挤', tone: 'bad' }
  if (c >= 0.6) return { text: '较拥挤', tone: 'warn' }
  if (c >= 0.35) return { text: '适中', tone: 'ok' }
  return { text: '宽松', tone: 'ok' }
}

interface PlanCtx {
  adj: Map<string, Adj[]>
  party: PartyProfile
  signals: LiveSignals
  speed: number // 米/分钟
  lowStamina: boolean
  usesChair: boolean
  walkBudget: number
  notices: string[]
  floorOccupancy: Map<string, number> // floor-window → 已有接应组数
}

type EndpointMeta = { node: string; stay: number; title: string; toilet?: string; rest?: string }

function edgeBetween(path: string[], i: number): Edge {
  return EDGES.find((e) => (e.a === path[i] && e.b === path[i + 1]) || (e.b === path[i] && e.a === path[i + 1]))!
}

/** 把一条节点路径切分为带说明的路段：连续步行合并，连续乘梯合并 */
function legSegments(path: string[], t0: number, ctx: PlanCtx, endpointMeta?: EndpointMeta[]) {
  const segs: RouteSeg[] = []
  const edgeIds: string[] = []
  let t = t0
  let dist = 0

  const runs: string[][] = []
  let run = [path[0]]
  let runClass: 'walk' | 'elev' = edgeBetween(path, 0).kind === 'elevator' ? 'elev' : 'walk'
  for (let i = 0; i < path.length - 1; i++) {
    const cls: 'walk' | 'elev' = edgeBetween(path, i).kind === 'elevator' ? 'elev' : 'walk'
    if (cls !== runClass) {
      runs.push(run)
      run = [path[i]]
      runClass = cls
    }
    run.push(path[i + 1])
  }
  runs.push(run)

  for (const g of runs) {
    const fromId = g[0]
    const toId = g[g.length - 1]
    const via = g.slice(1, -1)
    let d = 0
    let maxSlope: number | undefined
    let elevEdges = 0
    let elevId: string | undefined
    const elevFloorsSet = new Set<Floor>()
    for (let i = 0; i < g.length - 1; i++) {
      const edge = EDGES.find((e) => (e.a === g[i] && e.b === g[i + 1]) || (e.b === g[i] && e.a === g[i + 1]))!
      edgeIds.push(edge.id)
      d += edge.distance
      if (edge.slope !== undefined) maxSlope = Math.max(maxSlope ?? 0, edge.slope)
      if (edge.kind === 'elevator') {
        elevEdges += 1
        elevId = edge.elevatorId
        elevFloorsSet.add(nodeMap.get(g[i])!.floor)
        elevFloorsSet.add(nodeMap.get(g[i + 1])!.floor)
      }
    }
    const elevFloors = Array.from(elevFloorsSet).sort((a, b) => a - b)

    let walkMin: number
    let warning: string | undefined
    let assist: string | undefined
    const kind: RouteSeg['kind'] = elevEdges > 0 ? 'elevator' : maxSlope !== undefined ? 'ramp' : 'flat'
    if (elevEdges > 0) {
      // 仅余一部电梯运行时，候梯与错层停靠时间增加（确定性）
      const singleElev = ctx.signals.elevatorsDown.length === ELEVATORS.length - 1
      walkMin = (singleElev ? 3 : 1.5) + 2 * elevEdges // 候梯 + 乘梯
      const evName = ELEVATORS.find((e) => e.id === elevId)?.name ?? '电梯'
      const floorText = elevFloors.map((f) => (f < 0 ? 'B1' : `F${f}`)).join(' → ')
      assist = `乘坐${evName}（${floorText}），陪同人员协助按键、挡门与进出`
      if (elevId && ctx.signals.elevatorsDown.includes(elevId)) warning = '该电梯曾报故障，请现场确认运行状态'
    } else {
      let factor = 1
      if (maxSlope !== undefined && maxSlope >= 6) factor *= ctx.usesChair ? 1.25 : 1.4
      walkMin = d / ctx.speed / factor
      if (maxSlope !== undefined) {
        if (ctx.usesChair) assist = `坡道坡度 ${maxSlope}%，陪同人员推行、上坡注意倒退助力`
        else if (ctx.lowStamina) warning = `坡道坡度 ${maxSlope}%，请扶扶手放慢脚步`
      }
    }
    t += walkMin
    dist += d

    const toNode = nodeMap.get(toId)!
    const isRestNode = toNode.kind === 'rest'
    const isToiletNode = toNode.kind === 'toilet'
    const meta = endpointMeta?.find((x) => x.node === toId)
    segs.push({
      id: uid('seg'),
      from: nodeMap.get(fromId)!.name,
      to: toNode.name,
      via: via.map((v) => nodeMap.get(v)!.name),
      kind,
      distance: Math.round(d),
      maxSlope,
      walkMin: Math.round(walkMin * 10) / 10,
      arriveMin: Math.round(t),
      warning,
      assist,
      isRest: meta?.rest !== undefined || isRestNode,
      restNode: meta?.rest !== undefined || isRestNode ? toNode.name : undefined,
      toiletNode: meta?.toilet !== undefined || isToiletNode ? toNode.name : undefined,
      stayMin: meta?.stay,
      title: meta?.title
    })
    if (meta?.stay) t += meta.stay
  }
  return { segs, t, dist, edgeIds }
}

function pathLeg(ctx: PlanCtx, from: string, to: string, t: number, metas?: EndpointMeta[]) {
  const path = dijkstra(ctx.adj, from, to)
  if (!path) return null
  return legSegments(path, t, ctx, metas)
}

function returnReserve(ctx: PlanCtx, fromHall: string): number {
  const path = dijkstra(ctx.adj, fromHall, 'desk')
  if (!path) return Infinity
  let min = 0
  let d = 0
  for (let i = 0; i < path.length - 1; i++) {
    const edge = edgeBetween(path, i)
    if (edge.kind === 'elevator') min += ctx.signals.elevatorsDown.length === ELEVATORS.length - 1 ? 5 : 3
    else d += edge.distance
  }
  min += d / ctx.speed
  if (ctx.lowStamina) min += 10
  return min
}

// —— 设备 / 车位可用性 ——
export function wheelchairAvailable(signals: LiveSignals, visits: Visit[], date: string, selfId?: string): number {
  const reserved = visits.filter(
    (v) => v.id !== selfId && v.date === date && v.status !== 'cancelled' && v.party.borrowWheelchair
  ).length
  const loaned = visits
    .filter((v) => v.id !== selfId && v.date === date && v.status !== 'cancelled')
    .reduce((n, v) => n + v.loans.filter((l) => l.loanedAt && !l.returnedAt).length, 0)
  return Math.max(0, TOTAL_WHEELCHAIRS - signals.wheelchairOffset - Math.max(reserved, loaned))
}

export function parkingAvailable(visits: Visit[], date: string, selfId?: string): number {
  const used = visits.filter(
    (v) => v.id !== selfId && v.date === date && v.status !== 'cancelled' && v.party.needParking
  ).length
  return Math.max(0, TOTAL_PARKING - used)
}

function staffBusyWindows(v: Visit): Array<[number, number]> {
  if (!v.route) return []
  return [[v.route.arrivalMin - 10, v.route.endMin + 10]]
}

export function pickEscort(
  party: PartyProfile,
  date: string,
  startMin: number,
  endMin: number,
  staff: Staff[],
  visits: Visit[],
  signals: LiveSignals,
  selfId?: string
): { id?: string; name?: string; kind?: '讲解员' | '志愿者'; issue?: string } {
  const need = party.needSign || party.needSlow || party.usesWheelchair || party.borrowWheelchair || !party.canStandLong || party.hasElder
  if (!need) return {}
  const onLeave = (s: Staff) => s.onLeave.includes(date) || signals.staffExtraLeave.includes(s.id)
  const overlap = (s: Staff) =>
    visits.some(
      (v) =>
        v.id !== selfId && v.date === date && v.status !== 'cancelled' && v.escortId === s.id &&
        staffBusyWindows(v).some(([a, b]) => startMin < b && endMin > a)
    )
  const candidates = staff.filter(
    (s) => !onLeave(s) && s.shiftStartMin <= startMin && s.shiftEndMin >= endMin && !overlap(s)
  )
  const score = (s: Staff): number => {
    let x = 0
    if (s.role === '讲解员') x += 3
    if (party.needSign && s.skills.includes('sign')) x += 6
    if (party.needSlow && s.skills.includes('slow')) x += 3
    if ((party.usesWheelchair || party.borrowWheelchair) && s.skills.includes('wheelchair')) x += 3
    if (party.hasChild && s.role === '志愿者') x += 1
    return x
  }

  if (party.needSign) {
    const signer = candidates.filter((s) => s.skills.includes('sign')).sort((a, b) => score(b) - score(a))[0]
    if (signer) return { id: signer.id, name: signer.name, kind: signer.role }
    const reason = staff.some((s) => s.skills.includes('sign') && onLeave(s))
      ? '当日手语讲解员临时请假'
      : '手语讲解员该时段排班已约满'
    const volunteer = candidates.sort((a, b) => score(b) - score(a))[0]
    return {
      id: volunteer?.id, name: volunteer?.name, kind: volunteer?.role,
      issue: `${reason}：改由${volunteer ? volunteer.role + volunteer.name + '陪同并配合图文讲解卡' : '服务台提供图文讲解卡（暂无陪同余量）'}，正式手语讲解建议提前 3 天预约`
    }
  }

  const best = candidates.sort((a, b) => score(b) - score(a))[0]
  if (best) return { id: best.id, name: best.name, kind: best.role }
  return {
    issue: '讲解员当日请假/排班已满，暂无陪同余量：服务台将发放自助讲解器，每层展厅工作人员可提供定点协助'
  }
}

export interface PlanInput {
  party: PartyProfile
  date: string
  arrivalMin: number
  signals: LiveSignals
  visits: Visit[]
  staff: Staff[]
  selfId?: string
  version?: number
  /** 参观进行中接续重算：观众当前所在节点 id（给出则跳过入馆段，直接从该点继续） */
  continuationStart?: string
  /** 接续开始时刻（当日分钟数，通常为故障发生/处置时刻） */
  continuationAtMin?: number
  /** 接续前已完成参观的展厅 id（作为既有成果保留，不再重排） */
  completedHalls?: string[]
  /** 接续前已完成展厅的接应信息（保留在时间线/看板中并标记完成） */
  completedStops?: HallStop[]
  /** 观众选择取消讲解：仅保留自助无障碍路线，不安排讲解员/志愿者陪同 */
  noEscort?: boolean
}

export function planRoute(input: PlanInput): RoutePlan {
  const { party, signals, visits, staff, selfId } = input
  const version = input.version ?? 1
  const notices: string[] = []
  const adj = buildAdj(signals.elevatorsDown)

  // —— 参观进行中的接续重算：从当前位置继续，保留已完成展厅 ——
  const continuation = !!input.continuationStart
  const startNodeId = input.continuationStart ?? 'entrance'
  const completedHalls = new Set(input.completedHalls ?? [])
  const startNodeInfo = nodeMap.get(startNodeId)

  const usesChair = party.usesWheelchair || party.borrowWheelchair
  const lowStamina = usesChair || !party.canStandLong || party.hasElder
  const speed = usesChair ? 48 : party.needSlow || party.hasElder ? 42 : 60
  const walkBudget = signals.visitorUnwell ? 350 : usesChair ? 2400 : lowStamina ? 700 : 1500

  const ctx: PlanCtx = {
    adj, party, signals, speed, lowStamina, usesChair, walkBudget, notices,
    floorOccupancy: new Map()
  }

  // 已有预约对楼层接应能力的占用
  for (const v of visits) {
    if (v.id === selfId || v.date !== input.date || v.status === 'cancelled' || !v.route) continue
    for (const st of v.route.stops) {
      const f = HALL_FLOOR[st.hallId]
      const key = `${f}:${Math.floor(st.arriveMin / 30)}`
      ctx.floorOccupancy.set(key, (ctx.floorOccupancy.get(key) ?? 0) + 1)
    }
  }

  const arrivalMin = continuation
    ? Math.max(HOURS.openMin, input.continuationAtMin ?? input.arrivalMin + signals.lateMin)
    : Math.max(HOURS.openMin, input.arrivalMin + signals.lateMin)
  if (!continuation && signals.lateMin > 0) notices.push(`观众迟到约 ${signals.lateMin} 分钟，已将入馆与各段接应时间顺延，自 ${fmtMin(arrivalMin)} 起算`)
  if (signals.visitorUnwell) notices.push('⚠ 观众反馈身体不适：已缩减为最近的 1–2 个展厅、加长休息，服务台备轮椅与医药箱')
  if (continuation) {
    notices.push(`路线接续：观众当前位于${startNodeInfo?.name ?? '馆内'}，自 ${fmtMin(arrivalMin)} 起按现场最新情况重排剩余参观，已完成展厅照常保留`)
  }

  // —— 轮椅库存 ——（接续重算时设备已在服务台办理，不再重复提示）
  const availW = wheelchairAvailable(signals, visits, input.date, selfId)
  let wheelchairIssue: string | undefined
  if (!continuation) {
    if (party.borrowWheelchair && availW <= 0) {
      wheelchairIssue = '馆方轮椅库存暂不足：已登记排队并优先调剂，路线按"多休息点、最短步行"生成；服务台可提供折叠凳'
      notices.push('⚠ ' + wheelchairIssue)
    } else if (party.borrowWheelchair) {
      notices.push(`轮椅库存充足（余 ${availW} 台），入馆后在服务台凭证领取`)
    }
    if (!party.borrowWheelchair && !party.usesWheelchair && lowStamina) {
      notices.push('温馨提示：根据"不能长时间站立/有老人"的情况，服务台可免费借用轮椅或折叠凳')
    }
  }

  // —— 无障碍车位 ——（接续时车辆已停放/已落客，不再提示）
  let parkingSlot: string | undefined
  let parkingIssue: string | undefined
  if (!continuation && party.needParking) {
    const used = TOTAL_PARKING - parkingAvailable(visits, input.date, selfId)
    if (used < TOTAL_PARKING) {
      parkingSlot = `P-${String(used + 1).padStart(2, '0')}`
      notices.push(`无障碍车位已预留：${parkingSlot}（B1 临近电梯）`)
    } else {
      parkingIssue = '近距离无障碍车位已约满：车辆可在正门落客区临时停靠（志愿者接应），社会车位 B2 仍有空余'
      notices.push('⚠ ' + parkingIssue)
    }
  }

  // —— 电梯故障提示 ——
  for (const id of signals.elevatorsDown) {
    const ev = ELEVATORS.find((e) => e.id === id)!
    const other = ELEVATORS.find((e) => e.id !== id)
    notices.push(`⚠ ${ev.name}临时故障，全程改走${other?.name ?? '备用通道'}，部分展厅可能需要绕行`)
  }

  const segs: RouteSeg[] = []
  const stops: HallStop[] = []
  const skipped: Array<{ hallId: string; reason: string }> = []
  const trace: string[] = []
  let t = arrivalMin
  let walkUsed = 0

  // 起点：接续重算 → 观众当前位置；否则 停车场 → 坡道入口 → 服务台
  let curNode = 'entrance'
  if (continuation) {
    curNode = startNodeId
    segs.push({
      id: uid('seg'), from: startNodeInfo?.name ?? '当前位置', to: startNodeInfo?.name ?? '当前位置', via: [],
      kind: 'flat', distance: 0, walkMin: 0, arriveMin: Math.round(t), stayMin: 0,
      title: `观众当前位置 · 路线接续起点（${startNodeInfo?.name ?? ''}）`
    })
  } else {
    if (party.needParking) {
      const leg = pathLeg(ctx, 'parking', 'entrance', t)
      if (!leg) {
        notices.push('⚠ 停车场通道暂不可用，请由正门落客区进入')
      } else {
        segs.push(...leg.segs); trace.push(...leg.edgeIds); t = leg.t; walkUsed += leg.dist
      }
    }
    const checkinStay = 10 + (party.borrowWheelchair && availW > 0 ? 5 : 0)
    const inLeg = pathLeg(ctx, curNode, 'desk', t, [
      { node: 'desk', stay: checkinStay, title: '服务台核验预约、安检与设备发放' }
    ])
    if (inLeg) {
      const last = inLeg.segs[inLeg.segs.length - 1]
      if (last) {
        last.assist = `服务台核验预约${party.borrowWheelchair && availW > 0 ? '、借出轮椅并调试刹车脚踏' : ''}${party.needParking ? '、登记车位' : ''}`
      }
      segs.push(...inLeg.segs); trace.push(...inLeg.edgeIds); t = inLeg.t; walkUsed += inLeg.dist
      curNode = 'desk'
    }
  }

  // —— 展厅选择：按楼层从低到高；带儿童优先自然馆 ——
  const budgetHalls = signals.visitorUnwell ? 2 : lowStamina ? 3 : 6
  // 接续重算时，已完成展厅占用既有体力/时间预算，剩余额度相应扣减
  const maxHalls = continuation ? Math.max(0, budgetHalls - completedHalls.size) : budgetHalls
  const order = party.hasChild ? ['hF', 'hA', 'hB', 'hC', 'hD', 'hE'] : ['hA', 'hB', 'hC', 'hD', 'hE', 'hF']
  let hallsDone = 0
  // 接续时疲劳/休息节奏把已完成厅数计入（厅间休息不因重算漏掉）
  const fatigueBase = continuation ? completedHalls.size : 0
  let lastToilet = t

  for (const hallId of order) {
    // 接续前已完成的展厅作为参观成果保留：不重排、不计入跳过
    if (continuation && completedHalls.has(hallId)) continue
    if (hallsDone >= maxHalls) { skipped.push({ hallId, reason: '体力/时间预算有限，本次从容参观部分展厅，余下展厅欢迎下次再来' }); continue }
    if (signals.closedHalls.includes(hallId)) { skipped.push({ hallId, reason: '该展区临时闭馆（维护/布展）' }); continue }
    const crowdNow0 = crowdAt(hallId, t, signals.crowdOverride)
    if (crowdNow0 >= 0.8) { skipped.push({ hallId, reason: `预计 ${fmtMin(t)} 该展厅过度拥挤（${Math.round(crowdNow0 * 100)}%），已避开并建议错峰` }); continue }

    const f = HALL_FLOOR[hallId]
    const winKey = `${f}:${Math.floor(t / 30)}`
    const cap = HALL_FLOOR_STAFF_CAPACITY[String(f)] ?? 1
    if ((ctx.floorOccupancy.get(winKey) ?? 0) >= cap) {
      skipped.push({ hallId, reason: `该时段 ${f < 0 ? 'B1' : 'F' + f} 楼层接应位已满，为保证陪同质量暂不排入` })
      continue
    }

    // 途经休息点 / 卫生间
    const metas: EndpointMeta[] = []
    const waypoints: string[] = []
    const fromNode = nodeMap.get(curNode)!
    let wpNode = curNode
    if (lowStamina && curNode !== 'desk' && hallsDone + fatigueBase >= 1) {
      const r = REST_NODE[fromNode.floor]
      if (dijkstra(adj, curNode, r) && dijkstra(adj, r, hallId)) {
        waypoints.push(r)
        metas.push({ node: r, stay: signals.visitorUnwell ? 15 : 10, title: '坐下休息、补水', rest: r })
        wpNode = r
      }
    }
    if (t - lastToilet > 55 && (lowStamina || party.hasElder || party.hasChild)) {
      const wc = WC_NODE[nodeMap.get(wpNode)!.floor]
      if (dijkstra(adj, wpNode, wc) && dijkstra(adj, wc, hallId)) {
        waypoints.push(wc)
        metas.push({ node: wc, stay: 6, title: '途经无障碍卫生间', toilet: wc })
        wpNode = wc
        lastToilet = t
      }
    }

    // 拼路径
    const probe = (() => {
      let from = curNode
      let tt = t
      let dd = 0
      let all: RouteSeg[] = []
      const ids: string[] = []
      for (const wp of [...waypoints, hallId]) {
        const leg = pathLeg(ctx, from, wp, tt, metas.filter((o) => o.node === wp))
        if (!leg) return null
        all = all.concat(leg.segs); ids.push(...leg.edgeIds); tt = leg.t; dd += leg.dist
        from = wp
      }
      return { all, tt, dd, ids }
    })()
    if (!probe) { skipped.push({ hallId, reason: '电梯临时故障导致无法无障碍到达，绕行后仍不可达' }); continue }

    const hinfo = hallMap.get(hallId)!
    let viewMin = hinfo.viewMin
    if (party.needSlow) viewMin = Math.round(viewMin * 1.3)
    if (party.needSign) viewMin = Math.round(viewMin * 1.15)
    if (crowdNow0 >= 0.6) viewMin = Math.round(viewMin * 1.1)
    const reserve = returnReserve(ctx, hallId)
    if (!Number.isFinite(reserve)) { skipped.push({ hallId, reason: '电梯故障后无返回路线' }); continue }
    if (walkUsed + probe.dd > walkBudget) { skipped.push({ hallId, reason: '继续前往将超出观众可承受步行距离，已优先保证体力' }); continue }
    if (probe.tt + viewMin + reserve > HOURS.closeMin - 10) { skipped.push({ hallId, reason: '闭馆前无法从容参观并返回，建议改约更早时段' }); continue }

    segs.push(...probe.all)
    trace.push(...probe.ids)
    t = probe.tt
    walkUsed += probe.dd
    const arriveHall = Math.round(t)
    t += viewMin
    const crowd = crowdAt(hallId, arriveHall, signals.crowdOverride)
    stops.push({
      hallId,
      arriveMin: arriveHall,
      leaveMin: Math.round(t),
      crowd: Math.round(crowd * 100) / 100,
      assist: `${f < 0 ? 'B1' : 'F' + f} 展厅工作人员在${hinfo.name.split(' · ')[0]}入口接应（预计 ${fmtMin(arriveHall)} 到达）${crowd >= 0.6 ? '；现场较拥挤，协助从无障碍观展位进入' : ''}`
    })
    ctx.floorOccupancy.set(winKey, (ctx.floorOccupancy.get(winKey) ?? 0) + 1)
    segs.push({
      id: uid('seg'), from: hinfo.name, to: hinfo.name, via: [],
      kind: 'flat', distance: 0, walkMin: viewMin, arriveMin: Math.round(t),
      stayMin: viewMin,
      title: `参观讲解${party.needSign ? '（手语）' : party.needSlow ? '（慢速）' : ''}`,
      warning: crowd >= 0.6 ? `展厅拥挤度 ${Math.round(crowd * 100)}%，讲解员控制节奏、安排休息座椅` : undefined
    })
    curNode = hallId
    hallsDone += 1
  }

  // —— 收尾：返回服务台（低体力者途经休息点）——
  if (curNode !== 'desk') {
    if (!dijkstra(adj, curNode, 'desk')) {
      notices.push('⚠ 当前所在楼层电梯全部停用，暂无法乘梯返回一层服务台：请在就近休息区稍候，工作人员将全程陪同，并在电梯恢复后第一时间护送离馆；需要离馆可由工作人员联系专人经应急通道协助。')
    }
    const wps: string[] = []
    const ov: EndpointMeta[] = []
    if (lowStamina) {
      const r = REST_NODE[nodeMap.get(curNode)!.floor]
      if (dijkstra(adj, curNode, r) && dijkstra(adj, r, 'desk')) {
        wps.push(r)
        ov.push({ node: r, stay: 8, title: '离馆前休息', rest: r })
      }
    }
    let from = curNode
    for (const wp of [...wps, 'desk']) {
      const leg = pathLeg(ctx, from, wp, t, ov.filter((o) => o.node === wp))
      if (leg) { segs.push(...leg.segs); trace.push(...leg.edgeIds); t = leg.t; walkUsed += leg.dist; from = wp }
    }
    const last = segs[segs.length - 1]
    if (last) last.assist = `返回服务台${party.borrowWheelchair ? '、归还轮椅' : ''}、领取参观纪念与反馈卡`
  }

  // —— 讲解员 / 志愿者排班 ——（观众取消讲解时仅保留自助路线；接续时仅核算剩余时段）
  const escort = input.noEscort
    ? {}
    : pickEscort(party, input.date, arrivalMin, Math.round(t), staff, visits, signals, selfId)
  if (input.noEscort) {
    notices.push('应观众选择已取消人工讲解：保留无障碍路线与楼层定点协助，服务台发放自助讲解器/图文讲解卡')
  } else if (escort.id) {
    notices.push(continuation
      ? `接续陪同：${escort.kind}${escort.name}将在${startNodeInfo?.name ?? '当前位置'}与您会合，陪同至 ${fmtMin(Math.round(t))}`
      : `陪同安排：${escort.kind}${escort.name}（${fmtMin(arrivalMin)}–${fmtMin(Math.round(t))} 全程陪同）`)
  }
  if (!input.noEscort && escort.issue) notices.push('⚠ ' + escort.issue)

  // —— 接续：把已完成展厅的接应信息保留在时间线/看板中并标记完成 ——
  if (continuation) {
    const doneStops: HallStop[] = (input.completedStops ?? [])
      .filter((st) => completedHalls.has(st.hallId))
      .map((st) => ({ ...st, done: true }))
    stops.unshift(...doneStops)
  }

  const totalWalkMin = segs.reduce((n, s) => n + s.walkMin, 0)
  return {
    version,
    generatedAt: new Date().toISOString(),
    arrivalMin: Math.round(arrivalMin),
    startNode: continuation ? (startNodeInfo?.name ?? '馆内当前位置') : party.needParking ? '无障碍停车场' : '馆前无障碍坡道入口',
    endNode: '一层咨询服务台',
    segments: segs,
    stops,
    skipped,
    trace,
    notices,
    totalDistance: Math.round(walkUsed),
    totalWalkMin: Math.round(totalWalkMin),
    totalMin: Math.round(t - arrivalMin),
    endMin: Math.round(t),
    escortId: escort.id,
    escortKind: escort.kind,
    escortName: escort.name,
    escortIssue: escort.issue,
    parkingSlot,
    parkingIssue,
    wheelchairNeeded: party.borrowWheelchair,
    wheelchairIssue,
    signals: signalSnapshot(signals),
    reduced: signals.visitorUnwell,
    continuation,
    continuationNode: continuation ? startNodeId : undefined,
    continuationNodeName: continuation ? startNodeInfo?.name : undefined,
    completedStops: continuation ? Array.from(completedHalls) : undefined
  }
}

// —— 电梯故障后的路线重算分析：失效原因 / 延误 / 推行 / 替代展区 / 参观收益 ——
const hallName = (id: string) => hallMap.get(id)?.name ?? id

export interface RerouteInput {
  prev: RoutePlan // 故障前在执行的路线
  next: RoutePlan // 接续重算后的路线
  signals: LiveSignals
  party: PartyProfile
  completedHalls?: string[]
}

export function analyzeReroute({ prev, next, signals, party, completedHalls }: RerouteInput): RerouteAnalysis {
  const done = new Set(completedHalls ?? [])
  const failedElevators = signals.elevatorsDown
    .map((id) => ELEVATORS.find((e) => e.id === id)?.name ?? id)
  const working = ELEVATORS.filter((e) => !signals.elevatorsDown.includes(e.id))

  // —— 失效原因（观众可读）——
  const reasons: string[] = []
  for (const id of signals.elevatorsDown) {
    const ev = ELEVATORS.find((e) => e.id === id)!
    if (working.length > 0) {
      reasons.push(`${ev.name}临时停用（设备保护，预计抢修中），通往 B1/F2/F3 的跨层通道需改乘${working.map((e) => e.name).join('、')}并增加厅内绕行。`)
    } else {
      reasons.push(`${ev.name}临时停用，且另一部电梯也在维护中，目前没有可承载轮椅的垂直通道，跨层展厅本时段暂不能无障碍到达。`)
    }
  }
  if (working.length === 1) {
    reasons.push(`全馆仅余 ${working[0].name} 一部电梯运行，候梯与进出需要更多时间，楼层工作人员会在电梯口优先接应。`)
  }

  // —— 展厅集合对比（剔除已完成）——
  const prevActive = prev.stops.map((s) => s.hallId).filter((id) => !done.has(id))
  const nextActive = next.stops.filter((s) => !s.done).map((s) => s.hallId)
  const nextSet = new Set(nextActive)
  const prevSet = new Set(prevActive)
  const retainedHalls = prevActive.filter((id) => nextSet.has(id))
  const lostHalls = prevActive.filter((id) => !nextSet.has(id))
  // 替代展区：新路线中出现、原剩余计划没有的展厅
  const alternativeHalls = nextActive.filter((id) => !prevSet.has(id))

  // 受影响（原计划要去、本次发生变化：丢失或需绕行）的重点展厅
  const affectedHalls = Array.from(new Set([...lostHalls, ...retainedHalls]))

  // —— 预计延误：新结束时刻 vs 原计划结束时刻 ——
  const delayMin = Math.max(0, Math.round(next.endMin - prev.endMin))
  // 接续路线新增步行（只比较接续段距离与原计划剩余段并不直观；这里用新接续总步行 vs 原计划人均剩余估算）
  const extraDistance = next.totalDistance

  // —— 是否需要工作人员推行/搀扶 ——
  const usesChair = party.usesWheelchair || party.borrowWheelchair
  const hasRamp = next.segments.some((s) => s.kind === 'ramp')
  const needStaffPush = usesChair ? (working.length <= 1 || hasRamp) : (!party.canStandLong || party.hasElder) && working.length <= 1
  const staffPushText = needStaffPush
    ? usesChair
      ? `改乘${working[0]?.name ?? '备用电梯'}后需经厅内通道与坡道绕行，已安排工作人员在电梯口、坡道处接力推行并协助进出电梯，无需观众自行发力。`
      : '单梯运行候梯时间变长，已安排工作人员在电梯口搀扶接应并优先安排就近座椅休息。'
    : undefined

  // —— 线上讲解补充：有展厅因故障无法成行时提供 ——
  const onlineSupplement = lostHalls.length > 0
  const onlineText = onlineSupplement
    ? `对本次无法到达的${lostHalls.map(hallName).join('、')}，服务台将推送同名"云端展厅"线上讲解（重点展品图文/短视频），讲解员可在休息区陪同观看并答疑，不另收费。`
    : undefined

  // —— 参观收益（强调"不是简单取消"）——
  const benefits: string[] = []
  if (retainedHalls.length > 0) {
    benefits.push(`保留重点展品：${retainedHalls.map(hallName).join('、')}仍按无障碍路线成行，重点参观内容不缩水。`)
  }
  if (alternativeHalls.length > 0) {
    benefits.push(`替代展区：为您加排同层/可达的${alternativeHalls.map(hallName).join('、')}，参观丰富度尽量补齐。`)
  }
  if (done.size > 0) {
    benefits.push(`已参观的${Array.from(done).map(hallName).join('、')}计入本次参观成果，不因路线调整作废。`)
  }
  if (next.totalDistance < extraDistanceBaseline(prev, done) && next.totalDistance > 0) {
    benefits.push(`缩短步行：重排后剩余路线约 ${next.totalDistance} 米，较原路绕行方案更省力，并加密休息点。`)
  } else if (delayMin <= 5 && lostHalls.length === 0) {
    benefits.push('备用电梯路线衔接顺畅，预计几乎不延误，参观顺序仅作小幅调整。')
  }
  if (onlineSupplement) benefits.push('线上讲解补充：无法到达的展厅提供云端讲解与重点展品回放，回家后仍可继续观看。')
  if (needStaffPush) benefits.push('全程有人协助：电梯口与坡道均安排工作人员接力推行/搀扶，安全与体力有保障。')
  if (benefits.length === 0) benefits.push('服务台已保留您的预约与讲解权益，可选择改期或线上方式继续本次参观。')

  return {
    failedElevators,
    reasons,
    affectedHalls: affectedHalls.map(hallName),
    alternativeHalls: alternativeHalls.map(hallName),
    retainedHalls: retainedHalls.map(hallName),
    lostHalls: lostHalls.map(hallName),
    delayMin,
    extraDistance,
    needStaffPush,
    staffPushText,
    onlineSupplement,
    onlineText,
    benefits,
    options: {
      reorder: nextActive.length > 0,
      reschedule: true,
      cancelGuide: true
    }
  }
}

/** 原计划"尚未完成部分"的步行距离基线，用于判断新路线是否缩短步行 */
function extraDistanceBaseline(prev: RoutePlan, done: Set<string>): number {
  // 若已有展厅完成，则把原计划总距离按已完成接应数粗折算；无完成时用原总距离
  if (done.size === 0 || prev.stops.length === 0) return prev.totalDistance
  return Math.round(prev.totalDistance * Math.max(0, prev.stops.length - done.size) / prev.stops.length)
}
