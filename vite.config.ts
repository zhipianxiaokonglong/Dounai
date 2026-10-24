import { defineConfig, type ProxyOptions } from "vite";

/**
 * 移除 Origin / Referer，模拟本地进程调用。
 *
 * 为什么必须这么做：output 层对未在白名单中的 Origin 一律返回 403
 * `origin_not_allowed`（见 docs/cors-and-proxy.md）。浏览器发起的请求必然带 Origin，
 * 而代理是服务端转发，正确语义是「本地进程调用」——不带 Origin。
 *
 * 这一步缺失时的表现极具误导性：服务健康检查（无 Origin）正常，
 * 但真正合成语音时 403，UI 显示「上游拒绝了跨域请求」。
 */
function stripOrigin(proxy: ProxyOptions): void {
  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.removeHeader("origin");
    proxyReq.removeHeader("referer");
  });
}

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: { main: "index.html" },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // 开发模式下用代理绕开浏览器跨域限制；生产环境由 Tauri 主进程代理承担同样职责。
    proxy: {
      "/api/input": {
        target: "http://127.0.0.1:8101",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api\/input/, ""),
        configure: stripOrigin,
      },
      "/api/llm": {
        target: "http://127.0.0.1:8102",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api\/llm/, ""),
        configure: stripOrigin,
      },
      "/api/output": {
        target: "http://127.0.0.1:8103",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api\/output/, ""),
        configure: stripOrigin,
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: "default",
  },
});
