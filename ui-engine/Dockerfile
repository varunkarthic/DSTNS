FROM node:22-bookworm-slim AS build
WORKDIR /ui
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src src
COPY tests tests
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /ui
COPY --from=build /ui/dist dist
COPY server/app.mjs server/app.mjs
ENV PORT=4173
EXPOSE 4173
HEALTHCHECK --interval=5s --timeout=2s --retries=10 CMD node -e "fetch('http://127.0.0.1:4173/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","server/app.mjs"]
