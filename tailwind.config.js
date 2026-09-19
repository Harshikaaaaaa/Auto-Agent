/**
 * Tailwind configuration — the design system's single source of truth.
 *
 * This was previously an inline `tailwind.config` object in index.html, loaded
 * alongside the `https://cdn.tailwindcss.com` script — a development-only CDN
 * that compiled utilities in the browser on every page load and is explicitly
 * not for production. Task 15 replaced it with a real PostCSS build so the CSS
 * is compiled ahead of time and served from our own origin.
 *
 * `content` must list every file that uses a utility class, or Tailwind's
 * purge drops classes it cannot see and the production build renders unstyled.
 *
 * DESIGN LANGUAGE
 * ---------------
 * Reference points: Gumloop and Relay.app (AI workflow builders), Linear
 * (dark-UI craft), Vercel (restraint). The shared traits encoded here:
 *
 *  - ELEVATION, NOT OUTLINES. Panels separate by stacked near-black surfaces
 *    (`surface.0` … `surface.3`) plus a hairline alpha border, instead of heavy
 *    grey boxes. `bolt.*` names are kept as aliases so existing markup builds.
 *  - ONE CONFIDENT ACCENT. Teal stays the brand colour, but with real tints and
 *    shades so hover/active/disabled states are derived rather than improvised.
 *  - ALPHA BORDERS. Borders are white at low opacity, which reads correctly on
 *    every surface without per-panel tuning.
 *  - A SHADOW SCALE, including an accent glow used only on the primary action.
 *  - DELIBERATE MOTION. Short, shared durations and one easing curve, so
 *    interactions feel consistent rather than each component inventing its own.
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /** Layered near-black surfaces: 0 is the page, 3 is the most raised. */
        surface: {
          0: '#050505',
          1: '#0a0a0a',
          2: '#0f0f10',
          3: '#151517',
          4: '#1c1c1f',
        },
        /** The single accent, with derived states. */
        accent: {
          DEFAULT: '#2dd4bf',
          hover: '#5eead4',
          dim: '#14b8a6',
          muted: 'rgba(45, 212, 191, 0.12)',
          ring: 'rgba(45, 212, 191, 0.35)',
        },
        /**
         * Kept so existing `bolt-*` classes keep compiling. New work should
         * prefer `surface-*` / `accent`.
         */
        bolt: {
          bg: '#050505',
          sidebar: '#0a0a0a',
          panel: '#111111',
          accent: '#2dd4bf',
          border: '#1a1a1a',
        },
      },
      borderColor: {
        hairline: 'rgba(255, 255, 255, 0.06)',
        subtle: 'rgba(255, 255, 255, 0.10)',
        strong: 'rgba(255, 255, 255, 0.16)',
      },
      borderRadius: {
        xl: '0.75rem',
        '2xl': '1rem',
        '3xl': '1.25rem',
        '4xl': '1.75rem',
      },
      boxShadow: {
        /** Raised panel: deep, soft, no visible edge. */
        panel: '0 16px 48px -12px rgba(0, 0, 0, 0.75)',
        /** Floating bar / popover. */
        float: '0 8px 32px -8px rgba(0, 0, 0, 0.7)',
        /** The primary action only. */
        glow: '0 0 0 1px rgba(45, 212, 191, 0.25), 0 8px 28px -8px rgba(45, 212, 191, 0.45)',
        /** Focus state for inputs. */
        focus: '0 0 0 3px rgba(45, 212, 191, 0.18)',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      fontSize: {
        /** Tight UI scale: labels, meta, body. */
        '2xs': ['0.625rem', { lineHeight: '0.875rem', letterSpacing: '0.08em' }],
      },
      transitionDuration: {
        fast: '120ms',
        DEFAULT: '180ms',
        slow: '280ms',
      },
      transitionTimingFunction: {
        // One curve everywhere: quick out, gentle settle.
        smooth: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 180ms cubic-bezier(0.22, 1, 0.36, 1)',
        'rise-in': 'rise-in 240ms cubic-bezier(0.22, 1, 0.36, 1)',
        'scale-in': 'scale-in 160ms cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
