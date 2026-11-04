# One service for Render: Node builds the website, then Python serves it and the API.
FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
# The lock file was made on Windows and can miss Linux's build tools; a plain install fetches them.
RUN npm ci || npm install
COPY web/ ./
RUN npm run build

FROM python:3.13-slim
WORKDIR /app/server
COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
# Render says which port to use in PORT.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-10000}"]
