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

// —— 电梯故障后的路线重算与观众处置全链路 ——
const mkToday = (over: Record<string, unknown> = {}) =>
  useStore.getState().createVisit({
    date: today, arrivalMin: 10 * 60,
    party: {
      contactName: '故障演练', phone: '13800000000', size: 2,
      usesWheelchair: false, borrowWheelchair: true, needSign: false, needSlow: true,
      hasElder: true, hasChild: false, needParking: true, canStandLong: false, extraCompanions: 0,
      ...over
    } as any
  })

// 先清掉前面演练设置的迟到/不适/故障，保证本段落从干净现场开始
useStore.getState().setGlobalSignals({ elevatorsDown: [], elevatorReasons: {}, closedHalls: [], crowdOverride: {}, staffExtraLeave: [], wheelchairOffset: 0 }, '演练复位')

const rid = mkToday()
let rv = useStore.getState().visits.find((v) => v.id === rid)!
assert(!!rv.route && rv.route.version === 1, '重算演练：新预约 v1')

// 入馆借轮椅后，通往重点展厅的 1 号客梯停用
useStore.getState().checkIn(rid)
useStore.getState().loanWheelchair(rid)
useStore.getState().setGlobalSignals(
  { elevatorsDown: ['el1'], elevatorReasons: { el1: '门机故障，等待配件更换' } },
  '通往重点展厅的 1 号客梯停用演练'
)
rv = useStore.getState().visits.find((v) => v.id === rid)!
const d = rv.route!.disruption
assert(rv.route!.version === 2, '故障后路线升级 v2')
assert(!!d, 'v2 携带失效原因/收益重算分析')
assert(d!.reasons.some((r) => r.includes('1号客梯') && r.includes('门机故障')), '对观众公示电梯停用原因')
assert(d!.reasons.some((r) => r.includes('2号无障碍电梯')), '说明改乘备用电梯')
assert(typeof d!.delayMin === 'number' && d!.benefits.length >= 2, `给出预计延误（${d!.delayMin} 分钟）与 ${d!.benefits.length} 条参观收益`)
assert(d!.needStaffPush === true && d!.pushReasons.length > 0, '轮椅观众判定需要工作人员推行并给出依据')
assert(rv.events.some((e) => e.type === 'route_change'), '重算写入同一条服务记录')

// 展厅工作人员标记已完成首个展厅 → 续览重算
const firstHall = rv.route!.stops[0]?.hallId
if (firstHall) {
  useStore.getState().markHallVisited(rid, firstHall, true)
  rv = useStore.getState().visits.find((v) => v.id === rid)!
  assert(rv.visitedHallIds?.includes(firstHall), '已参观进度挂在服务上')
  assert(!rv.route!.stops.some((s) => s.hallId === firstHall), '续览路线不重复已参观展厅')
  assert(rv.route!.startNode.includes('续览'), `续览起点标注（${rv.route!.startNode}）`)
  assert(!rv.route!.disruption!.affectedHalls.some((a) => a.hallId === firstHall), '已参观展厅不算失效')
}

// 观众选择①：调整参观顺序
const rid2 = mkToday({ contactName: '顺序演练' })
useStore.getState().chooseRecovery(rid2, 'reorder')
let rv2 = useStore.getState().visits.find((v) => v.id === rid2)!
assert(rv2.recovery?.choice === 'reorder', '观众选择调整参观顺序已保存')
assert(rv2.events.some((e) => e.type === 'recovery' && e.text.includes('调整参观顺序')), '处置选择以"故障处置"事件留痕')
assert(!rv2.recovery?.handledBy, '等待服务台受理')
useStore.getState().handleRecovery(rid2, '值班主管')
rv2 = useStore.getState().visits.find((v) => v.id === rid2)!
assert(rv2.recovery?.handledBy === '值班主管' && !!rv2.recovery?.handledAt, '服务台受理结果保留（受理人+时间）')
assert(rv2.events.filter((e) => e.type === 'recovery').length >= 2, '受理再次写入服务记录')

// 观众选择③：取消现场讲解 → 保留路线/设备，改线上讲解
const rid3 = mkToday({ contactName: '取消讲解演练' })
useStore.getState().checkIn(rid3)
useStore.getState().loanWheelchair(rid3)
useStore.getState().chooseRecovery(rid3, 'cancel_guide')
let rv3 = useStore.getState().visits.find((v) => v.id === rid3)!
assert(rv3.guideCancelled === true && rv3.route!.guideCancelled === true, '标记取消现场讲解')
assert(rv3.route!.notices.some((n) => n.includes('取消今天的现场讲解')), '页面提示保留无障碍路线、讲解改线上')
assert(rv3.loans.some((l) => l.loanedAt && !l.returnedAt), '取消讲解不影响已借轮椅（设备服务保留）')
// 电梯恢复后服务台为其恢复现场讲解
useStore.getState().setGlobalSignals({ elevatorsDown: [], elevatorReasons: {} }, '电梯恢复运行演练')
useStore.getState().restoreGuide(rid3)
rv3 = useStore.getState().visits.find((v) => v.id === rid3)!
assert(rv3.guideCancelled === false && !rv3.route!.guideCancelled, '电梯恢复后可恢复现场讲解并重排陪同')

// 观众选择②：改期 → 日期/状态/轮椅归还/原日期保留
const rid4 = mkToday({ contactName: '改期演练' })
useStore.getState().checkIn(rid4)
useStore.getState().loanWheelchair(rid4)
const tomorrow = (() => { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10) })()
useStore.getState().chooseRecovery(rid4, 'reschedule', tomorrow)
const rv4 = useStore.getState().visits.find((v) => v.id === rid4)!
assert(rv4.date === tomorrow && rv4.status === 'booked', `已改期至 ${tomorrow} 且状态回到"已预约"`)
assert(rv4.originalDate === today && typeof rv4.originalArrivalMin === 'number', '保留原日期/时间备查')
assert(rv4.loans.every((l) => !!l.returnedAt), '改期离馆时在借轮椅已归还入库')
assert(!rv4.route!.disruption, '改期后的新路线不携带今日故障分析')
assert(rv4.events.some((e) => e.type === 'recovery' && e.text.includes('改期')), '改期处置写入服务记录')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
