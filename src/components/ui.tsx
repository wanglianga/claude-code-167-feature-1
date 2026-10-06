import type { ReactNode } from 'react'
import type { VisitStatus } from '../types'

export function Badge({ tone, children }: { tone?: 'brand' | 'gold' | 'red' | 'amber' | 'green' | 'blue'; children: ReactNode }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>
}

const STATUS_TEXT: Record<VisitStatus, string> = {
  booked: '已预约',
  checked_in: '已入馆',
  visiting: '参观中',
  completed: '已完成',
  cancelled: '已取消',
  rescheduled: '已改期'
}

export function StatusBadge({ status }: { status: VisitStatus }) {
  return <span className={`badge status-${status}`}>{STATUS_TEXT[status]}</span>
}

export function Notice({ kind, children }: { kind?: 'warn' | 'info' | 'ok'; children: ReactNode }) {
  const icon = kind === 'warn' ? '⚠️' : kind === 'ok' ? '✅' : 'ℹ️'
  return (
    <div className={`notice ${kind ?? ''}`}>
      <span className="ic" aria-hidden>{icon}</span>
      <div>{children}</div>
    </div>
  )
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="card" style={{ textAlign: 'center', color: 'var(--ink-2)' }}>{children}</div>
}
