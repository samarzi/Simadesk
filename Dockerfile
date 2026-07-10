# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Build args (передаются из docker-compose)
ARG VITE_API_URL
ARG VITE_API_KEY
ARG VITE_TG_BOT_USERNAME
ARG VITE_DEV_AUTH=false
ARG VITE_YANDEX_CLIENT_ID

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_API_KEY=$VITE_API_KEY
ENV VITE_TG_BOT_USERNAME=$VITE_TG_BOT_USERNAME
ENV VITE_DEV_AUTH=$VITE_DEV_AUTH
ENV VITE_YANDEX_CLIENT_ID=$VITE_YANDEX_CLIENT_ID

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# Внутренний nginx — только SPA, без SSL (SSL на внешнем gateway)
COPY nginx-internal.conf /etc/nginx/nginx.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
