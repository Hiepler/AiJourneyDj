FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json vitest.workspace.ts ./
RUN npm install

FROM base AS api
RUN npm run build -w @ai-journey-dj/api
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@ai-journey-dj/api"]

FROM base AS web
RUN npm run build -w @ai-journey-dj/web
EXPOSE 5173
CMD ["npm", "run", "preview", "-w", "@ai-journey-dj/web", "--", "--host", "0.0.0.0"]
