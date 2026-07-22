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

RUN addgroup -S micro-mcp && adduser -S micro-mcp -G micro-mcp
USER micro-mcp

WORKDIR /app
COPY --from=build --chown=micro-mcp:micro-mcp /app/dist ./dist
COPY --from=build --chown=micro-mcp:micro-mcp /app/node_modules ./node_modules
COPY --from=build --chown=micro-mcp:micro-mcp /app/package.json ./

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start"]