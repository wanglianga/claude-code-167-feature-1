// store 运行时冒烟测试（node + localStorage 垫片）
const mem = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear()
} as unknown as Storage

const { useStore } = await import('../src/store.ts')
const { todayISO } = await import('../src/utils.ts')

let pass = 0, fail = 0
const assert = (c: boolean, m: string) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)) }

useStore.getState().resetDemo()
useStore.getState().seedDemo()
let st = useStore.getState()
assert(st.visits.length === 3, `seedDemo 生成 3 组今日演示预约（实际 ${st.visits.length}）`)

const today = todayISO()
const id = st.createVisit({
  date: today, arrivalMin: 10 * 60,
  party: {
    contactName: '测试观众', phone: '13900000000', size: 2,
    usesWheelchair: false, borrowWheelchair: true, needSign: false, needSlow: true,
    hasElder: true, hasChild: false, needParking: true, canStandLong: false, extraCompanions: 0
  }
})
st = useStore.getState()
const v0 = st.visits.find((v) => v.id === id)!
assert(!!v0.route && v0.route.version === 1, '新预约生成路线 v1')
assert(v0.events.some((e) => e.type === 'book'), '写入预约事件')
assert(!!v0.route?.parkingSlot && !!v0.route.escortId, '同时排到车位与陪同')

// 电梯故障 → 全局联动重规划
useStore.getState().setGlobalSignals({ elevatorsDown: ['el1'] }, '1号客梯故障演练')
st = useStore.getState()
const v1 = st.visits.find((v) => v.id === id)!
assert(v1.route!.version === 2 && v1.events.some((e) => e.type === 'route_change'), '故障后该预约升级 v2 并留路线调整记录')
assert(!v1.route!.trace.some((t) => t.startsWith('ev1')), 'v2 轨迹不含故障电梯')

// 核验 + 借轮椅
useStore.getState().checkIn(id)
useStore.getState().loanWheelchair(id)
st = useStore.getState()
const v2 = st.visits.find((v) => v.id === id)!
assert(v2.status === 'checked_in', '服务台核验入馆')
assert(v2.loans.length === 1 && !!v2.loans[0].loanedAt, `借出轮椅 ${v2.loans[0]?.assetCode}`)

// 迟到
useStore.getState().setVisitSignals(id, { lateMin: 30 }, '迟到演练')
st = useStore.getState()
const v3 = st.visits.find((v) => v.id === id)!
assert(v3.route!.arrivalMin === 10 * 60 + 30, `接应顺延至 ${v3.route!.arrivalMin}（期望 630）`)

// 身体不适 → 缩减
const before = v3.route!.stops.length
useStore.getState().setVisitSignals(id, { visitorUnwell: true }, '不适演练')
st = useStore.getState()
const v4 = st.visits.find((v) => v.id === id)!
assert(v4.route!.reduced && v4.route!.stops.length <= before, `身体不适后展厅 ${before}→${v4.route!.stops.length}`)

// 陪同人临时增加
useStore.getState().setExtraCompanions(id, 2)
st = useStore.getState()
assert(st.visits.find((v) => v.id === id)!.party.extraCompanions === 2, '临时增加陪同 2 人已入同一服务')

// 突发协助
useStore.getState().recordAssist(id, '三楼坡道协助推行并在休息区测量血压')
st = useStore.getState()
assert(st.visits.find((v) => v.id === id)!.events.some((e) => e.type === 'assist'), '突发协助写入服务记录')

// 归还 + 完成 + 反馈
useStore.getState().returnWheelchair(id, v4.loans[0].id)
useStore.getState().setStatus(id, 'completed')
useStore.getState().addFeedback(id, '偏好慢速讲解，希望下次仍安排王老师')
st = useStore.getState()
const v5 = st.visits.find((v) => v.id === id)!
assert(!!v5.loans[0].returnedAt, '轮椅归还入库有时间戳')
assert(v5.status === 'completed' && v5.feedback?.includes('王老师'), '归档并保留参观后偏好，供下次延续')
assert(v5.events.every((e) => typeof e.text === 'string' && e.ts), `全链路事件 ${v5.events.length} 条均完整`)

// 演示预约不应被 seed 两次
useStore.getState().seedDemo()
assert(useStore.getState().visits.length === 4, `不重复播种（实际 ${useStore.getState().visits.length}）`)

