# 主站的镜像（#94）。构建上下文是仓库根目录：
#   docker build -f apps/site/Dockerfile --build-arg VERSION=<版本号> -t seekcloud-site:<版本号> .
# 构建阶段装依赖、构建前端和服务端（dist/client、dist/server），再用 pnpm deploy 取出主站的生产依赖；
# 运行阶段只有 Node、构建产物和生产依赖，以 node 用户（uid 1000）运行，数据目录挂在 /data。

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
# 先只拷依赖清单，依赖没变时这一层用缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/site/package.json apps/site/
COPY apps/host/package.json apps/host/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile --filter "@seekcloud/site..."
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/site apps/site
# 字体只在构建前端时用（已经打进 dist/client），运行时不要，它一个就有近 90 MB
RUN pnpm --filter @seekcloud/site build \
  && pnpm --filter @seekcloud/site deploy --prod --legacy /out \
  && rm -rf /out/src /out/public /out/node_modules/@fontsource /out/node_modules/.pnpm/@fontsource+*

# 运行阶段用 Alpine：运行时的依赖都是纯 JavaScript，不挑 C 库
FROM node:${NODE_VERSION}-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.title="SeekCloud site" \
  org.opencontainers.image.source="https://github.com/bilixuesheng/SeekCloud" \
  org.opencontainers.image.licenses="AGPL-3.0-only" \
  org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
  PORT=3000 \
  SEEKCLOUD_DATA_DIR=/data \
  SEEKCLOUD_VERSION=${VERSION}
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/site/dist ./dist
COPY LICENSE NOTICE ./
# 数据目录（导出的压缩包、Agent 的会话文件）挂在 /data，属于运行主站的 node 用户
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server/main.js"]
