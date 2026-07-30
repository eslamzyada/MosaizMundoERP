/** @type {import('tailwindcss').Config} */
export default {
  // Theme is a class on <html>, set by PreferencesProvider from the stored
  // preference (or the operating system when that preference is 'system').
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Cairo is the default UI face (Arabic-first). Inter is reserved for
        // numerals, prices and phone numbers via the .font-numerals utility.
        sans: ['Cairo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        numerals: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Role-named surfaces backed by CSS variables (see index.css). Use
        // these for anything themed; the literal palettes below stay for brand
        // accents and the deliberately-dark sidebar chrome.
        app: {
          bg: 'rgb(var(--app-bg) / <alpha-value>)',
          surface: 'rgb(var(--app-surface) / <alpha-value>)',
          'surface-alt': 'rgb(var(--app-surface-alt) / <alpha-value>)',
          border: 'rgb(var(--app-border) / <alpha-value>)',
          ink: 'rgb(var(--app-ink) / <alpha-value>)',
          'ink-muted': 'rgb(var(--app-ink-muted) / <alpha-value>)',
        },
        // Primary brand — sunset red/orange.
        sunset: {
          50: '#fff5f1',
          100: '#ffe8e0',
          200: '#ffcbb8',
          300: '#ffa588',
          400: '#ff714a',
          500: '#f5431f',
          600: '#e02b12',
          700: '#ba1f12',
          800: '#961c16',
          900: '#7b1a16',
        },
        // Admin / Back-Office accent — twilight purple.
        twilight: {
          50: '#f6f4fe',
          100: '#eee9fd',
          200: '#ded5fb',
          300: '#c4b3f7',
          400: '#a687f0',
          500: '#8b5fe8',
          600: '#793fda',
          700: '#6930bd',
          800: '#582a9a',
          900: '#49257c',
        },
        // Golden-hour accent — amber (warnings / highlights).
        amber: {
          50: '#fff8eb',
          100: '#feefc7',
          200: '#fedf88',
          300: '#fdc94a',
          400: '#fcb320',
          500: '#f69507',
          600: '#da6f02',
          700: '#b54e06',
          800: '#933c0c',
          900: '#79330d',
        },
        // Surfaces. `sand` = warm light Back-Office background; `dark` = deep
        // twilight/charcoal for the POS and dark chrome (sidebars).
        surface: {
          sand: '#f7f2e9',
          'sand-alt': '#efe7d6',
          'sand-border': '#e6dcc8',
          dark: '#191627',
          'dark-alt': '#221d36',
          'dark-elevated': '#2b2545',
          'dark-border': '#332c4d',
        },
        // Semantic states (each: soft badge bg / DEFAULT / strong text).
        success: {
          soft: '#dcfce7',
          DEFAULT: '#16a34a',
          strong: '#15803d',
        },
        warning: {
          soft: '#fef3c7',
          DEFAULT: '#d97706',
          strong: '#b45309',
        },
        destructive: {
          soft: '#fee2e2',
          DEFAULT: '#dc2626',
          strong: '#b91c1c',
        },
      },
    },
  },
  plugins: [],
};
