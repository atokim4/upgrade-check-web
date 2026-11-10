FROM node:26-alpine
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
CMD ["node", "server.js"]
