import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { HALLS, STAFF } from './data/museum'
import { planRoute } from './lib/planner'
import type { LiveSignals } from './lib/planner'
import type { EventType, PartyProfile, RecoveryChoice, Visit } from './types'
import { fmtMin, shortCode, todayISO, uid } from './utils'

export interface GlobalSignals {
  elevatorsDown: string[]
  elevatorReasons: Record<string, string> // 故障电梯 → 对观众公示的停用原因
  closedHalls: string[]
  crowdOverride: Record<string, number>
  staffExtraLeave: string[]
  wheelchairOffset: number
}

const DEFAULT_GLOBAL: GlobalSignals = {
  elevatorsDown: [],
  elevatorReasons: {},
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
  addFeedback: (id: string, text: string) => void
  setPreferredHalls: (id: string, hallIds: string[]) => void
  chooseRecovery: (id: string, choice: RecoveryChoice, note?: string) => void
  handleRecovery: (id: string, by: string) => void
  restoreGuide: (id: string) => void
  markHallVisited: (id: string, hallId: string, visited: boolean) => void
  resetDemo: () => void
  seedDemo: () => void
}

function mergeSignals(global: GlobalSignals, vs?: VisitSignals): LiveSignals {
  return {
    elevatorsDown: global.elevatorsDown,
    elevatorReasons: global.elevatorReasons,
    closedHalls: global.closedHalls,
    crowdOverride: global.crowdOverride,
    staffExtraLeave: global.staffExtraLeave,
    wheelchairOffset: global.wheelchairOffset,
    lateMin: vs?.lateMin ?? 0,
    visitorUnwell: vs?.visitorUnwell ?? false
  }
}

function hallName(hallId: string): string {
  return HALLS.find((h) => h.id === hallId)?.name ?? hallId
}

function addEvent(visit: Visit, type: EventType, text: string, actor = '系统'): Visit {
  return {
    ...visit,
    events: [...visit.events, { id: uid('ev'), ts: new Date().toISOString(), type, actor, text }]
  }
}

