import { STAFF } from '../src/data/museum'
import { planRoute, DEFAULT_SIGNALS, type LiveSignals } from '../src/lib/planner'
import type { PartyProfile, Visit } from '../src/types'
import { uid, shortCode } from '../src/utils'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log('  ✅', msg) }
  else { fail++; console.log('  ❌', msg) }
}

function party(over: Partial<PartyProfile> = {}): PartyProfile {
  return {
    contactName: '测试', phone: '13800000000', size: 2,
    usesWheelchair: false, borrowWheelchair: false, needSign: false, needSlow: false,
    hasElder: false, hasChild: false, needParking: false, canStandLong: true, extraCompanions: 0,
    ...over
  }
}

function makeVisit(date: string, arrivalMin: number, p: PartyProfile, status: Visit['status'] = 'booked'): Visit {
  return {
    id: uid('v'), code: shortCode(), date, baseArrivalMin: arrivalMin, status, party: p,
    loans: [], events: [], createdAt: new Date().toISOString()
  }
}

const DATE = '2026-10-06'

console.log('\n场景 1：轮椅 + 慢速讲解 + 老人 + 无障碍车位 + 不能久站')
{
  const p = party({ borrowWheelchair: true, needSlow: true, hasElder: true, needParking: true, canStandLong: false })
  const plan = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  assert(plan.stops.length >= 2 && plan.stops.length <= 3, `低体力队伍排 ${plan.stops.length} 个展厅（期望 2–3）`)
  assert(!!plan.parkingSlot, `预留车位 ${plan.parkingSlot}`)
  assert(!!plan.escortId, `安排陪同：${plan.escortKind}${plan.escortName}`)
  assert(plan.totalDistance > 0 && plan.totalDistance < 800, `总步行 ${plan.totalDistance} 米（期望 <800）`)
  assert(plan.segments.some((s) => s.restNode), '路线包含休息点')
  assert(plan.segments.some((s) => s.toiletNode), '路线包含无障碍卫生间')
  assert(plan.segments.some((s) => s.kind === 'elevator'), '跨层使用电梯')
  assert(plan.trace.length > 3, `地图轨迹含 ${plan.trace.length} 条边`)
  const ramps = plan.segments.filter((s) => s.kind === 'ramp')
  assert(ramps.every((r) => r.maxSlope !== undefined), `每段坡道都标注坡度（${ramps.length} 段坡道）`)
  assert(plan.stops.every((st) => st.arriveMin >= st.leaveMin - 60 && st.arriveMin < st.leaveMin), '每厅到达早于离开')
}

console.log('\n场景 2：普通观众全覆盖')
{
  const p = party({ size: 4 })
  const plan = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 15, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  assert(plan.stops.length >= 4, `普通体力排 ${plan.stops.length} 个展厅（期望 ≥4）`)
  assert(plan.endMin <= 17 * 60, `${plan.endMin} 在闭馆前结束`)
}

console.log('\n场景 3：一部电梯故障 → 自动绕行另一部')
{
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, elevatorsDown: ['el1'] }
  const p = party({ usesWheelchair: true })
  const plan = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF })
  assert(plan.notices.some((n) => n.includes('1号客梯临时故障')), '提示电梯故障改走 2 号')
  assert(plan.stops.length >= 2, `仍可经 2 号梯到达 ${plan.stops.length} 个展厅`)
  assert(!plan.trace.some((id) => id.startsWith('ev1')), '轨迹中不使用故障电梯')
}

console.log('\n场景 4：两部电梯全部故障 → 不崩溃，跨层展厅跳过')
{
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, elevatorsDown: ['el1', 'el2'] }
  const p = party({ borrowWheelchair: true })
  const plan = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF })
  assert(plan.segments.length >= 0, '未崩溃，返回了计划')
  assert(plan.stops.length === 0, `楼上展厅均不可达（排 ${plan.stops.length} 个）`)
  assert(plan.skipped.length === 6, `6 个展厅全部给出跳过原因`)
}

console.log('\n场景 5：轮椅库存不足（12 台被占用）')
{
  const others: Visit[] = Array.from({ length: 12 }, () => {
    const v = makeVisit(DATE, 10 * 60, party({ borrowWheelchair: true }))
    return v
  })
  const p = party({ borrowWheelchair: true })
  const plan = planRoute({ party: p, date: DATE, arrivalMin: 14 * 60, signals: DEFAULT_SIGNALS, visits: others, staff: STAFF })
  assert(!!plan.wheelchairIssue, `库存不足提示：${plan.wheelchairIssue?.slice(0, 24)}…`)
}

