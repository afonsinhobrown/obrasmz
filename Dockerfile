FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
RUN mkdir -p /tmp/uploads && addgroup -S app && adduser -S app -G app && chown -R app:app /tmp/uploads
USER app
EXPOSE 3333
CMD ["node", "dist/index.js"]