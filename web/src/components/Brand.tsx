import { Radio } from 'lucide-react'
import { brandingUrl, type Branding } from '../api'
import { cx } from './ui'
import { t } from '../i18n'

/** Company logo for the current theme, or the app mark when none is uploaded. */
export function BrandMark({ branding, large, theme }: { branding: Branding; large?: boolean; theme?: 'light' | 'dark' }) {
  const { logo_light: light, logo_dark: dark } = branding.assets
  if (light || dark) {
    const h = large ? 'max-h-16 max-w-[220px]' : 'max-h-9 max-w-[140px]'
    if (theme) {
      const a = theme === 'dark' ? (dark ? 'logo_dark' : 'logo_light') : light ? 'logo_light' : 'logo_dark'
      return <img src={brandingUrl(branding, a)} alt={branding.company_name} className={cx(h, 'w-auto object-contain')} />
    }
    return <>
      <img src={brandingUrl(branding, light ? 'logo_light' : 'logo_dark')} alt={branding.company_name} className={cx(h, 'w-auto object-contain', dark && 'dark:hidden')} />
      {dark && <img src={brandingUrl(branding, 'logo_dark')} alt={branding.company_name} className={cx(h, 'hidden w-auto object-contain dark:block')} />}
    </>
  }
  return large
    ? <div className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-500 text-white shadow-xl shadow-indigo-500/30"><Radio className="size-7" /></div>
    : <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-500 text-white shadow-lg shadow-indigo-500/30"><Radio className="size-5" /></div>
}

/**
 * Logo with server and company name, as at the top of the menu. A company
 * logo gets its own row since it is usually wider than the app mark.
 */
export function BrandHeader({ branding, instance, theme, className }: { branding: Branding; instance: string; theme?: 'light' | 'dark'; className?: string }) {
  const logo = branding.assets.logo_light || branding.assets.logo_dark
  const muted = theme === 'light' ? 'text-slate-500' : theme === 'dark' ? 'text-slate-400' : 'text-muted'
  const text = (
    <div className="min-w-0">
      <div className="truncate text-sm font-semibold">{instance}</div>
      <div className={cx('truncate text-[11px]', muted)}>{branding.company_name || t('Central UniFi logging')}</div>
    </div>
  )
  return logo
    ? <div className={cx('space-y-2.5', className)}><BrandMark branding={branding} theme={theme} />{text}</div>
    : <div className={cx('flex items-center gap-3', className)}><BrandMark branding={branding} theme={theme} />{text}</div>
}
