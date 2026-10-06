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
}

export type EventType =
  | 'book'
  | 'checkin'
  | 'route_change'
  | 'reroute_dispatch'
  | 'wheelchair_loan'
  | 'wheelchair_return'
  | 'escort_assign'
  | 'parking'
  | 'assist'
  | 'incident'
  | 'complete'
  | 'note'
  | 'resolution'

export interface ServiceEvent {
  id: string
  ts: string // ISO
  type: EventType
  actor: string
  text: string
}

export type VisitStatus = 'booked' | 'checked_in' | 'visiting' | 'completed' | 'cancelled' | 'rescheduled'

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
  done?: boolean // 接续重算前已完成参观
}

export interface SkippedHall {
  hallId: string
  reason: string
}

/** 电梯故障后的路线重算分析（向观众解释"为什么变、还能得到什么"） */
export interface RerouteAnalysis {
  /** 触发重算的失效设施（电梯）名称 */
  failedElevators: string[]
  /** 观众能看懂的失效原因说明 */
  reasons: string[]
  /** 原计划中本次无法按原方式到达/受影响的重点展厅名称 */
  affectedHalls: string[]
  /** 新路线可替代安排的展区名称（绕行可达或同层加看） */
  alternativeHalls: string[]
  /** 接续后仍能保留的重点展厅名称 */
  retainedHalls: string[]
  /** 本次受故障影响而无法安排的展厅名称（含线上补充） */
  lostHalls: string[]
  /** 预计整体延误（分钟），0 表示几乎不延误 */
  delayMin: number
  /** 较原计划新增的步行距离（米），为负表示缩短 */
  extraDistance: number
  /** 是否需要工作人员推行/搀扶协助 */
  needStaffPush: boolean
  /** 推行/协助的具体说明 */
  staffPushText?: string
  /** 是否改为线上讲解补充 */
  onlineSupplement: boolean
  /** 线上讲解补充说明 */
  onlineText?: string
  /** 新参观收益（保留重点展品 / 缩短步行 / 线上补充等） */
  benefits: string[]
  /** 供观众选择的处置方式是否可用 */
  options: { reorder: boolean; reschedule: boolean; cancelGuide: boolean }
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
  // —— 参观进行中电梯故障后的接续重算 ——
  continuation?: boolean // 是否为"从当前位置接续"的重算路线
  continuationNode?: string // 接续起点节点 id（观众当前位置）
  continuationNodeName?: string
  completedStops?: string[] // 接续前已完成的展厅 id（保留为参观成果）
  reroute?: RerouteAnalysis // 故障重算分析（仅故障触发的接续路线携带）
}

export interface Loan {
  id: string
  assetCode: string
  loanedAt?: string
  returnedAt?: string
}

/** 观众在电梯故障重算后选择的处置方式（服务台留存处理结果） */
export type ResolutionChoice = 'reorder' | 'reschedule' | 'cancel_guide'

export interface RouteResolution {
  id: string
  choice: ResolutionChoice
  label: string // 观众可读的选择说明
  decidedAt: string
  decidedBy: string // 观众本人 / 服务台代操作
  failedElevators: string[] // 触发该处置的故障电梯
  planVersion: number // 处置时的路线版本
  /** reorder：接受新顺序；reschedule：改期日期与到馆时间；cancel_guide：取消讲解但保留自助参观 */
  rescheduleDate?: string
  rescheduleArrivalMin?: number
  note?: string // 服务台处理备注
  handledByDesk?: boolean // 服务台是否已接手处理
  handledAt?: string
  resultText?: string // 服务台留存的处理结果说明
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
  /** 电梯故障重算后观众的选择与服务台处理结果（同一条服务留存） */
  resolution?: RouteResolution
  /** 已完成参观的展厅 id（参观进行中故障接续时作为既有成果保留） */
  visitedHalls?: string[]
  /** 当前所在节点 id（服务台在开始参观/接应时可校正，默认按已完成进度推断） */
  currentNode?: string
  /** 本次已取消人工讲解（当日后续重算保持自助路线；改期后恢复） */
  guideCancelled?: boolean
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
