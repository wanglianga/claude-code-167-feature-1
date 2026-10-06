import { EDGES, ELEVATORS, HALLS, HALL_FLOOR_STAFF_CAPACITY, HOURS, NODES, TOTAL_PARKING, TOTAL_WHEELCHAIRS } from '../data/museum'
import type {
  DisruptionInfo, Edge, Floor, GraphNode, HallImpact, HallInfo, HallStop, PartyProfile, RoutePlan, RouteSeg, Staff, Visit
} from '../types'
import { fmtMin, uid } from '../utils'

// —— 现场实时信号（工作人员可调整）——
export interface LiveSignals {
  elevatorsDown: string[] // 故障电梯 id
  elevatorReasons?: Record<string, string> // 故障电梯 id → 停用原因（对观众公示）
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
  visitedSet: Set<string> // 故障发生时已参观完成的展厅（续览时不再重排）
  preferredSet: Set<string> // 观众标记的重点展厅（优先保留）
  guideCancelled: boolean // 已取消现场讲解：无现场讲解的展厅不排入
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
      walkMin = 1.5 + 2 * elevEdges // 候梯 + 乘梯
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
    if (edge.kind === 'elevator') min += 3
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
  prevPlan?: RoutePlan // 上一版路线（故障/处置重算时传入，用于对比分析）
  visitedHallIds?: string[] // 故障发生时已参观完成的展厅（续览从该厅之后继续）
  guideCancelled?: boolean // 观众已选择取消现场讲解
}

const hallShort = (id: string): string => {
  const n = hallMap.get(id)?.name ?? id
  return n.split(' · ')[1] ?? n
}

