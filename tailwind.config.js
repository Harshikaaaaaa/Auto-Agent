/**
 * Tailwind configuration.
 *
 * This was previously an inline `tailwind.config` object in index.html, loaded
 * alongside the `https://cdn.tailwindcss.com` script — a development-only CDN
 * that compiled utilities in the browser on every page load and is explicitly
 * not for production. Task 15 replaced it with a real PostCSS build so the CSS
 * is compiled ahead of time and served from our own origin.
 *
 * `content` must list every file that uses a utility class, or Tailwind's
 * purge drops classes it cannot see and the production build renders unstyled.
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bolt: {
          bg: '#050505',
          sidebar: '#0a0a0a',
          panel: '#111111',
          accent: '#2dd4bf', // Teal accent
          border: '#1a1a1a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
