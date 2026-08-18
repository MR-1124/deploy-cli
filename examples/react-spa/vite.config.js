import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standard Vite React setup. `vite build` outputs to dist/, which the
// deploy CLI detects automatically and uploads as the site.
export default defineConfig({
  plugins: [react()],
});
