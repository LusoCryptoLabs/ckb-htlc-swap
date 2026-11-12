# Order book for CKB <-> USDC swaps (testnet). Node server + the built page.
FROM node:24-alpine
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm clean-install
COPY . .
RUN npm run build && npm prune --omit=dev && mkdir -p /app/data && chown node:node /app/data
ENV PORT=8787 DATA_DIR=/app/data DIST_DIR=/srv/dist
EXPOSE 8787
USER node
CMD ["node", "server/server.mjs"]
