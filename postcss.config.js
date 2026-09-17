/**
 * PostCSS pipeline for the production CSS build.
 *
 * Vite picks this up automatically and runs it over the CSS entry
 * (`src/app/index.css`), so Tailwind's `@tailwind` directives are compiled and
 * vendor-prefixed at build time instead of by the browser CDN script that used
 * to live in index.html.
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
