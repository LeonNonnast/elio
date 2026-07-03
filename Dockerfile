# elio landing page — tiny static server for Railway (or any container host).
# Build:  docker build -t elio-landing .
# Run:    docker run -p 8080:8080 elio-landing   ->  http://localhost:8080
FROM node:22-alpine

WORKDIR /app

# Only the landing assets are needed — no install/build step, no dependencies.
COPY landing/ ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Railway injects $PORT; server.mjs binds it (falls back to 8080 locally).
CMD ["node", "server.mjs"]
