# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/twitch/package.json packages/twitch/package.json
RUN --mount=type=cache,id=twitch-tracker-pnpm-11,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm -r build

FROM build AS api-deployment
RUN pnpm --filter @twitch-tracker/api deploy --prod /opt/api

FROM build AS worker-deployment
RUN pnpm --filter @twitch-tracker/worker deploy --prod /opt/worker

FROM dependencies AS db-build
COPY packages/db packages/db
RUN pnpm --filter @twitch-tracker/db build

FROM db-build AS migrate-deployment
RUN pnpm --filter @twitch-tracker/db deploy /opt/migrate

FROM base AS api
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/Koodattu/twitch-tracker" \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app
COPY --from=api-deployment --chown=node:node /opt/api ./
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]

FROM base AS worker
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/Koodattu/twitch-tracker" \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production
WORKDIR /app
COPY --from=worker-deployment --chown=node:node /opt/worker ./
USER node
CMD ["node", "dist/index.js"]

FROM base AS migrate
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/Koodattu/twitch-tracker" \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production
WORKDIR /app
COPY --from=migrate-deployment --chown=node:node /opt/migrate ./
USER node
CMD ["./node_modules/.bin/drizzle-kit", "migrate"]

FROM base AS web
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/Koodattu/twitch-tracker" \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
