FROM node:25-alpine

# Build tools required for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

WORKDIR /usr/src/app

COPY package.json .
RUN npm install

RUN mkdir -p data

COPY bot.js .

CMD ["node", "bot.js"]
