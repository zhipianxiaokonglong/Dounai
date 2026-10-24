/**
 * 本地设置。
 *
 * 隐私约束：设置里**不**保存任何 API 密钥——密钥只存在于上游模块自己的环境变量里。
 * 这里只存端点地址、形象选择与外观偏好。
 */

export interface DounaiSettings {
  endpoints: {
    input: string;
    llm: string;
    output: string;
  };
  /** 形象渲染器 id；见 src/avatar/types.ts */
  avatarRenderer: string;
  /** 默认模型 id；留空表示由上游决定 */
  model: string;
  theme: {
    accent: string;
    surface: string;
  };
  /** 勿扰模式：不播放语音、不主动弹窗 */
  doNotDisturb: boolean;
  /** 全局唤起快捷键（展示用；实际注册在主进程） */
  hotkey: string;
}

const STORAGE_KEY = "dounai.settings.v1";

export const DEFAULT_SETTINGS: DounaiSettings = {
  endpoints: {
    input: "http://127.0.0.1:8101",
    llm: "http://127.0.0.1:8102",
    output: "http://127.0.0.1:8103",
  },
  avatarRenderer: "logo",
  model: "",
  theme: {
    accent: "#5b8def",
    surface: "#ffffff",
  },
  doNotDisturb: false,
  hotkey: "Ctrl+Alt+D",
};

export function loadSettings(): DounaiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<DounaiSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      endpoints: { ...DEFAULT_SETTINGS.endpoints, ...(parsed.endpoints ?? {}) },
      theme: { ...DEFAULT_SETTINGS.theme, ...(parsed.theme ?? {}) },
    };
  } catch {
    // 存储损坏时回到默认值，不让 UI 因设置读取失败而白屏
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next: DounaiSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}
