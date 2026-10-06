// 领域模型：一次无障碍参观服务涉及的预约、路线、设备、人员与服务记录

export type Floor = -1 | 1 | 2 | 3

export type NodeKind =
  | 'entrance'
  | 'desk'
  | 'hall'
  | 'elevator'
  | 'rest'
  | 'toilet'
  | 'parking'
  | 'stairs'
  | 'ramp'

export interface GraphNode {
  id: string
  name: string
  floor: Floor
  x: number
  y: number
  kind: NodeKind
}

export interface Edge {
  id: string
  a: string
  b: string
  kind: 'flat' | 'ramp' | 'elevator' | 'stairs'
  distance: number // 米
  slope?: number // 百分比，坡道用
  elevatorId?: string
}

export interface HallInfo {
  id: string
  name: string
  theme: string
  viewMin: number
  popularity: number
  highlights: string[] // 重点展品（用于故障重算后说明"仍保留哪些重点展品"）
  onlineCode?: string // 线上云讲解编号（现场无法到达时补充）
}

export interface ElevatorInfo {
  id: string
  name: string
  floors: Floor[]
}

export interface PartyProfile {
  contactName: string
  phone: string
  size: number // 参观人数
  usesWheelchair: boolean // 自带/使用轮椅
  borrowWheelchair: boolean // 向馆方借用轮椅
  needSign: boolean // 手语讲解
  needSlow: boolean // 慢速讲解
  hasElder: boolean
  hasChild: boolean
  needParking: boolean // 近距离（无障碍）车位
  canStandLong: boolean // 能否长时间站立
  extraCompanions?: number // 入馆当天临时增加的陪同人数
  preferredHallIds?: string[] // 观众勾选的重点展厅（故障后优先保留、重排顺序）
}

export type EventType =
  | 'book'
  | 'checkin'
  | 'route_change'
  | 'wheelchair_loan'
  | 'wheelchair_return'
  | 'escort_assign'
  | 'parking'
  | 'assist'
  | 'incident'
  | 'complete'
  | 'note'
  | 'recovery' // 电梯故障后观众处置选择（调整顺序/改期/取消讲解）与服务台受理

/** 故障重算后观众的处置选择 */
export type RecoveryChoice = 'reorder' | 'reschedule' | 'cancel_guide'

export interface RecoveryDecision {
  choice: RecoveryChoice
  at: string // ISO
  note?: string // 改期日期 / 取消讲解原因等
  handledBy?: string // 服务台受理人
  handledAt?: string
}

/** 故障导致的"展区失效"明细（对观众解释用） */
export interface HallImpact {
  hallId: string
  reason: string // 失效原因（电梯停用/闭馆/拥挤/体力等）
}

/** 电梯故障路线重算分析：失效原因 × 新路线 × 参观收益 */
export interface DisruptionInfo {
  kind: 'elevator' | 'other'
  trigger: string // 触发原因（人类可读），如"通往 F3 的 1 号客梯停用"
  reasons: string[] // 失效原因清单（含绕行、楼层影响、拥挤变化）
  affectedHalls: HallImpact[] // 相比上一版新失效的重点展厅
  keptHalls: string[] // 新路线仍保留的重点展厅 id
  substitutedHalls: Array<{ hallId: string; forHallId: string; reason: string }> // 可替代展区
  candidates: Array<{ hallId: string; reason: string }> // 观众可勾选加入的可替代展区
  delayMin: number // 预计延误（新路线结束时间 − 原计划结束时间；提前为负）
  extraDistance: number // 新增步行距离（米；缩短为负）
  needStaffPush: boolean // 是否需要工作人员全程/节点推行
  pushReasons: string[] // 推行需求依据
  benefits: string[] // 新参观收益：保留重点展品 / 缩短步行 / 线上讲解补充等
  onlineHalls: string[] // 提供线上云讲解补充的失效展厅 id
  prevVersion: number // 对比的上一版路线版本
}

export interface ServiceEvent {
  id: string
  ts: string // ISO
  type: EventType
  actor: string
  text: string
}

export type VisitStatus = 'booked' | 'checked_in' | 'visiting' | 'completed' | 'cancelled'

export interface RouteSeg {
  id: string
  from: string
  to: string
  via: string[] // 途经节点
  kind: 'flat' | 'ramp' | 'elevator'
  distance: number
  maxSlope?: number
  walkMin: number
  arriveMin: number // 到达 to 节点的时刻（当日分钟数）
  isRest?: boolean
  restNode?: string
  toiletNode?: string
  assist?: string
  warning?: string
  stayMin?: number // 终点停留（休息/观展/登记）分钟
  title?: string
}

export interface HallStop {
  hallId: string
  arriveMin: number
  leaveMin: number
  crowd: number
  assist?: string
  online?: boolean // 该展区以"线上云讲解"方式补充（无现场到达）
}

export interface SkippedHall {
  hallId: string
  reason: string
}

export interface RoutePlan {
  version: number
  generatedAt: string
  arrivalMin: number
  startNode: string
  endNode: string
  segments: RouteSeg[]
  stops: HallStop[]
  skipped: SkippedHall[]
  trace: string[] // 实际采用的边 id（地图高亮）
  notices: string[]
  totalDistance: number
  totalWalkMin: number
  totalMin: number
  endMin: number
  escortId?: string
  escortKind?: '讲解员' | '志愿者'
  escortName?: string
  escortIssue?: string
  parkingSlot?: string
  parkingIssue?: string
  wheelchairNeeded?: boolean
  wheelchairIssue?: string
  signals?: string // 生成路线时的现场信号快照，用于提示"情况已变化需重新规划"
  reduced?: boolean // 因身体不适等缩减
  guideCancelled?: boolean // 观众选择"取消现场讲解"：仅保留无障碍到达路线，讲解改为线上云讲解
  disruption?: DisruptionInfo // 相比上一版的故障重算分析（v1 或已恢复时为 undefined）
}

export interface Loan {
  id: string
  assetCode: string
  loanedAt?: string
  returnedAt?: string
}

export interface Visit {
  id: string
  code: string
  date: string // YYYY-MM-DD
  baseArrivalMin: number // 预约基准入馆分钟数（迟到等信号在此之上叠加）
  status: VisitStatus
  party: PartyProfile
  route?: RoutePlan
  loans: Loan[]
  escortId?: string
  events: ServiceEvent[]
  feedback?: string
  createdAt: string
  // —— 电梯故障处置：观众决定与服务台受理（同一条服务留痕）——
  recovery?: RecoveryDecision
  recoveryAckAt?: string // 服务台已确认重算结果并主动告知观众
  guideCancelled?: boolean // 观众选择"取消现场讲解"（可由服务台恢复）
  visitedHallIds?: string[] // 故障发生时观众已参观完成的展厅（续览重算的起点）
  originalDate?: string // 改期前原日期
  originalArrivalMin?: number // 改期前原到馆时间
}

export interface Staff {
  id: string
  name: string
  role: '讲解员' | '志愿者'
  skills: Array<'sign' | 'slow' | 'wheelchair'>
  onLeave: string[] // 请假日期
  shiftStartMin: number
  shiftEndMin: number
}
