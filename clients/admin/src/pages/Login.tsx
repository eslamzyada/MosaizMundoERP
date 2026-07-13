import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { supabase } from '../lib/supabase';

export default function Login() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sand p-4">
      <div className="w-full max-w-sm rounded-2xl border border-surface-sand-border bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-sunset-500 to-twilight-600 text-lg font-bold text-white">
            M
          </div>
          <h1 className="font-numerals text-lg font-bold text-surface-dark">Mosaiz Mundo</h1>
          <p className="mt-1 text-sm text-slate-500">تسجيل الدخول إلى لوحة الإدارة</p>
        </div>

        <Auth
          supabaseClient={supabase}
          providers={[]}
          showLinks={false}
          appearance={{
            theme: ThemeSupa,
            variables: {
              default: {
                colors: {
                  // Twilight — the Back-Office accent.
                  brand: '#793fda',
                  brandAccent: '#6930bd',
                },
              },
            },
          }}
          localization={{
            variables: {
              sign_in: {
                email_label: 'البريد الإلكتروني',
                password_label: 'كلمة المرور',
                email_input_placeholder: 'your@email.com',
                password_input_placeholder: '••••••••',
                button_label: 'تسجيل الدخول',
                loading_button_label: 'جارٍ تسجيل الدخول…',
              },
            },
          }}
        />
      </div>
    </div>
  );
}