console.log('\n场景 6：迟到 40 分钟 → 接应时间顺延并重查拥挤')
{
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, lateMin: 40 }
  const p = party()
  const plan = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF })
  assert(plan.arrivalMin === 10 * 60 + 10, `实际入馆分钟 ${plan.arrivalMin}（期望 610）`)
  assert(plan.notices.some((n) => n.includes('迟到')), '提示迟到顺延')
}

console.log('\n场景 7：某展厅过度拥挤（人工 88%）→ 自动避让')
{
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, crowdOverride: { hF: 0.88 } }
  const p = party({ hasChild: true }) // 儿童本来优先 hF
  const plan = planRoute({ party: p, date: DATE, arrivalMin: 10 * 60, signals: sig, visits: [], staff: STAFF })
  assert(!plan.stops.some((s) => s.hallId === 'hF'), '自然馆过挤，未排入')
  assert(plan.skipped.some((s) => s.hallId === 'hF' && s.reason.includes('过度拥挤')), '给出拥挤避让原因')
}

console.log('\n场景 8：手语讲解员请假且无冗余 → issue 降级方案')
{
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, staffExtraLeave: ['s1', 's3'] }
  const p = party({ needSign: true })
  const plan = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF })
  assert(!!plan.escortIssue && plan.escortIssue.includes('手语'), `降级方案：${plan.escortIssue?.slice(0, 30)}…`)
}

console.log('\n场景 9：讲解员时间冲突 → 自动换班')
{
  const p1 = party({ needSlow: true, usesWheelchair: true })
  const v1 = makeVisit(DATE, 9 * 60 + 30, p1)
  const plan1 = planRoute({ party: p1, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  v1.route = plan1; v1.escortId = plan1.escortId
  const p2 = party({ needSlow: true })
  const plan2 = planRoute({ party: p2, date: DATE, arrivalMin: 9 * 60 + 40, signals: DEFAULT_SIGNALS, visits: [v1], staff: STAFF })
  assert(plan2.escortId !== plan1.escortId, `两组重叠预约分到不同陪同（${plan1.escortName} / ${plan2.escortName ?? '无'}）`)
}

console.log('\n场景 10：观众身体不适 → 缩减路线、加长休息')
{
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, visitorUnwell: true }
  const p = party({ size: 3 })
  const plan = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF })
  assert(plan.reduced === true, '标记为缩减路线')
  assert(plan.stops.length <= 2, `最多 ${plan.stops.length} 个展厅（期望 ≤2）`)
  assert(plan.totalDistance <= 400, `步行 ${plan.totalDistance} 米（期望 ≤400）`)
  assert(plan.segments.some((s) => (s.stayMin ?? 0) >= 15), '安排 ≥15 分钟加长休息')
}

console.log('\n场景 11：临时闭馆 → 跳过并说明')
{
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, closedHalls: ['hC'] }
  const plan = planRoute({ party: party(), date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF })
  assert(!plan.stops.some((s) => s.hallId === 'hC'), '陶瓷馆闭馆，未排入')
  assert(plan.skipped.some((s) => s.hallId === 'hC' && s.reason.includes('临时闭馆')), '记录闭馆原因')
}

console.log('\n场景 12：无障碍车位约满（8 组已约）')
{
  const others = Array.from({ length: 8 }, () => makeVisit(DATE, 11 * 60, party({ needParking: true })))
  const plan = planRoute({ party: party({ needParking: true }), date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: others, staff: STAFF })
  assert(!!plan.parkingIssue, `车位协调方案：${plan.parkingIssue?.slice(0, 20)}…`)
}

console.log('\n场景 13：陪同人临时增加不影响生成；各段时刻单调递增')
{
  const p = party({ extraCompanions: 3 })
  const plan = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  const mins = plan.segments.map((s) => s.arriveMin)
  assert(mins.every((m, i) => i === 0 || m >= mins[i - 1]), '路段到达时间单调不减')
  assert(plan.totalMin > 0, '全程时长为正')
}

