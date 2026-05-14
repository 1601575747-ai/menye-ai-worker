FROM node:20-slim

WORKDIR /app

COPY menye-ai-worker/package*.json ./
RUN npm install --omit=dev

COPY menye-ai-worker/ ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]