// —— 到馆参观中电梯故障：接续重算 + 观众决策 + 服务台留存 ——
{
  const seed = useStore.getState().visits.find((v) => v.party.contactName === '张女士')!
  const rid = seed.id
  assert(seed.status === 'visiting', '演示：张女士已在参观中')
  assert((seed.visitedHalls ?? []).includes('hA'), '已完成首个展厅（成果基线）')
  // 复位前面用例可能遗留的故障，建立干净基线
  useStore.getState().setGlobalSignals({ elevatorsDown: [] }, '演练复位：电梯恢复')
  const before = useStore.getState().visits.find((v) => v.id === rid)!.route!
  useStore.getState().setGlobalSignals({ elevatorsDown: ['el1'] }, '到馆演练：1号客梯故障')
  let rv = useStore.getState().visits.find((v) => v.id === rid)!
  assert(rv.route!.continuation === true, '到馆后走"从当前位置接续"重算（非从入口重来）')
  assert(rv.route!.version === before.version + 1, '接续路线版本递增')
  assert(rv.route!.stops.some((st) => st.hallId === 'hA' && st.done), '已看展厅在新路线中标记完成')
  assert(!rv.route!.trace.some((t) => t.startsWith('ev1')), '接续轨迹绕行故障电梯')
  const a = rv.route!.reroute!
  assert(!!a && a.failedElevators.includes('1号客梯'), '携带故障重算分析')
  assert(a.reasons.length > 0 && a.benefits.length > 0, '给出失效原因与参观收益')
  assert(a.needStaffPush === true, '轮椅观众判定需工作人员推行')
  assert(rv.events.some((e) => e.type === 'reroute_dispatch'), '写入"故障重算已推送"记录')

  // 观众选择：调整参观顺序
  useStore.getState().resolveReroute(rid, 'reorder')
  rv = useStore.getState().visits.find((v) => v.id === rid)!
  assert(rv.resolution?.choice === 'reorder' && rv.status === 'visiting', '观众选择调整顺序，继续参观')
  assert(rv.events.some((e) => e.type === 'resolution'), '处置选择写入同一条服务记录')

  // 服务台接手留存
  useStore.getState().deskHandleResolution(rid, '已安排志愿者在2号梯口接力推行，云端讲解已推送')
  rv = useStore.getState().visits.find((v) => v.id === rid)!
  assert(rv.resolution?.handledByDesk === true && !!rv.resolution.resultText, '服务台处理结果留存')

  // 又一部电梯故障 → 重置上一轮决策，重新等待选择
  useStore.getState().setGlobalSignals({ elevatorsDown: ['el1', 'el2'] }, '到馆演练：2号梯也故障')
  rv = useStore.getState().visits.find((v) => v.id === rid)!
  assert(!rv.resolution && !!rv.route!.reroute, '新故障重置待决策状态并重新分析')
  assert(rv.route!.reroute!.onlineSupplement === true, '双梯全停提供线上讲解补充')

  // 观众选择：改期 → 按全新一天重排且权益保留
  useStore.getState().resolveReroute(rid, 'reschedule', { rescheduleDate: '2026-10-09', rescheduleArrivalMin: 9 * 60 + 30 })
  rv = useStore.getState().visits.find((v) => v.id === rid)!
  assert(rv.status === 'rescheduled' && rv.date === '2026-10-09', '改为已改期并更新到馆日期')
  assert(!rv.route!.reroute && rv.route!.stops.length >= 2, '改期后按电梯恢复的全新一天重排完整路线')
  assert(rv.resolution?.choice === 'reschedule', '同一条服务保留改期处置结果')
}

// 另一组参观中观众：选择取消讲解 → 保留自助无障碍路线
{
  useStore.getState().setGlobalSignals({ elevatorsDown: [] }, '演练复位：电梯全部恢复')
  let lv = useStore.getState().visits.find((v) => v.party.contactName === '林先生')!
  useStore.getState().checkIn(lv.id)
  useStore.getState().setStatus(lv.id, 'visiting')
  useStore.getState().setGlobalSignals({ elevatorsDown: ['el2'] }, '到馆演练：2号梯故障')
  lv = useStore.getState().visits.find((v) => v.id === lv.id)!
  useStore.getState().resolveReroute(lv.id, 'cancel_guide')
  lv = useStore.getState().visits.find((v) => v.id === lv.id)!
  assert(lv.resolution?.choice === 'cancel_guide', '观众选择取消讲解')
  assert(!lv.route!.escortId && lv.route!.segments.length > 0, '取消陪同但保留无障碍路线')
  assert(lv.guideCancelled === true, '本次讲解取消状态留存')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