console.log('\n场景 14：观众标记重点展厅 → 故障重算优先保留并给出失效原因/收益/推行/延误')
{
  const p = party({ borrowWheelchair: true, preferredHallIds: ['hA', 'hC'] })
  const v1 = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  assert(v1.stops[0].hallId === 'hA', `重点展厅优先：首厅为 ${v1.stops[0]?.hallId}（期望 hA）`)
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, elevatorsDown: ['el1'], elevatorReasons: { el1: '门机故障，等待配件更换' } }
  const v2 = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF, version: 2, prevPlan: v1 })
  const d = v2.disruption
  assert(!!d, 'v2 携带故障重算分析 disruption')
  assert(d!.reasons.some((r) => r.includes('1号客梯') && r.includes('门机故障')), '公示电梯停用具体原因')
  assert(d!.reasons.some((r) => r.includes('2号无障碍电梯')), '说明改乘备用电梯')
  assert(typeof d!.delayMin === 'number', `给出预计延误字段（${d!.delayMin} 分钟）`)
  assert(d!.needStaffPush === true, '轮椅观众绕行判定需要工作人员推行')
  assert(d!.pushReasons.length > 0, '给出推行需求依据（坡道/绕行距离/接应）')
  assert(d!.benefits.length >= 2, `给出 ${d!.benefits.length} 条新参观收益（保留重点/延误说明等）`)
  assert(!v2.trace.some((id) => id.startsWith('ev1')), '新轨迹不使用故障电梯')
}

console.log('\n场景 15：双梯全停重算 → 重点展厅全部失效、给线上讲解、候选展区为空、不崩溃')
{
  const p = party({ borrowWheelchair: true, needSlow: true })
  const v1 = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  const before = v1.stops.length
  assert(before >= 2, `原计划可排 ${before} 个展厅`)
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, elevatorsDown: ['el1', 'el2'] }
  const v2 = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF, version: 2, prevPlan: v1 })
  const d = v2.disruption!
  assert(v2.stops.length === 0, '双梯停用无跨层现场展厅')
  assert(d.affectedHalls.length === before, `${before} 个未参观重点展厅全部列入失效说明（实际 ${d.affectedHalls.length}）`)
  assert(d.affectedHalls.every((a) => a.reason.includes('电梯')), '每个失效展厅都解释与电梯停用的关系')
  assert(d.candidates.length === 0, '无可达候选展区')
  assert(d.onlineHalls.length === before, `失效展厅全部配发线上云讲解（${d.onlineHalls.length} 个）`)
  assert(d.benefits.some((b) => b.includes('CLOUD-')), '收益中明示云讲解编号与 7 天回看')
  assert(d.reasons.some((r) => r.includes('两部电梯')), '说明双梯均不可用、楼梯不能通行轮椅')
}

console.log('\n场景 16：观众选择取消现场讲解 → 仅保留无障碍路线，讲解改线上，陪同降级为物理协助')
{
  const p = party({ borrowWheelchair: true, needSlow: true })
  const v1 = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, elevatorsDown: ['el1'] }
  const v2 = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF, version: 2, prevPlan: v1, guideCancelled: true })
  assert(v2.guideCancelled === true, '标记为已取消现场讲解')
  assert(v2.notices.some((n) => n.includes('取消今天的现场讲解')), '提示保留路线/设备、讲解改线上')
  assert(v2.stops.every((st) => st.assist.includes('线上云讲解')), '每个可达展厅改为线上云讲解+定点协助提示')
  assert(v2.segments.some((s) => (s.title ?? '').includes('线上云讲解')), '时间线标注线上云讲解编号')
  assert(v2.disruption!.onlineHalls.length >= 0, '失效展厅云讲解清单已生成')
  assert(!v2.escortName || v2.notices.some((n) => n.includes('物理协助')), '不再排全程讲解员，仅保留轮椅推行等物理协助')
}

console.log('\n场景 17：故障时观众已参观部分展厅 → 续览路线不折返、不重复、已看厅不算失效')
{
  const p = party({ borrowWheelchair: true })
  const v1 = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  const firstHall = v1.stops[0].hallId
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, elevatorsDown: ['el2'] }
  const v2 = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF, version: 2, prevPlan: v1, visitedHallIds: [firstHall] })
  assert(v2.startNode.includes('续览'), `续览起点标注：${v2.startNode}`)
  assert(!v2.stops.some((s) => s.hallId === firstHall), '已参观展厅不重复排入')
  assert(!v2.skipped.some((s) => s.hallId === firstHall), '已参观展厅不出现在跳过清单')
  assert(!v2.segments.some((s) => (s.title ?? '').includes('核验')), '续览路线不再包含服务台入馆路段')
  assert(!v2.disruption!.affectedHalls.some((a) => a.hallId === firstHall), '已参观展厅不计为"失效"')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
