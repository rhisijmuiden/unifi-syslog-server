import { useState } from 'react'
import { Users as UsersIcon, Plus, Pencil, Trash2 } from 'lucide-react'
import { api, type User } from '../api'
import { useAuth } from '../App'
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Toggle, useAsync, useToast } from '../components/ui'
import { fmtAgo } from '../lib/format'

type Edit = Partial<User> & { password?: string }

export default function UsersPage() {
  const { user: me } = useAuth()
  const toast = useToast()
  const users = useAsync(() => api.get<User[]>('/users'))
  const [edit, setEdit] = useState<Edit>()
  const save = async () => {
    try {
      if (edit!.id) await api.put('/users/' + edit!.id, edit)
      else await api.post('/users', edit)
      setEdit(undefined); users.reload(); toast('ok', 'User saved')
    } catch (e) { toast('err', (e as Error).message) }
  }
  return (
    <>
      <PageHeader title="Users" subtitle="Local accounts and users signed in via Microsoft Entra" icon={<UsersIcon className="size-5" />}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit({ username: '', role: 'viewer', password: '' })}>New user</Button>} />
      <Card pad={false}>
        {!users.data ? <div className="grid place-items-center py-16"><Spinner /></div> : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr className="border-b border-app">
              <th className="px-5 py-3 font-medium">User</th><th className="px-3 py-3 font-medium">Role</th><th className="px-3 py-3 font-medium">Source</th><th className="px-3 py-3 font-medium">Last sign-in</th><th className="px-5 py-3" />
            </tr></thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id} className="border-b border-app/60">
                  <td className="px-5 py-3"><div className="font-medium">{u.name || u.username}{u.disabled && <Badge className="ml-2">disabled</Badge>}</div><div className="text-xs text-muted">{u.username}{u.email && u.email !== u.username ? ` · ${u.email}` : ''}</div></td>
                  <td className="px-3 py-3">{u.role === 'admin' ? <Badge className="bg-indigo-500/15 text-indigo-400 ring-indigo-500/30">Admin</Badge> : <Badge>Viewer</Badge>}</td>
                  <td className="px-3 py-3 text-muted">{u.provider === 'entra' ? 'Microsoft Entra' : 'Local'}</td>
                  <td className="px-3 py-3 text-muted">{u.last_login ? fmtAgo(u.last_login * 1000) : 'never'}</td>
                  <td className="px-5 py-3 text-right">
                    <button onClick={() => setEdit({ ...u, password: '' })} className="cursor-pointer rounded-lg p-2 hover:bg-[var(--panel-2)]"><Pencil className="size-4" /></button>
                    {u.id !== me.id && <button onClick={async () => { if (confirm(`Delete ${u.username}?`)) { await api.del('/users/' + u.id); users.reload() } }} className="cursor-pointer rounded-lg p-2 text-red-500 hover:bg-red-500/10"><Trash2 className="size-4" /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(undefined)} title={edit?.id ? 'Edit user' : 'New user'}
        footer={<><Button onClick={() => setEdit(undefined)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
        {edit && (
          <div className="space-y-4">
            <Field label="Username"><Input value={edit.username} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="E-mail"><Input value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            </div>
            <Field label="Role"><Select value={edit.role ?? 'viewer'} onChange={(role) => setEdit({ ...edit, role: role as User['role'] })} options={[{ value: 'viewer', label: 'Viewer: view logs and dashboards' }, { value: 'admin', label: 'Admin: full access' }]} /></Field>
            {edit.provider !== 'entra' && <Field label={edit.id ? 'New password (optional)' : 'Password'} hint="At least 10 characters"><Input type="password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>}
            {edit.id && <Toggle checked={!!edit.disabled} onChange={(disabled) => setEdit({ ...edit, disabled })} label="Disabled" description="Can no longer sign in" />}
          </div>
        )}
      </Modal>
    </>
  )
}
