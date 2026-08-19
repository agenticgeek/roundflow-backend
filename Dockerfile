# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci

RUN npx prisma generate && \
    npx prisma generate --schema prisma/tenant/schema.prisma

COPY tsconfig*.json ./
COPY src ./src

RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev && \
    npx prisma generate && \
    npx prisma generate --schema prisma/tenant/schema.prisma

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/index.js"]
