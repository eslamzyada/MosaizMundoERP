import { useCallback, useEffect, useRef, useState } from 'react';
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN, usePreferences } from '../session/PreferencesProvider';
import type { Theme } from '../session/PreferencesProvider';
import { brandingRepository } from '../api/BrandingRepository';
import type { Branding } from '../api/BrandingRepository';
import { useSession } from '../session/SessionProvider';
import { classifyLoadFailure } from '../lib/loadFailure';
import CriteriaManager from '../components/CriteriaManager';

/**
 * Appearance settings.
 *
 * Everything here is about the person reading it, so there is no role gate and
 * no save button: a choice about your own screen has nothing to validate and
 * nobody to approve it. Changes apply as they are made and persist by
 * themselves — a "save" step would only add a way to lose the change.
 */

const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'light', label: 'فاتح', hint: 'خلفية فاتحة دائمًا.' },
  { value: 'dark', label: 'داكن', hint: 'خلفية داكنة دائمًا — أرح للعين في الإضاءة المنخفضة.' },
  {
    value: 'system',
    label: 'حسب النظام',
    hint: 'يتبع إعداد جهازك، ويتغيّر معه فورًا عند تبديله.',
  },
];

/** Named stops, so the slider lands on sizes that were actually looked at. */
const SCALES = [
  { value: 90, label: 'أصغر' },
  { value: 100, label: 'افتراضي' },
  { value: 115, label: 'أكبر' },
  { value: 130, label: 'كبير' },
  { value: 150, label: 'كبير جدًا' },
];

export default function Settings() {
  const { theme, text_scale, resolvedTheme, loaded, error, setTheme, setTextScale } =
    usePreferences();
  const { can } = useSession();

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-app-ink">الإعدادات</h1>
        <p className="mt-1 text-sm text-app-ink-muted">
          هذه التفضيلات تخصّك وحدك — لا يراها أو يغيّرها أحد غيرك، ولا تؤثّر على بقية
          المستخدمين.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-app-border bg-app-surface p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-app-ink">المظهر</h2>
          <p className="mt-1 text-sm text-app-ink-muted">
            {theme === 'system'
              ? `يتبع جهازك حاليًا: ${resolvedTheme === 'dark' ? 'داكن' : 'فاتح'}.`
              : 'اختيار ثابت لا يتغيّر مع إعداد الجهاز.'}
          </p>

          <div className="mt-4 space-y-2">
            {THEMES.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  theme === option.value
                    ? 'border-twilight-500 bg-twilight-50/60'
                    : 'border-app-border hover:bg-app-surface-alt'
                }`}
              >
                <input
                  type="radio"
                  name="theme"
                  className="mt-1"
                  checked={theme === option.value}
                  disabled={!loaded}
                  onChange={() => void setTheme(option.value)}
                />
                <span>
                  <span className="block text-sm font-semibold text-app-ink">{option.label}</span>
                  <span className="block text-xs text-app-ink-muted">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-app-border bg-app-surface p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-app-ink">حجم الخط</h2>
          <p className="mt-1 text-sm text-app-ink-muted">
            يُكبّر الواجهة كلها — المسافات والأزرار معها، لا الحروف وحدها.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {SCALES.map((stop) => (
              <button
                key={stop.value}
                type="button"
                disabled={!loaded}
                onClick={() => void setTextScale(stop.value)}
                aria-pressed={text_scale === stop.value}
                className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
                  text_scale === stop.value
                    ? 'border-twilight-600 bg-twilight-600 text-white'
                    : 'border-app-border text-app-ink hover:bg-app-surface-alt'
                }`}
              >
                {stop.label}
              </button>
            ))}
          </div>

          <p className="mt-3 text-xs text-app-ink-muted">
            الحجم الحالي:{' '}
            <span className="font-numerals font-semibold">{text_scale}%</span>
            {' '}(من {TEXT_SCALE_MIN}% إلى {TEXT_SCALE_MAX}%)
          </p>

          {/* Shown at the chosen size, so the effect is visible before leaving
              the page rather than discovered on the next screen. */}
          <div className="mt-4 rounded-lg border border-dashed border-app-border p-4">
            <p className="text-sm text-app-ink">مثال على النص بالحجم المختار.</p>
            <p className="mt-1 text-xs text-app-ink-muted">
              نصّ ثانوي — الملاحظات والتفاصيل تظهر بهذا الحجم.
            </p>
          </div>
        </section>

        {/* Branding is the one thing on this page that is NOT personal, so it
            is gated and labelled as such — everything above changes only what
            the reader sees, this changes what customers see. */}
        <BrandingSection canManage={can('administer')} />

        {/* Also organisation-wide rather than personal, and gated the same way.
            Everyone may READ the rubric — that is the point of it. */}
        <CriteriaManager canManage={can('administer')} />
      </div>
    </div>
  );
}

/**
 * The restaurant's logo and trading name.
 *
 * Read by everyone (a till prints it) but changed only by an administrator, so
 * the section is always visible and the controls are not.
 */
function BrandingSection({ canManage }: { canManage: boolean }) {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    brandingRepository
      .get()
      .then(setBranding)
      .catch((e) => setMessage(classifyLoadFailure(e).message));
  }, []);

  useEffect(load, [load]);

  async function run(action: () => Promise<Branding>) {
    setBusy(true);
    setMessage(null);
    try {
      setBranding(await action());
    } catch (err) {
      // The server's wording is more specific than anything invented here — it
      // knows whether the credential is missing, the file is too large, or the
      // type is unsupported.
      const fromServer = (err as { response?: { data?: { error?: string } } })?.response?.data
        ?.error;
      setMessage(fromServer ?? classifyLoadFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-app-border bg-app-surface p-6 shadow-sm lg:col-span-2">
      <h2 className="text-lg font-semibold text-app-ink">شعار المطعم</h2>
      <p className="mt-1 text-sm text-app-ink-muted">
        يظهر داخل النظام ويُطبع على فواتير العملاء. هذا إعداد للمطعم كله، لا يخصّك وحدك.
      </p>

      {message && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {message}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-6">
        <div className="grid h-24 w-24 place-items-center overflow-hidden rounded-xl border border-dashed border-app-border bg-app-surface-alt/40">
          {branding?.logo_url ? (
            <img
              src={branding.logo_url}
              alt="شعار المطعم"
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="text-center text-xs text-app-ink-muted">لا يوجد شعار</span>
          )}
        </div>

        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {/* The input is hidden and driven by the button: a bare file input
                cannot be styled, and its default label is in the browser's
                language rather than the app's. */}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void run(() => brandingRepository.uploadLogo(file));
                e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="rounded-lg bg-twilight-600 px-4 py-2 text-sm font-semibold text-white hover:bg-twilight-700 disabled:opacity-50"
            >
              {busy ? 'جارٍ الرفع…' : branding?.logo_url ? 'استبدال الشعار' : 'رفع شعار'}
            </button>
            {branding?.logo_url && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => brandingRepository.clearLogo())}
                className="rounded-lg border border-app-border px-4 py-2 text-sm font-semibold text-app-ink hover:bg-app-surface-alt disabled:opacity-50"
              >
                إزالة
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm text-app-ink-muted">
            تغيير الشعار من صلاحيات المديرين.
          </p>
        )}
      </div>

      <p className="mt-3 text-xs text-app-ink-muted">
        PNG أو JPG أو WebP أو SVG، بحد أقصى ٢ ميجابايت.
      </p>
    </section>
  );
}
