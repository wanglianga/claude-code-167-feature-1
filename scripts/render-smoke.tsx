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
assert(book.includes('路线可行性预估'), '填写时实时给出可行性预估')

const ops = renderAt('/ops')
assert(ops.includes('馆内工作台'), '平板工作台渲染')
assert(ops.includes('今日接应任务看板'), '展厅工作人员看到接应看板与预计到达时间')
assert(ops.includes('现场态势与安全调度'), '含电梯/闭馆/拥挤/排班/库存调度')

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

// —— 参观中电梯故障：观众端看到重算面板（失效原因/延误/推行/收益/三选一）——
const zid = useStore.getState().visits.find((v) => v.party.contactName === '张女士').id
useStore.getState().setGlobalSignals({ elevatorsDown: ['el1'] }, '渲染演练：1号客梯故障')
const rer = renderAt(`/visit/${zid}`)
assert(rer.includes('路线已重新计算'), '观众端展示电梯故障重算面板')
assert(rer.includes('为什么路线变了'), '展示失效原因')
assert(rer.includes('预计整体延误'), '展示预计延误时间')
assert(rer.includes('工作人员推行'), '展示是否需要工作人员推行')
assert(rer.includes('保留重点展厅'), '展示保留重点展厅指标')
assert(rer.includes('参观收益'), '展示新的参观收益')
assert(rer.includes('调整参观顺序') && rer.includes('改期再来') && rer.includes('取消本次讲解'), '提供调整顺序/改期/取消讲解三选一')
assert(rer.includes('接续前已参观') || rer.includes('路线接续'), '已完成展厅作为成果保留/展示接续路线')

// 服务台端同样可见处置面板，并可推进进度
const opsRer = renderAt('/ops')
assert(opsRer.includes('路线已重新计算'), '服务台工作台嵌入重算处置面板')
assert(opsRer.includes('参观进度与当前位置'), '服务台可推进已完成展厅/校正当前位置')

// 观众做出选择后，页面展示已留存的处置结果
useStore.getState().resolveReroute(zid, 'reorder')
const resolved = renderAt(`/visit/${zid}`)
assert(resolved.includes('路线变更处置结果') && resolved.includes('服务台已留存'), '处置后展示留存结果')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
