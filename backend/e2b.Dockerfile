FROM e2bdev/code-interpreter:latest 
WORKDIR /home/user

# Install Vite (React template) and TailwindCSS v4
RUN npm create vite@latest . -- --template react-ts && \
    npm install && \
    npm install tailwindcss @tailwindcss/vite

# Create Vite config with Tailwind plugin and host binding
RUN echo "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nimport tailwindcss from '@tailwindcss/vite'\n\nexport default defineConfig({\n  plugins: [\n    tailwindcss(),\n    react(),\n  ],\n  server: {\n    host: '0.0.0.0',\n    port: 3000,\n    strictPort: true,\n    allowedHosts: true\n  }\n})" > vite.config.ts

# Update index.css to import Tailwind
RUN echo "@import \"tailwindcss\";" > src/index.css
