import react from '@vitejs/plugin-react';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// The spider-web server (src/server.ts) serves /api and /data and mounts this in middleware mode while developing.
// `pnpm build` writes dist/viewer, which the server serves as static files.
export default defineConfig({
    root,
    plugins: [react()],
    resolve: { alias: { '@contracts': join(root, '../src/contracts.ts') } },
    build: { outDir: join(root, '../dist/viewer'), emptyOutDir: true },
});