/** 对比新旧两版路线，生成对观众公示的"失效原因 + 新参观收益"分析 */
function buildDisruption(
  prev: RoutePlan,
  next: RoutePlan,
  signals: LiveSignals,
  party: PartyProfile,
  visitedSet: Set<string>,
  adj: Map<string, Adj[]>
): DisruptionInfo | undefined {
  if (signals.elevatorsDown.length === 0) return undefined
  const preferredSet = new Set(party.preferredHallIds ?? [])
  const now = new Date()
  const at = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  // —— 触发原因与失效说明 ——
  const downNames = signals.elevatorsDown.map((id) => ELEVATORS.find((e) => e.id === id)?.name ?? id)
  const allDown = signals.elevatorsDown.length >= ELEVATORS.length
  const trigger = allDown
    ? `通往 B1/F2/F3 重点展厅的两部电梯于 ${at} 先后停用`
    : `通往重点展厅的${downNames.join('、')}于 ${at} 临时停用`

  const reasons: string[] = []
  for (const id of signals.elevatorsDown) {
    const ev = ELEVATORS.find((e) => e.id === id)!
    const why = signals.elevatorReasons?.[id] ?? '机械保护停机，工程部正在抢修'
    reasons.push(`${ev.name}因"${why}"停用，预计抢修 30–60 分钟，恢复时间将第一时间推送`)
  }
  if (allDown) {
    reasons.push('两部电梯均不可用期间，跨层（B1/F2/F3）暂不具备无障碍通行条件；楼梯仅作疏散使用，轮椅与推车无法通过')
  } else {
    const other = ELEVATORS.find((e) => !signals.elevatorsDown.includes(e.id))!
    reasons.push(`去往各楼层统一改乘${other.name}并由工作人员协助挡门、进出；绕行会增加步行与候梯时间，但全程仍为无障碍通道`)
  }

  // —— 展区影响 ——
  const prevIds = prev.stops.map((s) => s.hallId).filter((id) => !visitedSet.has(id))
  const newIds = next.stops.map((s) => s.hallId)
  const newSet = new Set(newIds)
  const skipReasonMap = new Map(next.skipped.map((s) => [s.hallId, s.reason]))

  const affectedHalls: HallImpact[] = []
  for (const id of prevIds) {
    if (newSet.has(id)) continue
    let reason = skipReasonMap.get(id)
    if (!reason) {
      reason = signals.elevatorsDown.length >= ELEVATORS.length
        ? '两部电梯均停用，暂不具备无障碍到达条件'
        : `绕行备用电梯后，按当前体力与闭馆时间已无法从容排入`
    }
    if (next.guideCancelled) reason = `观众选择取消现场讲解：${reason}，改发线上云讲解`
    affectedHalls.push({ hallId: id, reason })
  }
  // 观众标记为重点但原本未排入、现在仍不可达的展厅也一并说明
  for (const id of party.preferredHallIds ?? []) {
    if (newSet.has(id) || visitedSet.has(id) || affectedHalls.some((a) => a.hallId === id)) continue
    affectedHalls.push({ hallId: id, reason: skipReasonMap.get(id) ?? '电梯停用绕行后本时段暂无法安排' })
  }

  const keptHalls = newIds.filter((id) => preferredSet.has(id) || prevIds.includes(id))

  // —— 可替代展区（新进入路线的同楼层展厅）——
  const substitutedHalls: DisruptionInfo['substitutedHalls'] = []
  for (const id of newIds) {
    if (prevIds.includes(id) || visitedSet.has(id)) continue
    const victim = affectedHalls.find((a) => HALL_FLOOR[a.hallId] === HALL_FLOOR[id])
    substitutedHalls.push({
      hallId: id,
      forHallId: victim?.hallId ?? affectedHalls[0]?.hallId ?? id,
      reason: victim ? `同楼层替代展区，无需再跨层绕行` : `备用电梯即可到达，当前客流宽松`
    })
  }

  // —— 观众可再勾选的候选展区 ——
  const candidates: DisruptionInfo['candidates'] = []
  for (const h of HALLS) {
    const id = h.id
    if (newSet.has(id) || visitedSet.has(id) || signals.closedHalls.includes(id)) continue
    if (affectedHalls.some((a) => a.hallId === id)) continue
    const reachable = dijkstra(adj, 'desk', id) !== null
    if (!reachable) continue
    const crowd = crowdAt(id, next.arrivalMin, signals.crowdOverride)
    if (crowd >= 0.8) continue
    candidates.push({
      hallId: id,
      reason: `${HALL_FLOOR[id] < 0 ? 'B1' : 'F' + HALL_FLOOR[id]} 同层可到达 · 当前拥挤度约 ${Math.round(crowd * 100)}% · 重点展品：${h.highlights[0]}`
    })
  }
  candidates.sort((a, b) => (preferredSet.has(b.hallId) ? 1 : 0) - (preferredSet.has(a.hallId) ? 1 : 0))

  // —— 延误与步行变化（续览时仅比较"剩余路线"）——
  let prevRemainingDist = prev.totalDistance
  if (visitedSet.size > 0) {
    const visitedStops = prev.stops.filter((s) => visitedSet.has(s.hallId))
    const lastVisited = visitedStops[visitedStops.length - 1]
    if (lastVisited) {
      const idx = prev.segments.findIndex((s) => s.distance === 0 && s.from === hallMap.get(lastVisited.hallId)?.name)
      prevRemainingDist = idx >= 0 ? prev.segments.slice(idx + 1).reduce((n, s) => n + s.distance, 0) : prev.totalDistance
    }
  }
  const delayMin = Math.round(next.endMin - prev.endMin)
  const extraDistance = next.totalDistance - prevRemainingDist

  // —— 是否需要工作人员推行 ——
  const pushReasons: string[] = []
  const usesChair = party.usesWheelchair || party.borrowWheelchair
  const steepRamps = next.segments.filter((s) => s.kind === 'ramp' && (s.maxSlope ?? 0) >= 6).length
  if (usesChair && steepRamps > 0) pushReasons.push(`新路线含 ${steepRamps} 段坡度 ≥6% 的坡道，轮椅自行上坡困难`)
  if (usesChair && extraDistance > 120) pushReasons.push(`绕行备用电梯比原路线多走约 ${extraDistance} 米`)
  if (usesChair && next.stops.length > 0) pushReasons.push('备用电梯候梯厅与展厅入口之间安排工作人员接应推行')
  const needStaffPush = pushReasons.length > 0

  // —— 线上讲解补充：本次确实无法到达的展厅 ——
  const candidateIds = new Set(candidates.map((c) => c.hallId))
  const lostIds = affectedHalls.map((a) => a.hallId).filter((id) => !newSet.has(id))
  const onlineHalls = next.guideCancelled
    ? Array.from(new Set([...lostIds, ...(party.preferredHallIds ?? [])]))
        .filter((id) => !newSet.has(id) && !visitedSet.has(id))
    : lostIds.filter((id) => !visitedSet.has(id) && !candidateIds.has(id))

  // —— 新参观收益 ——
  const benefits: string[] = []
  if (keptHalls.length > 0) {
    const first = hallMap.get(keptHalls[0])!
    benefits.push(`重点内容保留：仍可现场参观 ${keptHalls.length} 个原计划展厅（如${hallShort(keptHalls[0])}的「${first.highlights[0]}」），核心展品没有因故障取消`)
  }
  if (substitutedHalls.length > 0) {
    const s = substitutedHalls[0]
    const h = hallMap.get(s.hallId)!
    benefits.push(`改看同楼层${hallShort(s.hallId)}：少走折返路，也能看到「${h.highlights[0]}」等重点展品`)
  }
  if (extraDistance < -20) benefits.push(`新顺序少走约 ${Math.abs(extraDistance)} 米，把体力留给重点展品`)
  if (delayMin <= 0) benefits.push('按新的参观顺序可在原计划时间内结束，不额外延误')
  else benefits.push(`预计仅延误约 ${delayMin} 分钟（含候梯与绕行），各节点接应已同步顺延`)
  if (onlineHalls.length > 0) {
    const codes = onlineHalls.map((id) => hallMap.get(id)?.onlineCode).filter(Boolean).join('、')
    benefits.push(`${onlineHalls.length} 个本次无法到达的展厅已开通线上云讲解（${codes}），7 天内可随时回看，改期再到馆可免预约走快速入馆`)
  }
  if (needStaffPush) benefits.push('已在备用电梯口与坡道安排工作人员接应推行，无需观众自行用力')
  if (benefits.length === 0) benefits.push('服务台已保留本次处置结果，可选择调整顺序、改期或改为线上讲解，不会被简单当作"取消服务"')

  return {
    kind: 'elevator',
    trigger,
    reasons,
    affectedHalls,
    keptHalls,
    substitutedHalls,
    candidates: candidates.slice(0, 4),
    delayMin,
    extraDistance,
    needStaffPush,
    pushReasons,
    benefits,
    onlineHalls,
    prevVersion: prev.version
  }
}

