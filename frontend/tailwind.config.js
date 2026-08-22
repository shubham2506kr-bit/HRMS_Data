/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        soft: 'rgb(var(--soft) / <alpha-value>)',
        mutedfill: 'rgb(var(--mutedfill) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        inksoft: 'rgb(var(--inksoft) / <alpha-value>)',
        inkfaint: 'rgb(var(--inkfaint) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        linestrong: 'rgb(var(--linestrong) / <alpha-value>)',
        brand: 'rgb(var(--brand) / <alpha-value>)',
        brandsoft: 'rgb(var(--brandsoft) / <alpha-value>)',
        branddeep: 'rgb(var(--branddeep) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        accentsoft: 'rgb(var(--accentsoft) / <alpha-value>)',
        ok: 'rgb(var(--ok) / <alpha-value>)',
        oksoft: 'rgb(var(--oksoft) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        warnsoft: 'rgb(var(--warnsoft) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        dangersoft: 'rgb(var(--dangersoft) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
        infosoft: 'rgb(var(--infosoft) / <alpha-value>)',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.75rem', { lineHeight: '1.0625rem' }],
      },
      boxShadow: {
        float: '0 1px 2px rgba(23, 20, 17, 0.06), 0 8px 24px -8px rgba(23, 20, 17, 0.12)',
        modal: '0 4px 12px rgba(23, 20, 17, 0.08), 0 24px 64px -16px rgba(23, 20, 17, 0.24)',
      },
      animation: {
        'fade-in': 'fadeIn 0.25s ease-out',
        'slide-up': 'slideUp 0.35s ease-out',
        'slide-down': 'slideDown 0.2s ease-out',
        'scale-in': 'scaleIn 0.18s ease-out',
        'pulse-soft': 'pulseSoft 2s infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.98)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
    },
  },
  plugins: [],
}
