# Container image for hosts that run Node (Render, Fly.io, Railway, Cloud Run, …).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY scripts ./scripts
COPY public ./public
RUN npm run build

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
COPY --from=build /app/dist ./dist
COPY server.mjs ./server.mjs
EXPOSE 8080
# Drop to the built-in non-root user.
USER node
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
CMD ["node", "server.mjs", "--root", "dist"]
