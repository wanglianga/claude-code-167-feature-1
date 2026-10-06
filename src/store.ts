import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { HALLS, STAFF } from './data/museum'
import { analyzeReroute, planRoute } from './lib/planner'
import type { LiveSignals } from './lib/planner'
import type { EventType, PartyProfile, ResolutionChoice, RoutePlan, RouteResolution, Visit } from './types'
import { fmtMin, shortCode, todayISO, uid } from './utils'

const hallLabel = (id: string) => HALLS.find((h) => h.id === id)?.name ?? id

export interface GlobalSignals {
  elevatorsDown: string[]
  closedHalls: string[]
  crowdOverride: Record<string, number>
  staffExtraLeave: string[]
  wheelchairOffset: number
}

const DEFAULT_GLOBAL: GlobalSignals = {
  elevatorsDown: [],
  closedHalls: [],
  crowdOverride: {},
  staffExtraLeave: [],
  wheelchairOffset: 0
}

export interface VisitSignals {
  lateMin: number
  visitorUnwell: boolean
}

interface StoreState {
  visits: Visit[]
  global: GlobalSignals
  visitSignals: Record<string, VisitSignals>
  hydrated: boolean

  createVisit: (input: { date: string; arrivalMin: number; party: PartyProfile }) => string
  updateBooking: (id: string, patch: { date?: string; arrivalMin?: number; party?: Partial<PartyProfile> }, cause?: string) => void
  cancelVisit: (id: string) => void
  checkIn: (id: string) => void
  setStatus: (id: string, status: Visit['status']) => void
  loanWheelchair: (id: string) => void
  returnWheelchair: (id: string, loanId: string) => void
  assignEscort: (id: string, staffId: string) => void
  addEvent: (id: string, type: EventType, text: string, actor?: string) => void
  recordAssist: (id: string, text: string) => void
  setGlobalSignals: (patch: Partial<GlobalSignals>, cause: string) => void
  setVisitSignals: (id: string, patch: Partial<VisitSignals>, cause: string) => void
  setExtraCompanions: (id: string, n: number) => void
  /** 工作人员标记某展厅已参观（推进接续进度） */
  markHallVisited: (id: string, hallId: string) => void
  /** 工作人员校正观众当前位置（电梯/休息点等） */
  setCurrentNode: (id: string, nodeId: string) => void
  /** 观众在故障重算后选择处置方式：调整顺序 / 改期 / 取消讲解；by 标记操作人 */
  resolveReroute: (
    id: string,
    choice: ResolutionChoice,
    extra?: { rescheduleDate?: string; rescheduleArrivalMin?: number; note?: string; by?: '观众' | '服务台' }
  ) => void
  /** 服务台接手并留存处理结果 */
  deskHandleResolution: (id: string, resultText: string) => void
  addFeedback: (id: string, text: string) => void
  resetDemo: () => void
  seedDemo: () => void
}

function mergeSignals(global: GlobalSignals, vs?: VisitSignals): LiveSignals {
  return {
    elevatorsDown: global.elevatorsDown,
    closedHalls: global.closedHalls,
    crowdOverride: global.crowdOverride,
    staffExtraLeave: global.staffExtraLeave,
    wheelchairOffset: global.wheelchairOffset,
    lateMin: vs?.lateMin ?? 0,
    visitorUnwell: vs?.visitorUnwell ?? false
  }
}

function addEvent(visit: Visit, type: EventType, text: string, actor = '系统'): Visit {
  return {
    ...visit,
    events: [...visit.events, { id: uid('ev'), ts: new Date().toISOString(), type, actor, text }]
  }
}

/** 推断参观进行中观众当前所在节点：优先人工校正，否则取最后一个已完成展厅，再否则在服务台 */
function inferCurrentNode(visit: Visit): string {
  if (visit.currentNode) return visit.currentNode
  const visited = visit.visitedHalls ?? []
  const stops = visit.route?.stops ?? []
  for (let i = stops.length - 1; i >= 0; i--) {
    if (visited.includes(stops[i].hallId)) return stops[i].hallId
  }
  return 'desk'
}

