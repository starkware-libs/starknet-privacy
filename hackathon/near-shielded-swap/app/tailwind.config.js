/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#070707",
          elevated: "#0E0E0E",
          muted: "#141414",
        },
        foreground: {
          DEFAULT: "#F2F2F2",
          muted: "#9A9A9A",
          subtle: "#5F5F5F",
        },
        accent: {
          DEFAULT: "#B6F35F",
          hover: "#C5F77E",
          foreground: "#0A0A0A",
          glow: "rgba(182, 243, 95, 0.25)",
          dim: "rgba(182, 243, 95, 0.08)",
        },
        border: {
          DEFAULT: "rgba(255,255,255,0.06)",
          strong: "rgba(255,255,255,0.10)",
          accent: "rgba(182, 243, 95, 0.4)",
        },
        pool: {
          DEFAULT: "#B6F35F",
          ink: "rgba(182, 243, 95, 0.12)",
        },
        danger: "#FF6B6B",
        warn: "#F2B445",
      },
      fontFamily: {
        sans: [
          "Mona Sans",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      fontSize: {
        display: ["3rem", { lineHeight: "1.04", letterSpacing: "-0.025em" }],
      },
      borderRadius: {
        card: "20px",
        pill: "999px",
      },
      boxShadow: {
        card: "0 1px 0 rgba(255,255,255,0.03) inset, 0 20px 60px -20px rgba(0,0,0,0.6)",
        accent: "0 0 0 1px rgba(182,243,95,0.5), 0 8px 32px -8px rgba(182,243,95,0.35)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.55", transform: "scale(0.85)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
        shimmer: "shimmer 2.4s linear infinite",
      },
    },
  },
  plugins: [],
};
