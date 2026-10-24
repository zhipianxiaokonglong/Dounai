/**
 * 可替换形象渲染层。
 *
 * 需求：默认外观是产品 logo；后续产品会推出正式助手形象，届时替换渲染层。
 * 因此这里只定义接口与注册表，具体形象实现互不依赖。
 *
 * 新增形象的步骤（也写进了用户文档）：
 *   1. 新建 avatar/renderers/xxx.ts，实现 AvatarRenderer；
 *   2. 在 registry.ts 里 register("xxx", factory)；
 *   3. 设置项 avatarRenderer = "xxx"。
 * 其余代码零改动。
 */

export type AvatarState = "default" | "wakeup" | "talking" | "emotion" | "degraded";

export interface AvatarTheme {
  /** 主色（形象与文字强调共用） */
  accent: string;
  /** 背景/描边色 */
  surface: string;
  /** 是否深色模式 */
  dark: boolean;
}

export interface AvatarContext {
  getState(): AvatarState;
  /** 请求一次一次性动效，不改变状态 */
  pulse(kind: "wakeup" | "ack"): void;
  /** 尊重系统「减弱动效」偏好 */
  readonly reducedMotion: boolean;
}

export interface AvatarRenderer {
  /** 唯一标识，用于设置项与注册表 */
  readonly id: string;
  /** 人类可读名称 */
  readonly displayName: string;
  mount(host: HTMLElement, ctx: AvatarContext): Promise<void> | void;
  setState(state: AvatarState): void;
  /** 情感标签（本期预留；默认实现为空） */
  setEmotion(emotion: string | null): void;
  /** 说话强度 0..1，驱动口型/波纹 */
  setSpeakingLevel(level: number): void;
  setTheme(theme: AvatarTheme): void;
  unmount(): void;
}

export type AvatarFactory = () => AvatarRenderer;

const registry = new Map<string, AvatarFactory>();

export function registerAvatar(id: string, factory: AvatarFactory): void {
  registry.set(id, factory);
}

export function createAvatar(id: string): AvatarRenderer | null {
  const factory = registry.get(id);
  return factory ? factory() : null;
}

export function listAvatars(): Array<{ id: string; displayName: string }> {
  return [...registry.values()].map((factory) => {
    const instance = factory();
    return { id: instance.id, displayName: instance.displayName };
  });
}

export const DEFAULT_AVATAR_ID = "logo";
