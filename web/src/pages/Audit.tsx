import { History } from 'lucide-react'
import { api } from '../api'
import { Card, PageHeader, Spinner, useAsync } from '../components/ui'
import { fmtTime } from '../lib/format'

export default function Audit() {
  const { data } = useAsync(() => api.get<{ ts: number; user: string; action: string; detail: string }[]>('/audit'))
  return (
    <>
      <PageHeader title="Audit log" subtitle="Who changed what" icon={<History className="size-5" />} />
      <Card pad={false}>
        {!data ? <div className="grid place-items-center py-16"><Spinner /></div> : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr className="border-b border-app">
              <th className="px-5 py-3 font-medium">Time</th><th className="px-3 py-3 font-medium">User</th><th className="px-3 py-3 font-medium">Action</th><th className="px-5 py-3 font-medium">Details</th>
            </tr></thead>
            <tbody>{data.map((a, i) => (
              <tr key={i} className="border-b border-app/60">
                <td className="px-5 py-2 font-mono text-xs text-muted whitespace-nowrap">{fmtTime(a.ts * 1000)}</td>
                <td className="px-3 py-2">{a.user}</td>
                <td className="px-3 py-2 font-mono text-xs">{a.action}</td>
                <td className="px-5 py-2 text-muted">{a.detail}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </>
  )
}
