# ---- Build stage ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

ENV VITE_DEFAULT_API_URL=__VITE_DEFAULT_API_URL_PLACEHOLDER__
ENV VITE_DOCKER_DEPLOYMENT=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=80
ENV STATIC_DIR=/app/dist
ENV DEFAULT_API_URL=https://api.openai.com/v1

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

EXPOSE 80

CMD ["node", "dist-server/index.js"]
