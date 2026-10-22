import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /api goes to the AI backend (`npm run server`), in dev and in preview, so
// the browser calls a relative URL and never needs the API key.
const aiServer = `http://localhost:${process.env.AI_SERVER_PORT || 8787}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': aiServer } },
  preview: { proxy: { '/api': aiServer } },
})
