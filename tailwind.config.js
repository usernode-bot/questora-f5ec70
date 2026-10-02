// Tailwind config for this app's precompiled stylesheet.
//
// npm run build (Docker or Paketo) runs the Tailwind CLI over the globs below
// and writes public/tailwind.css, which public/index.html links as
// /tailwind.css. Nothing is committed — every image build regenerates it.
//
// To build it locally (optional; the image build does this for you):
//   npm ci --include=dev
//   npm run build
//
// Colours resolve through the semantic tokens in styles/tailwind-input.css
// (`:root` dark, `html.light` overrides). Each family is
// `rgb(var(--q-…) / <alpha-value>)` so the `/opacity` modifier still works,
// with a literal fallback so a class paints even if the variable is missing.
// The families are named content/line/icon rather than text/border so call
// sites read `text-content-secondary`, never `text-text-secondary`.
function token(name, fallback) {
  return 'rgb(var(--q-' + name + ', ' + fallback + ') / <alpha-value>)';
}

module.exports = {
  // Every file that can contain a class name. Tailwind's extractor is a
  // regex over source text, so it finds class names written as whole
  // literals — including ones inside JS strings in these files.
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],

  // Classes this app builds dynamically (if it ever does) go here, since the
  // extractor cannot see them. Prefer whole literals in the markup instead.
  safelist: [],

  // Matches the <html class="dark"> in public/index.html: dark: variants key
  // off that class rather than the OS colour-scheme preference.
  darkMode: 'class',

  // Stops hover: styles sticking after a tap on touch screens. Required by
  // the usernode-native UI kit and harmless without it.
  future: { hoverOnlyWhenSupported: true },

  theme: {
    extend: {
      colors: {
        background: token('background', '11 11 15'),
        surface: {
          DEFAULT: token('surface', '18 19 24'),
          container: token('surface-container', '24 25 32'),
          'container-high': token('surface-container-high', '32 33 39'),
          'container-highest': token('surface-container-highest', '41 42 49'),
        },
        content: {
          primary: token('text-primary', '245 245 247'),
          secondary: token('text-secondary', '196 199 208'),
          tertiary: token('text-tertiary', '165 168 178'),
          disabled: token('text-disabled', '126 132 148'),
        },
        line: {
          DEFAULT: token('border', '86 91 104'),
          subtle: token('border-subtle', '58 60 69'),
          strong: token('border-strong', '110 116 132'),
        },
        icon: {
          primary: token('icon-primary', '233 234 240'),
          secondary: token('icon-secondary', '185 188 198'),
        },
        accent: {
          DEFAULT: token('accent', '124 58 237'),
          hover: token('accent-hover', '139 92 246'),
          active: token('accent-active', '109 40 217'),
          text: token('accent-text', '196 181 253'),
          contrast: token('accent-contrast', '255 255 255'),
        },
        success: { DEFAULT: token('success', '110 231 183'), bg: token('success-bg', '18 38 31') },
        warning: { DEFAULT: token('warning', '252 211 77'), bg: token('warning-bg', '46 36 17') },
        error: { DEFAULT: token('error', '252 165 165'), bg: token('error-bg', '44 23 25') },
        info: { DEFAULT: token('info', '125 211 252'), bg: token('info-bg', '15 36 49') },
      },
    },
  },
  plugins: [],
};
