# syntax=docker/dockerfile:1
FROM node:24.21.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
RUN npm ci
COPY packages packages
RUN npm run build

FROM node:24.21.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --workspace @weathervane/server && npm cache clean --force
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/server/dist packages/server/dist
USER node
EXPOSE 8080
# The image has no curl; Node itself does the check.
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "packages/server/dist/main.js"]
