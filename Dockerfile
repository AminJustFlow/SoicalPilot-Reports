FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY README.md ./README.md

RUN mkdir -p /app/data

EXPOSE 3100

CMD ["npm", "start"]
