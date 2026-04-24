FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY bot.js ./

VOLUME /app/data

ENV TG_STORE_TOKEN=""
ENV ADMIN_IDS=""
ENV STORE_NAME="🏪 Digital Store"
ENV MIDTRANS_SERVER_KEY=""
ENV MIDTRANS_PRODUCTION="false"
ENV DATA_DIR="/app/data"

CMD ["node", "bot.js"]
