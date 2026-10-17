import { useState } from 'react'
import { Radio, LogIn } from 'lucide-react'
import { api, type User } from '../api'
import { Button, Field, Input } from '../components/ui'

export default function Login({ instance, sso, onLogin, initialError }: { instance: string; sso?: { enabled: boolean; label: string }; onLogin: (u: User) => void; initialError?: string }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      onLogin(await api.post<User>('/auth/login', { username, password }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden p-4">
      <div className="pointer-events-none absolute -left-40 -top-40 size-[34rem] rounded-full bg-indigo-600/25 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 size-[34rem] rounded-full bg-cyan-500/20 blur-3xl" />
      <div className="panel relative w-full max-w-sm rounded-3xl p-8 shadow-2xl fade-in">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-500 text-white shadow-xl shadow-indigo-500/30"><Radio className="size-7" /></div>
          <h1 className="text-xl font-semibold">{instance}</h1>
          <p className="mt-1 text-sm text-muted">Meld je aan om verder te gaan</p>
        </div>
        {error && <div className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-500 ring-1 ring-red-500/30">{error}</div>}
        {sso?.enabled && (
          <>
            <a href="/api/auth/entra/login" className="flex w-full items-center justify-center gap-3 rounded-xl bg-[#2f2f2f] px-4 py-2.5 text-sm font-medium text-white ring-1 ring-white/10 transition hover:bg-[#3a3a3a]">
              <svg viewBox="0 0 21 21" className="size-4"><rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" /><rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" /></svg>
              {sso.label || 'Aanmelden met Microsoft'}
            </a>
            <div className="my-5 flex items-center gap-3 text-xs text-muted"><div className="h-px flex-1 bg-[var(--border)]" />of met een lokaal account<div className="h-px flex-1 bg-[var(--border)]" /></div>
          </>
        )}
        <form onSubmit={submit} className="space-y-4">
          <Field label="Gebruikersnaam"><Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
          <Field label="Wachtwoord"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Button type="submit" variant="primary" loading={busy} className="w-full" icon={<LogIn className="size-4" />}>Aanmelden</Button>
        </form>
      </div>
    </div>
  )
}
