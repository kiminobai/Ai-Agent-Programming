FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --legacy-peer-deps
COPY src ./src
RUN npm run build:server

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force
COPY --from=build /app/dist ./dist
# Orchestrator 需要访问受保护的 Docker Socket；实际任务仍在非 root、无能力的临时容器中执行。
USER root
CMD ["node", "dist/sandbox-orchestrator/server.js"]
