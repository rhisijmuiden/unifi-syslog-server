import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, ScrollText, Tags, Router as RouterIcon, MapPin, BellRing, Users, KeyRound, Mail, DatabaseBackup,
  Settings, History, Info, LogOut, Moon, Sun, Menu, X, Languages, Palette,
  ShieldX, Wifi, Network, Lock, Siren, Smartphone, Server, Globe,
} from 'lucide-react'
import { api, brandingUrl, type Branding, type User } from './api'
import { languages, setLanguage, t } from './i18n'
import { BrandHeader } from './components/Brand'
import { cx, Spinner, ToastProvider, useToast } from './components/ui'
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
import BrandingPage from './pages/Branding'
import Audit from './pages/Audit'
import Dashboards from './pages/Dashboards'
import Controllers from './pages/Controllers'
import GeoIP from './pages/GeoIP'
import Clients from './pages/Clients'

interface AuthCtx {
  user: User
  instance: string
  branding: Branding
  serverLanguage: string
  logout: () => void
  setUser: (u: User) => void
  reloadStatus: () => void
}
const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx)
export const useAuth = () => useContext(Ctx)

interface Status {
  user?: User
  instance: string
  language: string
  branding: Branding
  sso: { enabled: boolean; label: string }
}

const noBranding: Branding = { company_name: '', version: '', assets: {} }

function useDocumentBranding(instance: string, branding: Branding) {
  useEffect(() => {
    document.title = branding.company_name ? `${instance} · ${branding.company_name}` : instance
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) return
    if (branding.assets.favicon) {
      link.removeAttribute('type')
      link.href = brandingUrl(branding, 'favicon')
    } else {
      link.type = 'image/svg+xml'
      link.href = '/favicon.svg'
    }
  }, [instance, branding])
}

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
  const [state, setState] = useState<{ loading: boolean; status?: Status; error?: string }>({ loading: true })
  const load = () =>
    api.get<Status>('/auth/status' + window.location.search)
      .then((status) => setState({ loading: false, status, error: new URLSearchParams(window.location.search).get('error') ?? undefined }))
      .catch(() => setState((s) => ({ ...s, loading: false })))
  useEffect(() => {
    load()
    const h = () => setState((s) => ({ ...s, status: s.status && { ...s.status, user: undefined } }))
    window.addEventListener('uss:unauthorized', h)
    return () => window.removeEventListener('uss:unauthorized', h)
  }, [])

  const status = state.status
  const instance = status?.instance ?? 'UniFi Syslog Server'
  const branding = status?.branding ?? noBranding
  const lang = status?.user?.language || status?.language || 'en'
  // Set before rendering children so every t() call below uses it.
  setLanguage(lang)
  useDocumentBranding(instance, branding)

  if (state.loading) return <div className="grid h-full place-items-center"><Spinner className="size-8" /></div>
  const setUser = (user?: User) => setState((s) => ({ ...s, status: s.status && { ...s.status, user } }))
  return (
    <ToastProvider>
      <BrowserRouter>
        {!status?.user ? (
          <Login instance={instance} branding={branding} sso={status?.sso} initialError={state.error} onLogin={(u) => { window.history.replaceState(null, '', '/'); setUser(u) }} />
        ) : (
          <Ctx.Provider value={{
            user: status.user, instance, branding, serverLanguage: status.language, setUser, reloadStatus: load,
            logout: async () => { await api.post('/auth/logout'); setUser(undefined) },
          }}>
            {/* Remount on language change so every page re-renders its text. */}
            <Shell key={lang} />
          </Ctx.Provider>
        )}
      </BrowserRouter>
    </ToastProvider>
  )
}

interface NavItem { to: string; label: string; icon: ReactNode; admin?: boolean }
const nav: { section: string; items: NavItem[] }[] = [
  { section: 'Monitoring', items: [
    { to: '/', label: 'Overview', icon: <LayoutDashboard /> },
    { to: '/logs', label: 'Logs', icon: <ScrollText /> },
    { to: '/categories', label: 'Categories', icon: <Tags /> },
    { to: '/devices', label: 'Devices', icon: <RouterIcon /> },
    { to: '/clients', label: 'Clients', icon: <Smartphone /> },
    { to: '/sites', label: 'Sites', icon: <MapPin /> },
  ] },
  { section: 'Dashboards', items: [
    { to: '/dashboards/firewall', label: 'Firewall', icon: <ShieldX /> },
    { to: '/dashboards/wifi', label: 'Wi-Fi', icon: <Wifi /> },
    { to: '/dashboards/dhcp', label: 'DHCP', icon: <Network /> },
    { to: '/dashboards/vpn', label: 'VPN', icon: <Lock /> },
    { to: '/dashboards/ips', label: 'Threats (IPS)', icon: <Siren /> },
  ] },
  { section: 'Configuration', items: [
    { to: '/alerts', label: 'Alerts', icon: <BellRing />, admin: true },
    { to: '/controllers', label: 'UniFi controllers', icon: <Server />, admin: true },
    { to: '/geoip', label: 'GeoIP', icon: <Globe />, admin: true },
  ] },
  { section: 'Administration', items: [
    { to: '/users', label: 'Users', icon: <Users />, admin: true },
    { to: '/sso', label: 'Microsoft Entra SSO', icon: <KeyRound />, admin: true },
    { to: '/mail', label: 'Mail server', icon: <Mail />, admin: true },
    { to: '/backup', label: 'Backup & restore', icon: <DatabaseBackup />, admin: true },
    { to: '/settings', label: 'Settings', icon: <Settings />, admin: true },
    { to: '/branding', label: 'Branding', icon: <Palette />, admin: true },
    { to: '/audit', label: 'Audit log', icon: <History />, admin: true },
  ] },
]

