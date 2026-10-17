import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, ScrollText, Tags, Router as RouterIcon, MapPin, BellRing, Users, KeyRound, Mail, DatabaseBackup,
  Settings, History, Info, LogOut, Moon, Sun, Menu, X, Radio,
} from 'lucide-react'
import { api, type User } from './api'
import { cx, Spinner, ToastProvider } from './components/ui'
import InfoModal from './components/InfoModal'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Logs from './pages/Logs'
import Categories from './pages/Categories'
import Devices from './pages/Devices'
import Sites from './pages/Sites'
import Alerts from './pages/Alerts'
import UsersPage from './pages/Users'
import SSO from './pages/SSO'
import MailPage from './pages/Mail'
import Backup from './pages/Backup'
import SettingsPage from './pages/Settings'
import Audit from './pages/Audit'

interface AuthCtx { user: User; instance: string; logout: () => void }
const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx)
export const useAuth = () => useContext(Ctx)

function useTheme() {
  const [dark, setDark] = useState(() => {
    try { const v = localStorage.getItem('uss-theme'); if (v) return v === 'dark' } catch { /* ignore */ }
    return true
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try { localStorage.setItem('uss-theme', dark ? 'dark' : 'light') } catch { /* ignore */ }
  }, [dark])
  return [dark, setDark] as const
}

export default function App() {
  const [state, setState] = useState<{ loading: boolean; user?: User; instance: string; sso?: { enabled: boolean; label: string }; error?: string }>({ loading: true, instance: 'UniFi Syslog Server' })
  const load = () =>
    api.get<{ user?: User; instance: string; sso: { enabled: boolean; label: string } }>('/auth/status' + window.location.search)
      .then((s) => setState({ loading: false, user: s.user, instance: s.instance, sso: s.sso, error: new URLSearchParams(window.location.search).get('error') ?? undefined }))
      .catch(() => setState((s) => ({ ...s, loading: false })))
  useEffect(() => {
    load()
    const h = () => setState((s) => ({ ...s, user: undefined }))
    window.addEventListener('uss:unauthorized', h)
    return () => window.removeEventListener('uss:unauthorized', h)
  }, [])

  if (state.loading) return <div className="grid h-full place-items-center"><Spinner className="size-8" /></div>
  return (
    <ToastProvider>
      <BrowserRouter>
        {!state.user ? (
          <Login instance={state.instance} sso={state.sso} initialError={state.error} onLogin={(u) => { window.history.replaceState(null, '', '/'); setState((s) => ({ ...s, user: u })) }} />
        ) : (
          <Ctx.Provider value={{ user: state.user, instance: state.instance, logout: async () => { await api.post('/auth/logout'); setState((s) => ({ ...s, user: undefined })) } }}>
            <Shell />
          </Ctx.Provider>
        )}
      </BrowserRouter>
    </ToastProvider>
  )
}

interface NavItem { to: string; label: string; icon: ReactNode; admin?: boolean }
const nav: { section: string; items: NavItem[] }[] = [
  { section: 'Monitoring', items: [
    { to: '/', label: 'Overzicht', icon: <LayoutDashboard /> },
    { to: '/logs', label: 'Logs', icon: <ScrollText /> },
    { to: '/categories', label: 'Categorieën', icon: <Tags /> },
    { to: '/devices', label: 'Apparaten', icon: <RouterIcon /> },
  ] },
  { section: 'Configuratie', items: [
    { to: '/sites', label: 'Locaties', icon: <MapPin />, admin: true },
    { to: '/alerts', label: 'Meldingen', icon: <BellRing />, admin: true },
  ] },
  { section: 'Beheer', items: [
    { to: '/users', label: 'Gebruikers', icon: <Users />, admin: true },
    { to: '/sso', label: 'Microsoft Entra SSO', icon: <KeyRound />, admin: true },
    { to: '/mail', label: 'Mailserver', icon: <Mail />, admin: true },
    { to: '/backup', label: 'Back-up & herstel', icon: <DatabaseBackup />, admin: true },
    { to: '/settings', label: 'Instellingen', icon: <Settings />, admin: true },
    { to: '/audit', label: 'Auditlog', icon: <History />, admin: true },
  ] },
]

