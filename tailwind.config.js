/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        obsidian: '#09090B',
        panel: '#101013',
        ink: '#27272A',
        line: '#3F3F46',
        paper: '#FAFAFA',
        mute: '#A1A1AA',
        dim: '#71717A',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Consolas', '"Courier New"', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', '13px'],
      },
      boxShadow: {
        hud: '8px 8px 0 0 rgba(0,0,0,0.55)',
      },
    },
  },
  plugins: [],
};
