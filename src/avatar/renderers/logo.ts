/**
 * 默认形象：产品 logo。
 *
 * 实现约束（对应 docs/architecture.md §7.1 的性能预算）：
 *  - 只用 CSS transform / opacity 做动画，不用 JS 定时器逐帧改样式；
 *  - 独立合成层（will-change: transform），避免每帧重绘整窗；
 *  - 尊重 prefers-reduced-motion，减弱动效时不跑呼吸/波纹。
 */

import type { AvatarContext, AvatarRenderer, AvatarState, AvatarTheme } from "../types.js";

const LOGO_SVG = `
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="dounai-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="var(--avatar-accent)"/>
      <stop offset="100%" stop-color="var(--avatar-accent-2)"/>
    </linearGradient>
  </defs>
  <circle cx="64" cy="64" r="56" fill="url(#dounai-grad)"/>
  <circle cx="64" cy="64" r="56" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2"/>
  <path d="M44 52c0-4 3-7 7-7h34c4 0 7 3 7 7v20c0 4-3 7-7 7H60l-12 10v-10h-3c-4 0-7-3-7-7z"
        fill="rgba(255,255,255,.92)"/>
  <circle cx="56" cy="62" r="3.4" fill="var(--avatar-accent)"/>
  <circle cx="72" cy="62" r="3.4" fill="var(--avatar-accent)"/>
  <path d="M56 70c3 3 13 3 16 0" fill="none" stroke="var(--avatar-accent)" stroke-width="3"
        stroke-linecap="round"/>
</svg>`;

export class LogoAvatarRenderer implements AvatarRenderer {
  readonly id = "logo";
  readonly displayName = "Dounai Logo（默认）";

  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private ctx: AvatarContext | null = null;
  private state: AvatarState = "default";
  private theme: AvatarTheme = { accent: "#5b8def", surface: "#ffffff", dark: false };
  private speakingTimer: ReturnType<typeof setTimeout> | null = null;

  mount(host: HTMLElement, ctx: AvatarContext): void {
    this.host = host;
    this.ctx = ctx;

    const root = document.createElement("div");
    root.className = "avatar avatar--logo";
    root.dataset.state = "default";
    root.innerHTML = LOGO_SVG;

    const glow = document.createElement("div");
    glow.className = "avatar__glow";
    root.appendChild(glow);

    host.replaceChildren(root);
    this.root = root;
    this.applyTheme();
    this.setState(this.state);
  }

  setState(state: AvatarState): void {
    this.state = state;
    if (!this.root) return;
    this.root.dataset.state = state;
    // 用 CSS 状态类驱动动画，JS 不参与逐帧
    if (state === "wakeup") {
      this.root.classList.remove("avatar--pulse");
      // 强制回流以重启动画；这是一次性操作，不在循环里
      void this.root.offsetWidth;
      this.root.classList.add("avatar--pulse");
    }
  }

  setEmotion(_emotion: string | null): void {
    // 预留：正式形象接入后在此驱动表情。logo 形态下无表情资源。
  }

  setSpeakingLevel(level: number): void {
    if (!this.root) return;
    const clamped = Math.max(0, Math.min(1, level));
    this.root.style.setProperty("--speaking-level", clamped.toFixed(3));
    if (this.speakingTimer) clearTimeout(this.speakingTimer);
    // 电平衰减：避免最后一帧停在高峰
    this.speakingTimer = setTimeout(() => {
      this.root?.style.setProperty("--speaking-level", "0");
    }, 120);
  }

  setTheme(theme: AvatarTheme): void {
    this.theme = theme;
    this.applyTheme();
  }

  unmount(): void {
    if (this.speakingTimer) clearTimeout(this.speakingTimer);
    this.speakingTimer = null;
    this.host?.replaceChildren();
    this.root = null;
    this.host = null;
    this.ctx = null;
  }

  private applyTheme(): void {
    if (!this.root) return;
    const { accent, dark } = this.theme;
    this.root.style.setProperty("--avatar-accent", accent);
    this.root.style.setProperty("--avatar-accent-2", dark ? "#8fb4ff" : "#7aa2f7");
    this.root.dataset.theme = dark ? "dark" : "light";
  }
}