function replanWithin(state: StoreState, visit: Visit, vs: VisitSignals | undefined, cause: string): Visit {
  // 实时故障/续览分析只针对今日在场服务；未来日期的预约不携带"今日电梯故障"快照
  const isToday = visit.date === todayISO()
  // 已入馆并看过部分展厅、或电梯故障、或已取消讲解时启用"续览模式"（从已参观展厅之后继续）；
  // 其余日常信号变化（迟到、拥挤、请假）仍重算完整路线，避免把未开始的入馆路段从页面抹掉
  const resume = isToday && ((visit.visitedHallIds?.length ?? 0) > 0 || state.global.elevatorsDown.length > 0 || visit.guideCancelled === true)
  const live = mergeSignals(state.global, vs)
  // 非今日：电梯故障/临时闭馆/拥挤/请假等"今日实时信号"不叠加到未来预约
  const signals: LiveSignals = isToday ? live : { ...live, elevatorsDown: [], elevatorReasons: {}, closedHalls: [], crowdOverride: {}, staffExtraLeave: [], lateMin: 0, visitorUnwell: false }
  const plan = planRoute({
    party: visit.party,
    date: visit.date,
    arrivalMin: visit.baseArrivalMin,
    signals,
    visits: state.visits,
    staff: STAFF,
    selfId: visit.id,
    version: visit.route ? visit.route.version + 1 : 1,
    prevPlan: isToday ? visit.route : undefined,
    visitedHallIds: resume ? visit.visitedHallIds : undefined,
    guideCancelled: isToday ? visit.guideCancelled : false
  })
  let next: Visit = { ...visit, route: plan, escortId: plan.escortId }
  if (cause) next = addEvent(next, 'route_change', `路线 v${plan.version}：${cause}`, '调度台')
  return next
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

const SEED_FLAG = 'museum_seed_v2'

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
            return replanWithin({ ...s, visits: s.visits }, next, s.visitSignals[id], cause ?? '预约信息变更，已重新核算路线与排班')
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
        const global = { ...get().global, ...patch }
        // 受影响（未取消、未完成）的预约全部重算
        const affected = get().visits.filter((v) => v.status !== 'cancelled' && v.status !== 'completed')
        const interim: StoreState = { ...get(), global, visits: get().visits }
        const byId = new Map(affected.map((v) => [v.id, replanWithin(interim, v, get().visitSignals[v.id], cause)]))
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
          const replanned = replanWithin({ ...s, visitSignals }, target, vs, cause)
          return { visitSignals, visits: s.visits.map((v) => (v.id === id ? replanned : v)) }
        })
      },

      setExtraCompanions: (id, n) => {
        const v = get().visits.find((x) => x.id === id)
        if (!v) return
        get().updateBooking(id, { party: { extraCompanions: Math.max(0, n) } }, `陪同人员临时${n > (v.party.extraCompanions ?? 0) ? '增加' : '调整'}为 ${n} 人，已复核队伍规模与接应安排`)
      },

      addFeedback: (id, text) => {
        set((s) => ({
          visits: s.visits.map((v) => (v.id === id ? addEvent({ ...v, feedback: text }, 'note', `参观后反馈与偏好记录：${text}`, '观众') : v))
        }))
      },

      setPreferredHalls: (id, hallIds) => {
        get().updateBooking(id, { party: { preferredHallIds: hallIds } }, '观众勾选重点展厅/替代展区，已按"重点优先、少绕行"重新排定参观顺序')
      },

      chooseRecovery: (id, choice, note) => {
        set((s) => {
          const visitSignals = choice === 'reschedule'
            ? { ...s.visitSignals, [id]: { lateMin: 0, visitorUnwell: false } }
            : s.visitSignals
          return {
            visitSignals,
            visits: s.visits.map((v) => {
            if (v.id !== id) return v
            const at = new Date().toISOString()
            const decision = { choice, at, note }
            let next: Visit = { ...v, recovery: decision }
            const d = v.route?.disruption
            if (choice === 'reorder') {
              const wasGuideCancelled = v.guideCancelled === true
              next.guideCancelled = false
              next = addEvent(next, 'recovery',
                `观众选择【调整参观顺序】：接受重算路线 v${v.route?.version}（${d ? `保留 ${d.keptHalls.length} 个原计划展厅、预计延误 ${Math.max(0, d.delayMin)} 分钟` : ''}），服务台保留该处理结果`, '观众')
              // 从此前"取消讲解"改回现场讲解时，需要重算恢复排班；单纯接受当前方案则不再升版本
              if (wasGuideCancelled) {
                next = replanWithin({ ...s, visits: s.visits, visitSignals }, next, visitSignals[id], '观众改选调整参观顺序：恢复现场讲解与接应排班')
              }
            } else if (choice === 'reschedule') {
              const newDate = note ?? todayISO()
              next.originalDate = v.originalDate ?? v.date
              next.originalArrivalMin = v.originalArrivalMin ?? v.baseArrivalMin
              next.visitedHallIds = []
              next.guideCancelled = false
              // 改期离馆：在借轮椅/设备一并归还入库，避免占用改期日库存
              const openLoans = v.loans.filter((l) => l.loanedAt && !l.returnedAt)
              if (openLoans.length > 0) {
                next.loans = v.loans.map((l) => (l.loanedAt && !l.returnedAt ? { ...l, returnedAt: new Date().toISOString() } : l))
                next = addEvent(next, 'wheelchair_return', `观众改期离馆，在借轮椅 ${openLoans.map((l) => l.assetCode).join('、')} 由服务台收回检查入库`, '服务台')
              }
              // 改期视为新一天的预约：按设备恢复正常生成干净路线（不带今日故障/拥挤快照）
              const cleanSignals: LiveSignals = {
                ...mergeSignals({ ...s.global, elevatorsDown: [], elevatorReasons: {}, closedHalls: [], crowdOverride: {} }),
                lateMin: 0, visitorUnwell: false
              }
              const plan = planRoute({
                party: v.party, date: newDate, arrivalMin: v.baseArrivalMin,
                signals: cleanSignals,
                visits: s.visits, staff: STAFF, selfId: v.id,
                version: v.route ? v.route.version + 1 : 1
              })
              next = { ...next, date: newDate, status: 'booked', route: plan, escortId: plan.escortId }
              next = addEvent(next, 'recovery',
                `观众选择【改期】：原 ${next.originalDate} ${fmtMin(next.originalArrivalMin!)} 的讲解改约至 ${newDate} ${fmtMin(v.baseArrivalMin)}；今日已看展厅与线上讲解码保留在服务记录中，改期当日可快速入馆`, '观众')
            } else {
              next.guideCancelled = true
              next = addEvent(next, 'recovery',
                '观众选择【取消今日现场讲解】：保留无障碍路线、轮椅与协助服务，未能到达的展厅改发线上云讲解（7 天内可回看），服务台已保留处理结果', '观众')
              next = replanWithin({ ...s, visits: s.visits, visitSignals }, next, visitSignals[id], '按观众选择取消现场讲解并重算：仅保留无障碍到达路线，讲解改为线上云讲解')
            }
            return next
          })
        }})
      },

      handleRecovery: (id, by) => {
        set((s) => ({
          visits: s.visits.map((v) => {
            if (v.id !== id || !v.recovery) return v
            const handledAt = new Date().toISOString()
            let next: Visit = {
              ...v,
              recoveryAckAt: handledAt,
              recovery: { ...v.recovery, handledBy: by, handledAt }
            }
            const label = v.recovery.choice === 'reorder' ? '调整参观顺序' : v.recovery.choice === 'reschedule' ? '改期' : '取消现场讲解'
            next = addEvent(next, 'recovery', `服务台${by}已受理观众【${label}】选择：确认新路线/线上讲解码/接应安排并当面（或电话）告知观众`, '服务台')
            return next
          })
        }))
      },

      restoreGuide: (id) => {
        set((s) => ({
          visits: s.visits.map((v) => {
            if (v.id !== id) return v
            let next: Visit = { ...v, guideCancelled: false }
            next = addEvent(next, 'escort_assign', '电梯恢复运行，服务台为观众恢复现场讲解并重新排班陪同', '服务台')
            return replanWithin({ ...s, visits: s.visits }, next, s.visitSignals[id], '电梯恢复：恢复现场讲解与接应排班')
          })
        }))
      },

      markHallVisited: (id, hallId, visited) => {
        set((s) => ({
          visits: s.visits.map((v) => {
            if (v.id !== id) return v
            const cur = new Set(v.visitedHallIds ?? [])
            if (visited) cur.add(hallId); else cur.delete(hallId)
            const visitedHallIds = Array.from(cur)
            let next: Visit = { ...v, visitedHallIds }
            if (visited) {
              next = addEvent(next, 'assist', `现场进度：观众已完成 ${hallName(hallId)} 参观并离开`, '展厅工作人员')
            }
            // 故障/取消讲解处置期间：进度变化即以最新进度为续览起点重算剩余路线
            if (s.global.elevatorsDown.length > 0 || v.guideCancelled) {
              next = replanWithin({ ...s, visits: s.visits }, next, s.visitSignals[id],
                visited ? `观众已离厅，续览路线从 ${hallName(hallId)} 之后重新计算` : '工作人员撤销离厅标记，剩余路线重新纳入该展厅')
            }
            return next
          })
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
        }, 'checked_in', (v) => {
          let n = v
          const loan = { id: uid('loan'), assetCode: 'WC-1042', loanedAt: new Date().toISOString() }
          n = { ...n, loans: [loan] }
          n = addEvent(n, 'wheelchair_loan', '借出轮椅 WC-1042', '服务台')
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
      name: 'museum-access-visit-v2',
      version: 2,
      partialize: (s) => ({ visits: s.visits, global: s.global, visitSignals: s.visitSignals }),
      onRehydrateStorage: () => (state) => {
        state?.seedDemo()
      }
    }
  )
)
