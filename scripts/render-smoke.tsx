// React 渲染冒烟：在 node 中用 renderToString 渲染全部路由，不依赖浏览器
const mem = new Map()
globalThis.localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear()
}

const React = require('react').default || require('react')
// SSR 下 useSyncExternalStore 默认取服务端快照（空 store），垫片为当前内存快照
React.useSyncExternalStore = (_sub: unknown, getSnap: () => unknown) => getSnap()
const { renderToString } = require('react-dom/server')
const { StaticRouter } = require('react-router-dom/server')
const { default: App } = require('../src/App.tsx')
const { useStore } = require('../src/store.ts')

let pass = 0, fail = 0
const assert = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)) }

useStore.getState().resetDemo()
useStore.getState().seedDemo()

function renderAt(path) {
  return renderToString(
    React.createElement(StaticRouter, { location: path },
      React.createElement(App))
  )
}

const home = renderAt('/')
assert(home.includes('畅观博物馆'), '首页渲染品牌名')
assert(home.includes('新建无障碍预约'), '首页含新建预约入口')
assert(home.includes('MV-'), '首页渲染演示预约编号')

const book = renderAt('/book')
assert(book.includes('无障碍参观预约'), '预约页渲染标题')
assert(book.includes('参观日期') && book.includes('参观人数'), '预约页含参观日期/人数字段')
assert(book.includes('手语讲解') && book.includes('慢速讲解'), '含手语/慢速讲解选项')
assert(book.includes('近距离无障碍车位'), '含近距离停车选项')
assert(book.includes('不能长时间站立'), '含能否长时间站立选项')
assert(book.includes('最想看的重点展厅'), '预约时可勾选重点展厅（故障后优先保留）')
assert(book.includes('路线可行性预估'), '填写时实时给出可行性预估')

const ops0 = renderAt('/ops')
assert(ops0.includes('馆内工作台'), '平板工作台渲染')
assert(ops0.includes('今日接应任务看板'), '展厅工作人员看到接应看板与预计到达时间')
assert(ops0.includes('现场态势与安全调度'), '含电梯/闭馆/拥挤/排班/库存调度')

const someId = useStore.getState().visits[0].id
const detail = renderAt(`/visit/${someId}`)
assert(detail.includes('无障碍参观服务'), '参观服务详情渲染')
assert(detail.includes('分段无障碍路线'), '手机端展示分段路线')
assert(detail.includes('坡道'), '路段提示坡度')
assert(detail.includes('休息点') && detail.includes('无障碍卫生间'), '提示休息点与卫生间位置')
assert(detail.includes('一条参观服务记录'), '预约/设备/人员/协助挂在同一条服务记录')

const id = useStore.getState().createVisit({
  date: new Date().toISOString().slice(0, 10), arrivalMin: 9 * 60 + 30,
  party: {
    contactName: '全需求测试', phone: '13700000000', size: 5,
    usesWheelchair: true, borrowWheelchair: true, needSign: true, needSlow: true,
    hasElder: true, hasChild: true, needParking: true, canStandLong: false, extraCompanions: 2
  }
})
const full = renderAt(`/visit/${id}`)
assert(full.includes('手语'), '全需求详情含手语')
assert(full.includes('馆区无障碍平面图'), '详情含馆区平面图')

// —— 电梯故障后：观众端重算面板 ——
useStore.getState().setGlobalSignals(
  { elevatorsDown: ['el1'], elevatorReasons: { el1: '门机故障，等待配件更换' } },
  '渲染演练：1 号客梯停用'
)
const fault = renderAt(`/visit/${id}`)
assert(fault.includes('现场路线调整通知'), '故障后展示路线重算面板')
assert(fault.includes('不是取消服务'), '明确告知不是随意取消服务')
assert(fault.includes('门机故障'), '展示电梯失效的具体原因')
assert(fault.includes('预计延误'), '展示预计延误时间')
assert(fault.includes('工作人员'), '展示是否需要工作人员推行')
assert(fault.includes('保留的原计划/重点展厅'), '展示重点展厅保留情况')
assert(fault.includes('步行距离变化'), '展示步行距离变化（缩短/增加）')
assert(fault.includes('调整后您依然能获得的参观收益'), '展示新参观收益（保留重点展品等）')
assert(fault.includes('按新顺序继续参观') && fault.includes('改期再来') && fault.includes('改为线上讲解'), '给出调整顺序/改期/取消讲解三种选择')

// 双梯全停：线上讲解补充与受理流程渲染
useStore.getState().setGlobalSignals({ elevatorsDown: ['el1', 'el2'], elevatorReasons: { el1: '门机故障', el2: '井道进水暂停使用' } }, '渲染演练：双梯停用')
const both = renderAt(`/visit/${id}`)
assert(both.includes('线上云讲解'), '无法到达的展厅提供线上云讲解补充')
assert(both.includes('两部电梯'), '说明双梯停用影响范围')

// 工作台默认选中的第一条今日预约也受故障影响；先让其提交一个待受理选择
const firstTodayId = useStore.getState().visits.filter((v) => v.date === new Date().toISOString().slice(0, 10))[0]?.id
if (firstTodayId) useStore.getState().chooseRecovery(firstTodayId, 'reorder')
const opsFault = renderAt('/ops')
assert(opsFault.includes('电梯故障处置'), '工作台展示故障处置受理区')
assert(opsFault.includes('公示原因'), '工作台可设置对观众公示的停用原因')
assert(opsFault.includes('现场参观进度'), '工作台可标记离厅进度触发续览重算')
assert(opsFault.includes('确认受理并告知观众'), '观众选择后服务台工作台出现一键受理按钮')
assert(opsFault.includes('调整参观顺序（按新路线继续）'), '工作台显示观众已做的选择')

// 观众选择取消讲解 → 已决状态与服务台受理渲染
useStore.getState().chooseRecovery(id, 'cancel_guide')
const decided = renderAt(`/visit/${id}`)
assert(decided.includes('您已选择【') && decided.includes('改为线上讲解'), '展示观众已做选择')
assert(decided.includes('服务台正在受理'), '未受理时提示等待服务台确认')
useStore.getState().handleRecovery(id, '值班主管')
const handled = renderAt(`/visit/${id}`)
assert(handled.includes('值班主管') && handled.includes('受理并确认安排'), '受理后展示受理人与确认状态')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
