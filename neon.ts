import { defineConfig } from "@neon/config/v1";
export default defineConfig({
  auth: true,
  preview: {
    realtime: {
      allowedOrigins: [
        "http://localhost:5180",
        "http://127.0.0.1:5180",
        ...(process.env.APP_ORIGIN ? [process.env.APP_ORIGIN] : []),
      ],
    },
  },
  functions: {
    margin: {
      name: "Carriage collaborative Markdown API and MCP",
      source: "src/server/index.ts",
      env: {
        APP_ORIGIN: process.env.APP_ORIGIN!,
        API_BASE_URL: process.env.API_BASE_URL!,
        OAUTH_SECRET: process.env.OAUTH_SECRET!,
        REALTIME_SECRET: process.env.NEON_REALTIME_SECRET!,
        REALTIME_URL: process.env.NEON_REALTIME_URL!,
      },
    },
  },
});
