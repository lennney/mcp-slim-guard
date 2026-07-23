# ── Build stage ──
FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ──
FROM node:20-alpine

RUN addgroup -S mcp-slim-guard && adduser -S mcp-slim-guard -G mcp-slim-guard
USER mcp-slim-guard

WORKDIR /app
COPY --from=build --chown=mcp-slim-guard:mcp-slim-guard /app/dist ./dist
COPY --from=build --chown=mcp-slim-guard:mcp-slim-guard /app/node_modules ./node_modules
COPY --from=build --chown=mcp-slim-guard:mcp-slim-guard /app/package.json ./

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start"]