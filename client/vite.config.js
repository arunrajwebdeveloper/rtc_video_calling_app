import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
// import mkcert from "vite-plugin-mkcert";

// https://vite.dev/config/
// export default defineConfig({
//   plugins: [react(), mkcert()],
//   server: {
//     host: true,
//     https: true,
//   },
// });

export default defineConfig({
  base: "/rtc_video_calling_app/", // Replace with your exact GitHub repository name
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
  },
});
