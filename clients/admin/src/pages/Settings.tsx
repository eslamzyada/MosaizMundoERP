import { TEXT_SCALE_MAX, TEXT_SCALE_MIN, usePreferences } from '../session/PreferencesProvider';
import type { Theme } from '../session/PreferencesProvider';

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
      </div>
    </div>
  );
}
