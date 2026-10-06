import { STAFF } from '../src/data/museum'
import { analyzeReroute, planRoute, DEFAULT_SIGNALS, type LiveSignals } from '../src/lib/planner'
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

console.log('\n场景 14：观众已到馆参观中，1 号梯故障 → 从当前位置接续重算')
{
  const p = party({ borrowWheelchair: true, needSlow: true, hasElder: true, canStandLong: false })
  const prev = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  const doneHall = prev.stops[0].hallId
  const doneAt = prev.stops[0].leaveMin
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, elevatorsDown: ['el1'] }
  const next = planRoute({
    party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF,
    version: 2, continuationStart: doneHall, continuationAtMin: doneAt,
    completedHalls: [doneHall], completedStops: prev.stops
  })
  assert(next.continuation === true && next.continuationNode === doneHall, '标记为从当前位置接续')
  assert(next.stops.some((s) => s.hallId === doneHall && s.done), '已完成展厅保留并标记完成')
  assert(next.stops.filter((s) => !s.done).length >= 1, `剩余仍可排 ${next.stops.filter((s) => !s.done).length} 个展厅`)
  assert(!next.trace.some((id) => id.startsWith('ev1')), '接续轨迹不含故障电梯')
  assert(next.segments.some((s) => (s.title ?? '').includes('路线接续起点')), '时间线含接续起点')
  assert(!next.notices.some((n) => n.includes('轮椅库存充足')), '接续路线不重复入馆设备提示')
}

console.log('\n场景 15：接续重算分析 → 失效原因/延误/推行/收益')
{
  const p = party({ borrowWheelchair: true, needSlow: true, hasElder: true, canStandLong: false })
  const prev = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  const doneHall = prev.stops[0].hallId
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, elevatorsDown: ['el1'] }
  const next = planRoute({
    party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF,
    version: 2, continuationStart: doneHall, continuationAtMin: prev.stops[0].leaveMin,
    completedHalls: [doneHall], completedStops: prev.stops
  })
  const a = analyzeReroute({ prev, next, signals: sig, party: p, completedHalls: [doneHall] })
  assert(a.failedElevators.includes('1号客梯'), '列出故障电梯名称')
  assert(a.reasons.some((r) => r.includes('设备保护') || r.includes('停用')), '给出观众可读的失效原因')
  assert(a.delayMin >= 0, `预计延误 ${a.delayMin} 分钟（非负）`)
  assert(a.needStaffPush === true, '轮椅观众单梯运行判定需工作人员推行')
  assert(!!a.staffPushText && a.staffPushText.includes('接力推行'), '给出推行协助说明')
  assert(a.retainedHalls.length >= 1, `保留重点展厅 ${a.retainedHalls.length} 个`)
  assert(a.benefits.some((b) => b.includes('保留重点展品')), '收益含"保留重点展品"')
  assert(a.benefits.some((b) => b.includes('计入本次参观成果')), '收益含已参观成果保留')
  assert(a.options.reorder && a.options.reschedule && a.options.cancelGuide, '三种处置方式可选')
}

console.log('\n场景 16：参观中双梯全停 → 楼上展厅丢失、线上补充、建议改期')
{
  const p = party({ usesWheelchair: true })
  const prev = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  const doneHall = prev.stops[0].hallId
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, elevatorsDown: ['el1', 'el2'] }
  const next = planRoute({
    party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF,
    version: 2, continuationStart: doneHall, continuationAtMin: prev.stops[0].leaveMin,
    completedHalls: [doneHall], completedStops: prev.stops
  })
  const a = analyzeReroute({ prev, next, signals: sig, party: p, completedHalls: [doneHall] })
  assert(next.stops.filter((s) => !s.done).length === 0, '接续后无可达新展厅')
  assert(a.lostHalls.length >= 1, `丢失楼上展厅 ${a.lostHalls.length} 个`)
  assert(a.onlineSupplement === true && !!a.onlineText, '提供线上讲解补充')
  assert(a.options.reorder === false && a.options.reschedule, '无法继续路线时推荐改期')
  assert(a.reasons.some((r) => r.includes('没有可承载轮椅') || r.includes('暂不能无障碍到达')), '说明跨层暂不可达')
  assert(next.notices.some((n) => n.includes('暂无法乘梯返回一层服务台')), '无法返回服务台时给出陪同/护送安全提示')
}

console.log('\n场景 17：取消讲解的接续路线 → 无陪同但保留无障碍路线')
{
  const p = party({ borrowWheelchair: true })
  const prev = planRoute({ party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: DEFAULT_SIGNALS, visits: [], staff: STAFF })
  const sig: LiveSignals = { ...DEFAULT_SIGNALS, elevatorsDown: ['el1'] }
  const next = planRoute({
    party: p, date: DATE, arrivalMin: 9 * 60 + 30, signals: sig, visits: [], staff: STAFF,
    version: 2, continuationStart: 'desk', continuationAtMin: prev.arrivalMin, noEscort: true
  })
  assert(!next.escortId, '取消讲解后不排陪同')
  assert(next.segments.length > 0, '仍保留无障碍分段路线')
  assert(next.notices.some((n) => n.includes('取消人工讲解')), '提示自助讲解器/图文卡')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