function Shell() {
  const { user, instance, logout } = useAuth()
  const [dark, setDark] = useTheme()
  const [info, setInfo] = useState(false)
  const [mobile, setMobile] = useState(false)
  const loc = useLocation()
  useEffect(() => setMobile(false), [loc.pathname])
  const isAdmin = user.role === 'admin'

  const sidebar = (
    <aside className="flex h-full w-64 flex-col border-r border-app bg-[var(--panel)]">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-500 text-white shadow-lg shadow-indigo-500/30"><Radio className="size-5" /></div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{instance}</div>
          <div className="text-[11px] text-muted">Centrale UniFi-logging</div>
        </div>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto scroll-thin px-3 pb-4">
        {nav.map((g) => {
          const items = g.items.filter((i) => !i.admin || isAdmin)
          if (!items.length) return null
          return (
            <div key={g.section}>
              <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted">{g.section}</div>
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'}
                  className={({ isActive }) => cx('group flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition [&_svg]:size-4',
                    isActive ? 'bg-gradient-to-r from-indigo-500/15 to-cyan-500/10 text-indigo-400 font-medium ring-1 ring-indigo-500/20' : 'text-muted hover:bg-[var(--panel-2)] hover:text-[var(--text)]')}>
                  {i.icon}{i.label}
                </NavLink>
              ))}
            </div>
          )
        })}
      </nav>
      <div className="space-y-1 border-t border-app p-3">
        <button onClick={() => setInfo(true)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted hover:bg-[var(--panel-2)] hover:text-[var(--text)] cursor-pointer [&_svg]:size-4">
          <Info /> Info & updates
        </button>
        <button onClick={() => setDark(!dark)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted hover:bg-[var(--panel-2)] hover:text-[var(--text)] cursor-pointer [&_svg]:size-4">
          {dark ? <Sun /> : <Moon />} {dark ? 'Lichte modus' : 'Donkere modus'}
        </button>
        <div className="mt-2 flex items-center gap-3 rounded-xl px-3 py-2">
          <div className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-indigo-500/30 to-cyan-500/30 text-xs font-semibold uppercase">{(user.name || user.username).slice(0, 2)}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user.name || user.username}</div>
            <div className="text-[11px] text-muted">{user.role === 'admin' ? 'Beheerder' : 'Lezer'}{user.provider === 'entra' && ' · Entra'}</div>
          </div>
          <button title="Afmelden" onClick={logout} className="rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-500 cursor-pointer"><LogOut className="size-4" /></button>
        </div>
      </div>
    </aside>
  )

  return (
    <div className="flex h-full">
      <div className="hidden lg:block">{sidebar}</div>
      {mobile && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobile(false)} />
          <div className="relative h-full w-64">{sidebar}</div>
        </div>
      )}
      <main className="min-w-0 flex-1 overflow-y-auto scroll-thin">
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-app bg-[var(--bg)]/80 px-4 py-3 backdrop-blur lg:hidden">
          <button onClick={() => setMobile(!mobile)} className="cursor-pointer">{mobile ? <X /> : <Menu />}</button>
          <span className="font-semibold">{instance}</span>
        </div>
        <div className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-8">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/devices" element={<Devices />} />
            {isAdmin && <>
              <Route path="/sites" element={<Sites />} />
              <Route path="/alerts" element={<Alerts />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/sso" element={<SSO />} />
              <Route path="/mail" element={<MailPage />} />
              <Route path="/backup" element={<Backup />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/audit" element={<Audit />} />
            </>}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
      <InfoModal open={info} onClose={() => setInfo(false)} />
    </div>
  )
}
