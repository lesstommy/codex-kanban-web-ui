import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const webHost = env.VITE_HOST || "127.0.0.1";
  const webPort = Number(env.VITE_PORT) || 5173;
  const apiTarget = `http://127.0.0.1:${Number(env.SERVER_PORT) || 4317}`;
  const proxy = {
    "/api": {
      target: apiTarget,
      changeOrigin: true
    }
  };

  return {
    plugins: [react()],
    server: {
      host: webHost,
      port: webPort,
      strictPort: true,
      proxy
    },
    preview: {
      host: webHost,
      port: webPort,
      strictPort: true,
      proxy
    }
  };
});
