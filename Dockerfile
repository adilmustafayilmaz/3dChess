FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js index.html ./

RUN addgroup -S chess && adduser -S chess -G chess
USER chess

EXPOSE 3131

CMD ["node", "server.js"]
