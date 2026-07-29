FROM node:22-alpine

# Le processus ne tourne pas en root.
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./

USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
