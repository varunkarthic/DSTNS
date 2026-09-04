FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8443
HEALTHCHECK --interval=5s --timeout=2s --retries=10 CMD wget --no-check-certificate -qO- https://127.0.0.1:8443/health/engine >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