/** 接续开始时刻：已看厅取最后离厅时刻；尚未看厅取实际入馆时刻（基准+迟到）；再否则取入馆时刻 */
function inferContinuationAt(visit: Visit, lateMin = 0): number {
  const visited = new Set(visit.visitedHalls ?? [])
  const stops = visit.route?.stops ?? []
  for (let i = stops.length - 1; i >= 0; i--) {
    if (visited.has(stops[i].hallId)) return stops[i].leaveMin
  }
  return Math.max(visit.route?.arrivalMin ?? 0, visit.baseArrivalMin + lateMin)
}

const elevatorName = (id: string) => ({ el1: '1号客梯', el2: '2号无障碍电梯' }[id] ?? id)

function buildDispatchText(analysis: NonNullable<RoutePlan['reroute']>): string {
  const parts = [
    `故障：${analysis.failedElevators.join('、')}停用`,
    `预计延误约 ${analysis.delayMin} 分钟`,
    analysis.needStaffPush ? '需工作人员接力推行/搀扶' : '无需额外推行',
    analysis.retainedHalls.length ? `保留 ${analysis.retainedHalls.length} 个重点展厅` : '重点展厅受影响',
    analysis.alternativeHalls.length ? `替代展区 ${analysis.alternativeHalls.length} 个` : '暂无同层替代展区',
    analysis.onlineSupplement ? '附线上讲解补充' : '无线上补充'
  ]
  return `电梯故障路线重算已推送观众：${parts.join('；')}，等待观众选择（调整顺序/改期/取消讲解）`
}

interface ReplanOpts { noEscort?: boolean; newFault?: boolean; silent?: boolean; sameVersion?: boolean }

/** 参观进行中的接续重算：从当前位置继续、保留已完成展厅，电梯故障时挂重算分析 */
function continuationReplan(state: StoreState, visit: Visit, vs: VisitSignals | undefined, cause: string, opts: ReplanOpts = {}): Visit {
  const prev = visit.route
  if (!prev) return replanWithin(state, visit, vs, cause)
  const signals = mergeSignals(state.global, vs)
  const currentNode = inferCurrentNode(visit)
  const completedHalls = visit.visitedHalls ?? []
  const noEscort = opts.noEscort || visit.resolution?.choice === 'cancel_guide' || visit.guideCancelled
  const plan = planRoute({
    party: visit.party,
    date: visit.date,
    arrivalMin: visit.baseArrivalMin,
    signals,
    visits: state.visits,
    staff: STAFF,
    selfId: visit.id,
    version: opts.sameVersion ? prev.version : prev.version + 1,
    continuationStart: currentNode,
    continuationAtMin: inferContinuationAt(visit, signals.lateMin),
    completedHalls,
    completedStops: prev.stops,
    noEscort
  })
  const hasFault = signals.elevatorsDown.length > 0
  const analysis = hasFault
    ? analyzeReroute({ prev, next: plan, signals, party: visit.party, completedHalls })
    : undefined
  if (analysis) plan.reroute = analysis

  let next: Visit = { ...visit, route: plan, escortId: plan.escortId }
  // 一次新的电梯故障：上一轮处置归档为历史，重新等待观众选择
  if (opts.newFault && visit.resolution) next.resolution = undefined
  if (cause && !opts.silent) next = addEvent(next, 'route_change', `路线 v${plan.version}（到馆接续）：${cause}`, '调度台')
  if (analysis && !opts.silent) next = addEvent(next, 'reroute_dispatch', buildDispatchText(analysis), '调度台')
  return next
}

/** 未入馆预约的全量重算（原有逻辑） */
function replanWithin(state: StoreState, visit: Visit, vs: VisitSignals | undefined, cause: string): Visit {
  const plan = planRoute({
    party: visit.party,
    date: visit.date,
    arrivalMin: visit.baseArrivalMin,
    signals: mergeSignals(state.global, vs),
    visits: state.visits,
    staff: STAFF,
    selfId: visit.id,
    version: visit.route ? visit.route.version + 1 : 1
  })
  let next: Visit = { ...visit, route: plan, escortId: plan.escortId }
  if (cause) next = addEvent(next, 'route_change', `路线 v${plan.version}：${cause}`, '调度台')
  return next
}

/** 到馆（已入馆/参观中）的预约走接续重算，否则走全量 */
function replanVisit(state: StoreState, visit: Visit, vs: VisitSignals | undefined, cause: string, newFault = false): Visit {
  const onSite = visit.status === 'visiting' || visit.status === 'checked_in'
  return onSite ? continuationReplan(state, visit, vs, cause, { newFault }) : replanWithin(state, visit, vs, cause)
}