function Shell() {
  const { user, instance, branding, serverLanguage, logout, setUser } = useAuth()
  const toast = useToast()
  const changeLanguage = async (language: string) => {
    try { setUser(await api.put<User>('/me/language', { language })) } catch (e) { toast('err', (e as Error).message) }
  }
  const serverLangName = languages.find(([c]) => c === serverLanguage)?.[1] ?? serverLanguage
  const [dark, setDark] = useTheme()
  const [info, setInfo] = useState(false)
  const [mobile, setMobile] = useState(false)
  const loc = useLocation()
  useEffect(() => setMobile(false), [loc.pathname])
  const isAdmin = user.role === 'admin'

  const sidebar = (
    <aside className="flex h-full w-64 flex-col border-r border-app bg-[var(--panel)]">
      <BrandHeader branding={branding} instance={instance} className="px-5 py-5" />
      <nav className="flex-1 space-y-5 overflow-y-auto scroll-thin px-3 pb-4">
        {nav.map((g) => {
          const items = g.items.filter((i) => !i.admin || isAdmin)
          if (!items.length) return null
          return (
            <div key={g.section}>
              <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted">{t(g.section)}</div>
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'}
                  className={({ isActive }) => cx('group flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition [&_svg]:size-4',
                    isActive ? 'bg-gradient-to-r from-indigo-500/15 to-cyan-500/10 text-indigo-400 font-medium ring-1 ring-indigo-500/20' : 'text-muted hover:bg-[var(--panel-2)] hover:text-[var(--text)]')}>
                  {i.icon}{t(i.label)}
                </NavLink>
              ))}
            </div>
          )
        })}
      </nav>
      <div className="space-y-1 border-t border-app p-3">
        <button onClick={() => setInfo(true)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted hover:bg-[var(--panel-2)] hover:text-[var(--text)] cursor-pointer [&_svg]:size-4">
          <Info /> {t('Info & updates')}
        </button>
        <button onClick={() => setDark(!dark)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted hover:bg-[var(--panel-2)] hover:text-[var(--text)] cursor-pointer [&_svg]:size-4">
          {dark ? <Sun /> : <Moon />} {dark ? t('Light mode') : t('Dark mode')}
        </button>
        <label className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted hover:bg-[var(--panel-2)] hover:text-[var(--text)] [&_svg]:size-4">
          <Languages className="shrink-0" />
          <select aria-label={t('Language')} value={user.language_manual ? user.language : ''} onChange={(e) => changeLanguage(e.target.value)}
            className="min-w-0 flex-1 cursor-pointer appearance-none bg-transparent outline-none">
            <option value="">{t('Language')}: {t('server default ({name})', { name: serverLangName })}</option>
            {languages.map(([code, name]) => <option key={code} value={code}>{t('Language')}: {name}</option>)}
          </select>
        </label>
        <div className="mt-2 flex items-center gap-3 rounded-xl px-3 py-2">
          <div className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-indigo-500/30 to-cyan-500/30 text-xs font-semibold uppercase">{(user.name || user.username).slice(0, 2)}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user.name || user.username}</div>
            <div className="text-[11px] text-muted">{user.role === 'admin' ? t('Admin') : t('Viewer')}{user.provider === 'entra' && ' · Entra'}</div>
          </div>
          <button title={t('Sign out')} onClick={logout} className="rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-500 cursor-pointer"><LogOut className="size-4" /></button>
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
          <span className="truncate font-semibold">{instance}</span>
        </div>
        <div className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-8">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="/sites" element={<Sites />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/dashboards/:kind" element={<Dashboards />} />
            {isAdmin && <>
              <Route path="/alerts" element={<Alerts />} />
              <Route path="/controllers" element={<Controllers />} />
              <Route path="/geoip" element={<GeoIP />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/sso" element={<SSO />} />
              <Route path="/mail" element={<MailPage />} />
              <Route path="/backup" element={<Backup />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/branding" element={<BrandingPage />} />
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
