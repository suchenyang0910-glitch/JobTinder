FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV COREPACK_HOME=/tmp/corepack
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY nest-cli.json tsconfig*.json eslint.config.mjs .prettierrc ./
COPY src ./src
COPY prisma ./prisma
COPY scripts ./scripts
RUN pnpm prisma generate && pnpm build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV COREPACK_HOME=/tmp/corepack
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
# Keep the operational CLI and its TypeScript sources in the production image.
# These commands are used for controlled crawler runs and review operations.
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig*.json ./

EXPOSE 3010
CMD ["node", "dist/src/main.js"]