function makeVisit(state: StoreState, date: string, arrivalMin: number, party: PartyProfile): Visit {
  const id = uid('v')
  const plan = planRoute({
    party, date, arrivalMin,
    signals: mergeSignals(state.global),
    visits: state.visits, staff: STAFF, selfId: id
  })
  const visit: Visit = {
    id, code: shortCode(), date, baseArrivalMin: arrivalMin, status: 'booked', party, route: plan,
    escortId: plan.escortId, loans: [],
    events: [{ id: uid('ev'), ts: new Date().toISOString(), type: 'book', actor: '观众', text: `提交预约：${party.size} 人，${date} 到馆` }],
    createdAt: new Date().toISOString()
  }
  return visit
}

function emptyParty(): PartyProfile {
  return {
    contactName: '', phone: '', size: 1,
    usesWheelchair: false, borrowWheelchair: false,
    needSign: false, needSlow: false,
    hasElder: false, hasChild: false,
    needParking: false, canStandLong: true, extraCompanions: 0
  }
}

export { emptyParty }

const SEED_FLAG = 'museum_seed_v1'

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      visits: [],
      global: DEFAULT_GLOBAL,
      visitSignals: {},
      hydrated: false,

      createVisit: ({ date, arrivalMin, party }) => {
        const v = makeVisit(get(), date, arrivalMin, party)
        let visit = addEvent(v, 'note', `系统生成无障碍路线 v1：${v.route?.stops.length ?? 0} 个展厅、约 ${v.route?.totalDistance ?? 0} 米`, '系统')
        if (v.route?.parkingSlot) visit = addEvent(visit, 'parking', `预留无障碍车位 ${v.route.parkingSlot}`, '服务台')
        if (v.route?.escortId) visit = addEvent(visit, 'escort_assign', `已排班：${v.route.escortKind}${v.route.escortName}`, '调度台')
        set((s) => ({ visits: [...s.visits, visit] }))
        return v.id
      },

      updateBooking: (id, patch, cause) => {
        set((s) => ({
          visits: s.visits.map((v) => {
            if (v.id !== id) return v
            const next: Visit = {
              ...v,
              date: patch.date ?? v.date,
              baseArrivalMin: patch.arrivalMin ?? v.baseArrivalMin,
              party: { ...v.party, ...patch.party }
            }
            return replanVisit({ ...s, visits: s.visits }, next, s.visitSignals[id], cause ?? '预约信息变更，已重新核算路线与排班')
          })
        }))
      },

      cancelVisit: (id) => {
        set((s) => ({
          visits: s.visits.map((v) => (v.id === id ? addEvent({ ...v, status: 'cancelled' }, 'note', '预约已取消', '观众') : v))
        }))
      },

      checkIn: (id) => {
        set((s) => ({
          visits: s.visits.map((v) => {
            if (v.id !== id) return v
            let next = addEvent({ ...v, status: 'checked_in' }, 'checkin', '服务台核验预约、核验身份与安检通过', '服务台')
            if (v.party.needParking && v.route?.parkingSlot) next = addEvent(next, 'parking', `车位 ${v.route.parkingSlot} 已确认入场`, '门岗')
            if (v.route?.escortId) {
              const st = STAFF.find((x) => x.id === v.route!.escortId)
              next = addEvent(next, 'escort_assign', `${v.route.escortKind}${v.route.escortName ?? st?.name ?? ''}已到服务台对接`, '调度台')
            }
            return next
          })
        }))
      },

      setStatus: (id, status) => {
        set((s) => ({
          visits: s.visits.map((v) => {
            if (v.id !== id) return v
            let next: Visit = { ...v, status }
            if (status === 'completed') next = addEvent(next, 'complete', '参观结束，服务记录归档，欢迎下次再来', '服务台')
            if (status === 'visiting') next = addEvent(next, 'note', '正式开始参观，各楼层工作人员按预计到达时间接应', '讲解员')
            return next
          })
        }))
      },

      loanWheelchair: (id) => {
        set((s) => ({
          visits: s.visits.map((v) => {
            if (v.id !== id) return v
            const code = 'WC-' + Math.random().toString(36).slice(2, 6).toUpperCase()
            const loan = { id: uid('loan'), assetCode: code, loanedAt: new Date().toISOString() }
            let next: Visit = { ...v, loans: [...v.loans, loan] }
            next = addEvent(next, 'wheelchair_loan', `借出轮椅 ${code}，已协助调节脚踏、刹车并示范`, '服务台')
            return next
          })
        }))
      },

      returnWheelchair: (id, loanId) => {
        set((s) => ({
          visits: s.visits.map((v) => {
            if (v.id !== id) return v
            const loan = v.loans.find((l) => l.id === loanId)
            if (!loan || loan.returnedAt) return v
            let next: Visit = {
              ...v,
              loans: v.loans.map((l) => (l.id === loanId ? { ...l, returnedAt: new Date().toISOString() } : l))
            }
            next = addEvent(next, 'wheelchair_return', `轮椅 ${loan.assetCode} 已归还并检查入库`, '服务台')
            return next
          })
        }))
      },

      assignEscort: (id, staffId) => {
        set((s) => ({
          visits: s.visits.map((v) => {
            if (v.id !== id || !v.route) return v
            const st = STAFF.find((x) => x.id === staffId)
            if (!st) return v
            const route = { ...v.route, escortId: st.id, escortName: st.name, escortKind: st.role, escortIssue: undefined }
            let next: Visit = { ...v, route, escortId: st.id }
            next = addEvent(next, 'escort_assign', `人工改派：${st.role}${st.name} 全程陪同`, '调度台')
            return next
          })
        }))
      },

      addEvent: (id, type, text, actor) => {
        set((s) => ({ visits: s.visits.map((v) => (v.id === id ? addEvent(v, type, text, actor ?? '工作人员') : v)) }))
      },

      recordAssist: (id, text) => {
        set((s) => ({ visits: s.visits.map((v) => (v.id === id ? addEvent(v, 'assist', text, '展厅工作人员') : v)) }))
      },

      setGlobalSignals: (patch, cause) => {
        const prevGlobal = get().global
        const global = { ...prevGlobal, ...patch }
        // 是否有"新的"电梯故障（由运行变停用）
        const newFault = Array.isArray(patch.elevatorsDown)
          ? patch.elevatorsDown.some((id) => !prevGlobal.elevatorsDown.includes(id))
          : false
        // 受影响（未取消、未完成、未改期）的预约全部重算
        const affected = get().visits.filter((v) => v.status !== 'cancelled' && v.status !== 'completed' && v.status !== 'rescheduled')
        const interim: StoreState = { ...get(), global, visits: get().visits }
        const byId = new Map(affected.map((v) => [v.id, replanVisit(interim, v, get().visitSignals[v.id], cause, newFault)]))
        set((s) => ({
          global,
          visits: s.visits.map((v) => byId.get(v.id) ?? v)
        }))
      },

      setVisitSignals: (id, patch, cause) => {
        set((s) => {
          const prev = s.visitSignals[id] ?? { lateMin: 0, visitorUnwell: false }
          const vs: VisitSignals = { ...prev, ...patch }
          const visitSignals = { ...s.visitSignals, [id]: vs }
          const target = s.visits.find((v) => v.id === id)
          if (!target || target.status === 'cancelled') return { visitSignals }
          const replanned = replanVisit({ ...s, visitSignals }, target, vs, cause)
          return { visitSignals, visits: s.visits.map((v) => (v.id === id ? replanned : v)) }
        })
      },

      setExtraCompanions: (id, n) => {
        const v = get().visits.find((x) => x.id === id)
        if (!v) return
        get().updateBooking(id, { party: { extraCompanions: Math.max(0, n) } }, `陪同人员临时${n > (v.party.extraCompanions ?? 0) ? '增加' : '调整'}为 ${n} 人，已复核队伍规模与接应安排`)
      },

      markHallVisited: (id, hallId) => {
        set((s) => {
          const target = s.visits.find((v) => v.id === id)
          if (!target) return {}
          const visited = target.visitedHalls ?? []
          if (visited.includes(hallId)) return {}
          let next: Visit = { ...target, visitedHalls: [...visited, hallId], currentNode: hallId }
          next = addEvent(next, 'note', `已完成参观：${hallLabel(hallId)}（计入本次参观成果）`, '讲解员')
          // 参观进行中且已处于接续/故障重算：按最新进度静默刷新接续路线（保留版本与处置）
          if (next.status === 'visiting' && next.route?.continuation) {
            next = continuationReplan({ ...s, visits: s.visits }, next, s.visitSignals[id], '', { silent: true, sameVersion: true })
          }
          return { visits: s.visits.map((v) => (v.id === id ? next : v)) }
        })
      },

      setCurrentNode: (id, nodeId) => {
        set((s) => {
          const target = s.visits.find((v) => v.id === id)
          if (!target) return {}
          let next: Visit = { ...target, currentNode: nodeId || undefined }
          if (next.status === 'visiting' && next.route?.continuation) {
            next = continuationReplan({ ...s, visits: s.visits }, next, s.visitSignals[id], '', { silent: true, sameVersion: true })
          }
          return { visits: s.visits.map((v) => (v.id === id ? next : v)) }
        })
      },

      resolveReroute: (id, choice, extra) => {
        set((s) => {
          const v = s.visits.find((x) => x.id === id)
          if (!v || !v.route) return {}
          const actor = extra?.by ?? '观众'
          const analysis = v.route.reroute
          const failed = analysis?.failedElevators ?? s.global.elevatorsDown.map(elevatorName)
          const labelMap: Record<ResolutionChoice, string> = {
            reorder: '接受调整后的参观顺序，按新无障碍路线继续参观',
            reschedule: '改期：保留预约与讲解权益，择日再来',
            cancel_guide: '取消本次人工讲解，保留无障碍路线自行参观'
          }
          const baseResolution: RouteResolution = {
            id: uid('rs'),
            choice,
            label: labelMap[choice],
            decidedAt: new Date().toISOString(),
            decidedBy: extra?.by ?? '观众',
            failedElevators: failed,
            planVersion: v.route.version,
            rescheduleDate: extra?.rescheduleDate,
            rescheduleArrivalMin: extra?.rescheduleArrivalMin,
            note: extra?.note
          }

          let next: Visit = { ...v, resolution: baseResolution }

          if (choice === 'reorder') {
            next = addEvent(next, 'resolution',
              `观众选择【调整参观顺序】：接受 v${v.route.version} 接续路线（延误约 ${analysis?.delayMin ?? 0} 分钟${analysis?.needStaffPush ? '、需工作人员接力推行' : ''}），服务台留存并安排电梯口/坡道接应。`,
              actor)
            return { visits: s.visits.map((x) => (x.id === id ? next : x)) }
          }

          if (choice === 'reschedule') {
            const newDate = extra?.rescheduleDate ?? v.date
            const newArrival = extra?.rescheduleArrivalMin ?? v.baseArrivalMin
            // 改期视为全新一天：当日临时信号（电梯故障/闭馆/拥挤等）不带入，迟到/不适复位
            const freshSignals: LiveSignals = {
              elevatorsDown: [], closedHalls: [], crowdOverride: {},
              staffExtraLeave: [], wheelchairOffset: 0, visitorUnwell: false, lateMin: 0
            }
            const plan = planRoute({
              party: v.party, date: newDate, arrivalMin: newArrival,
              signals: freshSignals, visits: s.visits, staff: STAFF, selfId: v.id,
              version: v.route.version + 1
            })
            next = {
              ...next,
              date: newDate, baseArrivalMin: newArrival,
              status: 'rescheduled', route: plan, escortId: plan.escortId,
              visitedHalls: [], currentNode: undefined, guideCancelled: false
            }
            next = addEvent(next, 'resolution',
              `观众选择【改期】：本次到馆参观暂止，同一条服务保留同规格无障碍预约与讲解权益，改至 ${newDate} ${fmtMin(newArrival)} 到馆（路线 v${plan.version}，按电梯恢复后的全新一天编排）；服务台留存改期结果并将优先排班。`,
              actor)
            const visitSignals = { ...s.visitSignals, [id]: { lateMin: 0, visitorUnwell: false } }
            return { visitSignals, visits: s.visits.map((x) => (x.id === id ? next : x)) }
          }

          // cancel_guide：重算为无陪同的自助无障碍路线
          // cancel_guide：重算为无陪同的自助无障碍路线
          next = { ...next, guideCancelled: true }
          next = addEvent(next, 'resolution',
            '观众选择【取消本次人工讲解】：保留无障碍路线与楼层定点协助，服务台发放自助讲解器/图文讲解卡；无法到达的展厅推送线上讲解补充。',
            actor)
          next = continuationReplan(s, next, s.visitSignals[id],
            '按观众选择取消人工讲解，重排为自助无障碍路线（保留路线与楼层协助）', { noEscort: true })
          next = { ...next, resolution: { ...next.resolution!, planVersion: next.route!.version } }
          return { visits: s.visits.map((x) => (x.id === id ? next : x)) }
        })
      },

      deskHandleResolution: (id, resultText) => {
        set((s) => ({
          visits: s.visits.map((v) => {
            if (v.id !== id || !v.resolution) return v
            const handledAt = new Date().toISOString()
            let next: Visit = {
              ...v,
              resolution: { ...v.resolution, handledByDesk: true, handledAt, resultText }
            }
            next = addEvent(next, 'resolution', `服务台已接手处理并留存：${resultText}`, '服务台')
            return next
          })
        }))
      },

      addFeedback: (id, text) => {
        set((s) => ({
          visits: s.visits.map((v) => (v.id === id ? addEvent({ ...v, feedback: text }, 'note', `参观后反馈与偏好记录：${text}`, '观众') : v))
        }))
      },

      resetDemo: () => {
        localStorage.removeItem(SEED_FLAG)
        set({ visits: [], global: DEFAULT_GLOBAL, visitSignals: {} })
      },

      seedDemo: () => {
        if (localStorage.getItem(SEED_FLAG) || get().visits.length > 0) return
        const today = todayISO()
        const state0: StoreState = { ...get(), visits: [] }
        const mk = (arrival: number, party: PartyProfile, status: Visit['status'], mutate?: (v: Visit) => Visit): Visit => {
          const v = makeVisit({ ...state0, visits: state0.visits }, today, arrival, party)
          state0.visits = [...state0.visits, v]
          let next = v
          if (status === 'checked_in' || status === 'visiting' || status === 'completed') {
            next = addEvent({ ...next, status: status === 'completed' ? 'completed' : status }, 'checkin', '服务台核验预约、安检通过', '服务台')
          }
          if (status === 'visiting') next = addEvent(next, 'note', '已开始参观', '讲解员')
          if (status === 'completed') next = addEvent(next, 'complete', '参观结束并归档', '服务台')
          if (mutate) next = mutate(next)
          state0.visits[state0.visits.length - 1] = next
          return next
        }
        mk(9 * 60 + 30, {
          ...emptyParty(), contactName: '张女士', phone: '13800000219', size: 2,
          borrowWheelchair: true, needSlow: true, hasElder: true, needParking: true, canStandLong: false
        }, 'visiting', (v) => {
          let n = v
          const loan = { id: uid('loan'), assetCode: 'WC-1042', loanedAt: new Date().toISOString() }
          n = { ...n, loans: [loan] }
          n = addEvent(n, 'wheelchair_loan', '借出轮椅 WC-1042', '服务台')
          // 已到馆并参观完 B1 第一展厅，当前位于该厅（用于演示电梯故障后的"接续重算"）
          n = { ...n, visitedHalls: ['hA'], currentNode: 'hA' }
          n = addEvent(n, 'note', '已完成参观：B1 临展厅 A · 青铜特展（计入本次参观成果）', '讲解员')
          return n
        })
        mk(10 * 60 + 0, {
          ...emptyParty(), contactName: '林先生', phone: '13900008851', size: 3,
          usesWheelchair: true, needSign: true, hasChild: false, canStandLong: true
        }, 'booked')
        mk(11 * 60 + 15, {
          ...emptyParty(), contactName: '吴阿姨', phone: '13700003340', size: 4,
          needSlow: true, hasElder: true, hasChild: true, canStandLong: false
        }, 'booked')
        set({ visits: state0.visits })
        localStorage.setItem(SEED_FLAG, '1')
      }
    }),
    {
      name: 'museum-access-visit-v1',
      partialize: (s) => ({ visits: s.visits, global: s.global, visitSignals: s.visitSignals }),
      onRehydrateStorage: () => (state) => {
        state?.seedDemo()
      }
    }
  )
)