export function planRoute(input: PlanInput): RoutePlan {
  const { party, signals, visits, staff, selfId } = input
  const version = input.version ?? 1
  const notices: string[] = []
  const adj = buildAdj(signals.elevatorsDown)

  const usesChair = party.usesWheelchair || party.borrowWheelchair
  const lowStamina = usesChair || !party.canStandLong || party.hasElder
  const speed = usesChair ? 48 : party.needSlow || party.hasElder ? 42 : 60
  const walkBudget = signals.visitorUnwell ? 350 : usesChair ? 2400 : lowStamina ? 700 : 1500

  const visitedSet = new Set(input.visitedHallIds ?? [])
  const preferredSet = new Set(party.preferredHallIds ?? [])
  const guideCancelled = input.guideCancelled ?? false

  const ctx: PlanCtx = {
    adj, party, signals, speed, lowStamina, usesChair, walkBudget, notices,
    floorOccupancy: new Map(),
    visitedSet, preferredSet, guideCancelled
  }

  // 已有预约对楼层接应能力的占用（已参观的展厅不再占用接应位）
  for (const v of visits) {
    if (v.id === selfId || v.date !== input.date || v.status === 'cancelled' || !v.route) continue
    for (const st of v.route.stops) {
      if (st.online) continue
      const f = HALL_FLOOR[st.hallId]
      const key = `${f}:${Math.floor(st.arriveMin / 30)}`
      ctx.floorOccupancy.set(key, (ctx.floorOccupancy.get(key) ?? 0) + 1)
    }
  }

  const arrivalMin = Math.max(HOURS.openMin, input.arrivalMin + signals.lateMin)
  if (signals.lateMin > 0) notices.push(`观众迟到约 ${signals.lateMin} 分钟，已将入馆与各段接应时间顺延，自 ${fmtMin(arrivalMin)} 起算`)
  if (signals.visitorUnwell) notices.push('⚠ 观众反馈身体不适：已缩减为最近的 1–2 个展厅、加长休息，服务台备轮椅与医药箱')

  // —— 轮椅库存 ——
  const availW = wheelchairAvailable(signals, visits, input.date, selfId)
  let wheelchairIssue: string | undefined
  if (party.borrowWheelchair && availW <= 0) {
    wheelchairIssue = '馆方轮椅库存暂不足：已登记排队并优先调剂，路线按"多休息点、最短步行"生成；服务台可提供折叠凳'
    notices.push('⚠ ' + wheelchairIssue)
  } else if (party.borrowWheelchair) {
    notices.push(`轮椅库存充足（余 ${availW} 台），入馆后在服务台凭证领取`)
  }
  if (!party.borrowWheelchair && !party.usesWheelchair && lowStamina) {
    notices.push('温馨提示：根据"不能长时间站立/有老人"的情况，服务台可免费借用轮椅或折叠凳')
  }

  // —— 无障碍车位 ——
  let parkingSlot: string | undefined
  let parkingIssue: string | undefined
  if (party.needParking) {
    const used = TOTAL_PARKING - parkingAvailable(visits, input.date, selfId)
    if (used < TOTAL_PARKING) {
      parkingSlot = `P-${String(used + 1).padStart(2, '0')}`
      notices.push(`无障碍车位已预留：${parkingSlot}（B1 临近电梯）`)
    } else {
      parkingIssue = '近距离无障碍车位已约满：车辆可在正门落客区临时停靠（志愿者接应），社会车位 B2 仍有空余'
      notices.push('⚠ ' + parkingIssue)
    }
  }

  // —— 电梯故障提示（公示停用原因与抢修预期，避免观众误以为服务被随意取消）——
  for (const id of signals.elevatorsDown) {
    const ev = ELEVATORS.find((e) => e.id === id)!
    const other = ELEVATORS.find((e) => e.id !== id)
    const why = signals.elevatorReasons?.[id] ?? '机械保护停机，工程部抢修中'
    notices.push(signals.elevatorsDown.length >= ELEVATORS.length
      ? `⚠ ${ev.name}临时故障（${why}）：两部电梯均不可用，已暂停跨层展厅安排，转为同层参观/线上讲解/改期方案`
      : `⚠ ${ev.name}临时故障（${why}）：全程改走${other?.name ?? '备用通道'}，工作人员协助候梯与推行，部分展厅需绕行`)
  }
  if (guideCancelled) {
    notices.push('ℹ 您已选择取消今天的现场讲解：无障碍到达路线与设备服务保留，未能到达的展厅改为线上云讲解，服务台已同步受理')
  }

  const segs: RouteSeg[] = []
  const stops: HallStop[] = []
  const skipped: Array<{ hallId: string; reason: string }> = []
  const trace: string[] = []
  let t = arrivalMin
  let walkUsed = 0

  // 起点：续览（故障时观众已到馆并看过部分展厅）时从最后一个已参观展厅继续；
  // 否则从停车场 → 坡道入口 → 服务台
  let curNode = 'entrance'
  const resumeHallId = (() => {
    if (visitedSet.size === 0) return undefined
    const inPlan = input.prevPlan?.stops.map((s) => s.hallId) ?? []
    const visited = inPlan.filter((id) => visitedSet.has(id))
    return visited[visited.length - 1]
  })()
  if (resumeHallId) {
    curNode = resumeHallId
    const doneNames = input.prevPlan!.stops.filter((s) => visitedSet.has(s.hallId)).map((s) => hallShort(s.hallId)).join('、')
    notices.push(`ℹ 您已完成 ${doneNames} 的参观，重算路线从${hallShort(resumeHallId)}之后继续，已参观部分不再重复安排`)
    t = Math.max(t, input.prevPlan!.stops.find((s) => s.hallId === resumeHallId)!.leaveMin)
  } else if (party.needParking) {
    const leg = pathLeg(ctx, 'parking', 'entrance', t)
    if (!leg) {
      notices.push('⚠ 停车场通道暂不可用，请由正门落客区进入')
    } else {
      segs.push(...leg.segs); trace.push(...leg.edgeIds); t = leg.t; walkUsed += leg.dist
    }
  }
  if (!resumeHallId) {
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

  // —— 展厅选择：观众勾选的重点展厅最优先，其次按楼层从低到高；带儿童优先自然馆 ——
  const maxHalls = signals.visitorUnwell ? 2 : lowStamina ? 3 : 6
  const baseOrder = party.hasChild ? ['hF', 'hA', 'hB', 'hC', 'hD', 'hE'] : ['hA', 'hB', 'hC', 'hD', 'hE', 'hF']
  const preferredOrder = (party.preferredHallIds ?? []).filter((id) => baseOrder.includes(id))
  const order = [...preferredOrder, ...baseOrder.filter((id) => !preferredOrder.includes(id))]
  let hallsDone = 0
  let lastToilet = t

  for (const hallId of order) {
    if (visitedSet.has(hallId)) continue
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
    if (lowStamina && curNode !== 'desk' && hallsDone >= 1) {
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
      assist: guideCancelled
        ? `已取消现场讲解：建议在${hinfo.name.split(' · ')[0]}使用线上云讲解（${hinfo.onlineCode}）+ 自助讲解器自由参观，展厅工作人员可提供定点协助`
        : `${f < 0 ? 'B1' : 'F' + f} 展厅工作人员在${hinfo.name.split(' · ')[0]}入口接应（预计 ${fmtMin(arriveHall)} 到达）${crowd >= 0.6 ? '；现场较拥挤，协助从无障碍观展位进入' : ''}`
    })
    // 取消现场讲解后不再占用楼层定时接应岗（仅保留定点协助）
    if (!guideCancelled) ctx.floorOccupancy.set(winKey, (ctx.floorOccupancy.get(winKey) ?? 0) + 1)
    segs.push({
      id: uid('seg'), from: hinfo.name, to: hinfo.name, via: [],
      kind: 'flat', distance: 0, walkMin: viewMin, arriveMin: Math.round(t),
      stayMin: viewMin,
      title: guideCancelled
        ? `线上云讲解 + 自助参观（${hinfo.onlineCode}）`
        : `参观讲解${party.needSign ? '（手语）' : party.needSlow ? '（慢速）' : ''}`,
      warning: guideCancelled
        ? `线上云讲解编号 ${hinfo.onlineCode}，7 天内可回看；需要帮助可找本层工作人员`
        : crowd >= 0.6 ? `展厅拥挤度 ${Math.round(crowd * 100)}%，讲解员控制节奏、安排休息座椅` : undefined
    })
    curNode = hallId
    hallsDone += 1
  }

  // —— 收尾：返回服务台（低体力者途经休息点）——
  if (curNode !== 'desk') {
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

  // —— 讲解员 / 志愿者排班 ——
  // 取消现场讲解后：不再排全程讲解员；轮椅/坡道/电梯的物理协助仍安排志愿者
  let escort: ReturnType<typeof pickEscort>
  if (guideCancelled) {
    escort = usesChair
      ? pickEscort({ ...party, needSign: false, needSlow: false }, input.date, arrivalMin, Math.round(t), staff, visits, signals, selfId)
      : {}
    if (escort.id) notices.push(`陪同安排：现场讲解已改为线上云讲解；${escort.kind}${escort.name}仅在电梯口/坡道提供轮椅推行等物理协助`)
  } else {
    escort = pickEscort(party, input.date, arrivalMin, Math.round(t), staff, visits, signals, selfId)
    if (escort.id) notices.push(`陪同安排：${escort.kind}${escort.name}（${fmtMin(arrivalMin)}–${fmtMin(Math.round(t))} 全程陪同）`)
  }
  if (escort.issue) notices.push('⚠ ' + escort.issue)

  const totalWalkMin = segs.reduce((n, s) => n + s.walkMin, 0)
  const disruption = input.prevPlan
    ? buildDisruption(input.prevPlan, {
        version, stops, skipped, segments: segs, arrivalMin: Math.round(arrivalMin), endMin: Math.round(t),
        totalDistance: Math.round(walkUsed), guideCancelled
      } as RoutePlan, signals, party, visitedSet, adj)
    : undefined
  return {
    version,
    generatedAt: new Date().toISOString(),
    arrivalMin: Math.round(arrivalMin),
    startNode: resumeHallId ? `续览起点：${hallMap.get(resumeHallId)!.name}` : party.needParking ? '无障碍停车场' : '馆前无障碍坡道入口',
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
    guideCancelled,
    disruption
  }
}
